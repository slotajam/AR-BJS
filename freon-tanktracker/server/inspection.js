// Controlled inspection workflow.
//
//   1. POST /api/inspections                      start (registered + verified phone required)
//   2. POST /api/inspections/:id/location         server confirms a fresh, accurate fix inside the site
//      POST /api/inspections/:id/location-exception   or: continue as a supervisor exception (never verified)
//   3. POST /api/inspections/:id/scan             live QR scan; refused until step 2 is valid
//      POST /api/inspections/:id/snapshot         one still frame from the live camera
//   4. POST /api/inspections/:id/submit           validates, stores a pending submission, sends a 4-digit SMS code
//   5. POST /api/inspections/:id/confirm-code     correct code -> the event is written (append-only) and applied
//      POST /api/inspections/:id/resend-code
//
// Nothing here proves the cylinder was physically present: location can be
// spoofed, a QR can be copied, and an SMS code proves possession of the
// registered phone only. Review signals and physical audits cover the rest.
const D = require('./domain');
const risk = require('./risk');

module.exports = function registerInspection(app, ctx) {
  const { db, dbm, h, fail, str, S, settings, nowIso, randomId, audit, auth, getCyl, getSite, eventView,
    sms, codes, maskPhone, upload, saveFile, sha } = ctx;
  const inspector = auth.requireRole('operator', 'supervisor', 'admin');

  function requireSms() {
    if (sms.unavailable) fail(503, 'SMS_NOT_CONFIGURED', 'SMS is not configured on this server, so events cannot be completed. Ask the administrator to configure an SMS provider.');
  }

  function requireVerifiedPhone(userId) {
    const u = db.prepare('SELECT phone_e164, phone_verified_at FROM users WHERE id = ?').get(userId);
    if (!u.phone_e164 || !u.phone_verified_at) {
      fail(403, 'PHONE_NOT_VERIFIED', 'Your mobile number is not registered and verified. Ask an administrator to register it, then verify it under "My phone".');
    }
    return u;
  }

  function getOpenSession(req) {
    const s = db.prepare('SELECT * FROM inspection_sessions WHERE id = ?').get(String(req.params.id));
    if (!s || s.user_id !== req.user.id) fail(404, 'SESSION_NOT_FOUND', 'Inspection session not found.');
    if (s.status !== 'open') fail(409, 'SESSION_CLOSED', `Inspection session is ${s.status}. Start a new inspection.`);
    if (s.expires_at <= nowIso()) {
      db.prepare("UPDATE inspection_sessions SET status = 'expired' WHERE id = ?").run(s.id);
      fail(410, 'SESSION_EXPIRED', 'Inspection session expired. Start a new inspection.');
    }
    return s;
  }

  function cylinderBrief(cyl) {
    return {
      id: cyl.id, serial: cyl.serial, gas_type: cyl.gas_type, size: cyl.size, brand_owner: cyl.brand_owner, tare_kg: cyl.tare_kg,
      movement_status: cyl.movement_status, current_site_id: cyl.current_site_id, destination_site_id: cyl.destination_site_id,
      photos: db.prepare('SELECT id, kind FROM cylinder_photos WHERE cylinder_id = ? ORDER BY id').all(cyl.id),
    };
  }

  // Checks a client fix. Fix age is measured on the phone's own clock (fix
  // time vs send time) plus the network delay seen by the server.
  function evaluateLocation(loc, receivedAt) {
    if (!loc || typeof loc !== 'object') return { ok: false, issue: 'LOCATION_MISSING', message: 'No location fix was provided.' };
    const lat = Number(loc.lat); const lng = Number(loc.lng); const acc = Number(loc.accuracy_m);
    const fixTs = Date.parse(loc.fix_timestamp); const clientNow = Date.parse(loc.client_sent_at);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !Number.isFinite(acc) || acc < 0
      || !Number.isFinite(fixTs) || !Number.isFinite(clientNow)) {
      return { ok: false, issue: 'LOCATION_INVALID', message: 'Location data is incomplete.' };
    }
    const base = { lat, lng, accuracy_m: Math.round(acc * 10) / 10, fix_timestamp: new Date(fixTs).toISOString() };
    const skewMs = receivedAt - clientNow;
    const ageMs = Math.max(0, clientNow - fixTs) + Math.max(0, Math.min(skewMs, 10000));
    base.fix_age_ms = Math.round(ageMs);
    if (Math.abs(skewMs) > S('clock_skew_tolerance_s') * 1000) base.clock_skew_s = Math.round(skewMs / 1000);
    if (ageMs > S('max_fix_age_s') * 1000) return { ...base, ok: false, issue: 'LOCATION_STALE', message: `Location fix is ${Math.round(ageMs / 1000)} s old (limit ${S('max_fix_age_s')} s). Get a fresh fix.` };
    if (acc > S('max_accuracy_m')) return { ...base, ok: false, issue: 'LOCATION_INACCURATE', message: `Reported accuracy ${Math.round(acc)} m is worse than the ${S('max_accuracy_m')} m limit.` };
    return { ...base, ok: true };
  }

  // 'confirmed' | 'exception'; anything else is refused.
  function locationGate(s) {
    if (s.loc_confirmed_until && s.loc_confirmed_until > nowIso()) return 'confirmed';
    if (s.loc_exception_reason) return 'exception';
    fail(409, 'LOCATION_NOT_CONFIRMED', 'Confirm your location first. The scanner and submission stay locked until the server confirms a fresh, accurate location inside the site.');
    return null;
  }

  function createSession(req, { mode, cylinder, auditId }) {
    const id = randomId(18);
    const now = new Date();
    const exp = new Date(now.getTime() + S('inspection_session_ttl_s') * 1000);
    db.prepare(`INSERT INTO inspection_sessions (id, user_id, mode, status, cylinder_id, scan_method, scan_cylinder_version, audit_id, created_at, expires_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`).run(id, req.user.id, mode, cylinder ? cylinder.id : null,
      cylinder ? 'manual_serial_exception' : null, cylinder ? cylinder.version : null, auditId || null, now.toISOString(), exp.toISOString());
    return { id, mode, expires_at: exp.toISOString(), audit_id: auditId || null };
  }

  function config() {
    return {
      location_lock_s: S('location_lock_s'), max_fix_age_s: S('max_fix_age_s'), max_accuracy_m: S('max_accuracy_m'),
      snapshot_required: settings().auto_snapshot_on_scan === '1',
    };
  }

  app.post('/api/inspections', inspector, h((req, res) => {
    requireSms();
    requireVerifiedPhone(req.user.id);
    let auditId = null;
    if (req.body && req.body.audit_id) {
      const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(Number(req.body.audit_id));
      if (!a || a.status !== 'open') fail(404, 'AUDIT_NOT_FOUND', 'Audit task not found or already completed.');
      if (a.assigned_to !== req.user.id) fail(403, 'AUDIT_NOT_ASSIGNED', 'This audit is assigned to someone else.');
      auditId = a.id;
    }
    const session = createSession(req, { mode: 'normal', auditId });
    audit(req, 'inspection_started', 'inspection_session', session.id, auditId ? { audit: auditId } : null);
    res.status(201).json({ session, config: config() });
  }));

  // Supervisor-controlled exception for a damaged / unreadable label: the
  // cylinder is chosen by serial instead of a QR scan. Always "Exception pending".
  app.post('/api/exceptions/damaged-label', inspector, h((req, res) => {
    requireSms();
    requireVerifiedPhone(req.user.id);
    const cyl = getCyl(str(req.body.cylinder_id, 40));
    if (!cyl) fail(404, 'NOT_FOUND', 'Cylinder not found.');
    if (cyl.movement_status === 'retired') fail(409, 'CYLINDER_RETIRED', 'This cylinder is retired.');
    const session = createSession(req, { mode: 'damaged_label', cylinder: cyl });
    audit(req, 'damaged_label_exception_started', 'cylinder', cyl.id, { session: session.id });
    res.status(201).json({ session, cylinder: cylinderBrief(cyl), config: config() });
  }));

  app.post('/api/inspections/:id/cancel', auth.requireAuth, h((req, res) => {
    const s = getOpenSession(req);
    db.prepare("UPDATE inspection_sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
    db.prepare("UPDATE pending_submissions SET status = 'expired', closed_at = ? WHERE session_id = ? AND status = 'awaiting'").run(nowIso(), s.id);
    res.json({ ok: true });
  }));

  // Step 2: the server confirms the location. Re-called to refresh it.
  app.post('/api/inspections/:id/location', inspector, h((req, res) => {
    const s = getOpenSession(req);
    const site = getSite(req.body.site_id);
    if (!site || !site.active) fail(422, 'SITE_REQUIRED', 'Select the site where you are.');
    const loc = evaluateLocation(req.body.location, Date.now());
    if (!loc.ok) {
      db.prepare('UPDATE inspection_sessions SET loc_issue = ?, loc_confirmed_until = NULL WHERE id = ?').run(loc.issue, s.id);
      fail(422, loc.issue, loc.message, { exception_allowed: true });
    }
    const geo = D.checkGeofence(site, loc.lat, loc.lng, loc.accuracy_m);
    if (geo.result !== 'inside') {
      db.prepare('UPDATE inspection_sessions SET loc_issue = ?, loc_confirmed_until = NULL WHERE id = ?').run(geo.result, s.id);
      const msg = {
        outside: `You are about ${geo.distance} m from the centre of ${site.name}, outside its area. Check the selected site or move closer.`,
        boundary_uncertain: `Your position is too close to the edge of ${site.name} to be sure (accuracy ±${Math.round(loc.accuracy_m)} m). Move further inside or wait for better accuracy.`,
        no_geofence: `${site.name} has no geofence configured, so the location cannot be confirmed. Ask an administrator.`,
      }[geo.result];
      fail(422, geo.result === 'outside' ? 'OUTSIDE_SITE' : geo.result === 'no_geofence' ? 'NO_GEOFENCE' : 'BOUNDARY_UNCERTAIN', msg,
        { exception_allowed: true, distance_m: geo.distance });
    }
    const now = new Date();
    const until = new Date(now.getTime() + S('location_lock_s') * 1000).toISOString();
    db.prepare(`UPDATE inspection_sessions SET site_id = ?, loc_lat = ?, loc_lng = ?, loc_accuracy_m = ?, loc_fix_timestamp = ?, loc_fix_age_ms = ?,
      loc_geofence = ?, loc_distance_m = ?, loc_confirmed_at = ?, loc_confirmed_until = ?, loc_exception_reason = NULL, loc_issue = NULL WHERE id = ?`)
      .run(site.id, loc.lat, loc.lng, loc.accuracy_m, loc.fix_timestamp, loc.fix_age_ms, geo.result, geo.distance, now.toISOString(), until, s.id);
    res.json({ confirmed_until: until, site_id: site.id, geofence: geo.result, distance_m: geo.distance, accuracy_m: loc.accuracy_m, fix_age_ms: loc.fix_age_ms, clock_skew_s: loc.clock_skew_s || null });
  }));

  app.post('/api/inspections/:id/location-exception', inspector, h((req, res) => {
    const s = getOpenSession(req);
    const site = getSite(req.body.site_id);
    if (!site || !site.active) fail(422, 'SITE_REQUIRED', 'Select the site where you are.');
    const reason = str(req.body.reason, 500);
    if (reason.length < 5) fail(422, 'EXCEPTION_REASON_REQUIRED', 'Explain why the location could not be confirmed.');
    const loc = req.body.location ? evaluateLocation(req.body.location, Date.now()) : null;
    const hasCoords = loc && loc.lat != null;
    const geo = hasCoords ? D.checkGeofence(site, loc.lat, loc.lng, loc.accuracy_m) : { result: 'not_checked', distance: null };
    db.prepare(`UPDATE inspection_sessions SET site_id = ?, loc_lat = ?, loc_lng = ?, loc_accuracy_m = ?, loc_fix_timestamp = ?, loc_fix_age_ms = ?,
      loc_geofence = ?, loc_distance_m = ?, loc_confirmed_at = NULL, loc_confirmed_until = NULL, loc_exception_reason = ?, loc_issue = ? WHERE id = ?`)
      .run(site.id, hasCoords ? loc.lat : null, hasCoords ? loc.lng : null, hasCoords ? loc.accuracy_m : null, hasCoords ? loc.fix_timestamp : null,
        hasCoords ? loc.fix_age_ms : null, geo.result, geo.distance, reason, (loc && loc.issue) || s.loc_issue || 'LOCATION_MISSING', s.id);
    audit(req, 'location_exception', 'inspection_session', s.id, { reason });
    res.json({ exception: true });
  }));

  // Step 3: live QR scan. Refused until the location is confirmed (or excepted).
  app.post('/api/inspections/:id/scan', inspector, h((req, res) => {
    const s = getOpenSession(req);
    if (s.mode !== 'normal') fail(409, 'WRONG_MODE', 'This session does not use QR scanning.');
    locationGate(s);
    if (req.body.scan_method !== 'live_camera') fail(422, 'LIVE_SCAN_REQUIRED', 'The QR must be scanned with the in-app live camera.');
    const m = str(req.body.qr_text, 500).match(/\/c\/([A-Za-z0-9_-]{20,64})\/?$/);
    if (!m) fail(422, 'QR_NOT_TANKTRACKER', 'This QR code is not a TankTracker cylinder label.');
    const qr = db.prepare('SELECT * FROM qr_codes WHERE token = ?').get(m[1]);
    if (!qr) fail(404, 'QR_UNKNOWN', 'This QR code is not recognised.');
    if (qr.status !== 'active') {
      audit(req, 'revoked_qr_scanned', 'qr', qr.token.slice(0, 6), { cylinder: qr.cylinder_id });
      fail(410, 'QR_REVOKED', 'This label has been revoked or replaced. Do not use it. Report to a supervisor.');
    }
    const cyl = getCyl(qr.cylinder_id);
    if (cyl.movement_status === 'retired') fail(409, 'CYLINDER_RETIRED', 'This cylinder is retired.');
    if (s.audit_id) {
      const a = db.prepare('SELECT cylinder_id FROM audits WHERE id = ?').get(s.audit_id);
      if (a.cylinder_id !== cyl.id) fail(409, 'AUDIT_WRONG_CYLINDER', 'This is not the cylinder selected for audit.');
    }
    // How far the phone moved between location confirmation and the scan.
    let far = null;
    const now = req.body.location ? evaluateLocation(req.body.location, Date.now()) : null;
    if (now && now.lat != null && s.loc_lat != null) {
      const d = D.haversineM(s.loc_lat, s.loc_lng, now.lat, now.lng);
      if (d > Math.max(2 * (s.loc_accuracy_m || 0), 2 * now.accuracy_m, 30)) far = Math.round(d);
    }
    db.prepare("UPDATE inspection_sessions SET cylinder_id = ?, qr_token = ?, scan_method = 'live_camera', scan_cylinder_version = ?, scan_far_m = ? WHERE id = ?")
      .run(cyl.id, qr.token, cyl.version, far, s.id);
    audit(req, 'qr_scanned', 'cylinder', cyl.id, { session: s.id });
    res.json({ cylinder: cylinderBrief(cyl), snapshot_required: settings().auto_snapshot_on_scan === '1' });
  }));

  // One still image grabbed from the live camera frame at the moment of the scan.
  app.post('/api/inspections/:id/snapshot', inspector, upload.single('snapshot'), h((req, res) => {
    const s = getOpenSession(req);
    if (!s.cylinder_id) fail(409, 'NO_CYLINDER', 'Scan the cylinder first.');
    if (req.body.capture_source !== 'live_camera_frame') fail(422, 'LIVE_CAPTURE_REQUIRED', 'The snapshot must come from the live camera frame. Gallery images are not accepted.');
    const f = req.file;
    if (!f || !/^image\/(jpeg|webp|png)$/.test(f.mimetype)) fail(422, 'IMAGE_REQUIRED', 'Snapshot must be a JPEG, WebP or PNG image.');
    if (f.size > 400 * 1024) fail(413, 'SNAPSHOT_TOO_LARGE', 'Snapshot must be 400 KB or smaller.');
    if (db.prepare('SELECT 1 FROM snapshots WHERE session_id = ?').get(s.id)) fail(409, 'SNAPSHOT_EXISTS', 'A snapshot was already saved for this inspection.');
    const id = randomId(12);
    const ext = f.mimetype === 'image/png' ? '.png' : f.mimetype === 'image/webp' ? '.webp' : '.jpg';
    db.prepare('INSERT INTO snapshots (id, session_id, user_id, cylinder_id, file, mime, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.id, req.user.id, s.cylinder_id, saveFile('snapshots', f.buffer, ext), f.mimetype, f.size, sha(f.buffer), nowIso());
    res.status(201).json({ snapshot: { id } });
  }));

  function pendingView(p) {
    const cooldown = S('sms_resend_cooldown_s') * 1000;
    return {
      id: p.id, recipient: p.recipient, phone_masked: maskPhone(p.phone_e164), expires_at: p.expires_at, status: p.status,
      attempts_left: Math.max(0, S('sms_code_max_attempts') - p.attempts), resends_left: Math.max(0, S('sms_resend_max') - p.resends),
      resend_available_at: new Date(Date.parse(p.last_sent_at) + cooldown).toISOString(),
    };
  }

  function smsText(code, serial) {
    const mins = Math.round(S('sms_code_ttl_s') / 60);
    return `TankTracker code ${code} for cylinder ${serial}. Valid ${mins} min. Do not share. / รหัส ${code} ถัง ${serial} ใช้ได้ ${mins} นาที ห้ามบอกผู้อื่น`;
  }

  async function sendCode(req, p, code, serial) {
    try {
      const r = await sms.send(p.phone_e164, smsText(code, serial));
      audit(req, 'sms_code_sent', 'pending_submission', p.id, { to: maskPhone(p.phone_e164), provider: sms.name, provider_id: r.id, recipient: p.recipient });
    } catch (e) {
      db.prepare("UPDATE pending_submissions SET status = 'send_failed', closed_at = ? WHERE id = ?").run(nowIso(), p.id);
      audit(req, 'sms_send_failed', 'pending_submission', p.id, { provider: sms.name, error: String(e.message).slice(0, 200) });
      fail(502, e.code || 'SMS_SEND_FAILED', 'The SMS code could not be sent. Check the signal and try again.');
    }
  }

  // Step 4: validate and send the SMS code. The event is not written yet.
  app.post('/api/inspections/:id/submit', inspector, h(async (req, res) => {
    requireSms();
    sweepPending();
    const key = str(req.get('Idempotency-Key'), 100);
    if (key.length < 8) fail(422, 'IDEMPOTENCY_KEY', 'Missing Idempotency-Key header.');
    const prior = db.prepare('SELECT * FROM pending_submissions WHERE idempotency_key = ?').get(key);
    if (prior) {
      if (prior.user_id !== req.user.id) fail(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key already used.');
      return res.json({ pending: pendingView(prior), replayed: true });
    }
    const s = getOpenSession(req);
    if (!s.cylinder_id) fail(409, 'NO_CYLINDER', 'Scan the cylinder first.');
    const gate = locationGate(s);
    const open = db.prepare("SELECT * FROM pending_submissions WHERE session_id = ? AND status = 'awaiting'").get(s.id);
    if (open) return res.json({ pending: pendingView(open), replayed: true });
    const user = requireVerifiedPhone(req.user.id);
    const b = req.body || {};
    const st = settings();
    const cyl = getCyl(s.cylinder_id);
    const site = getSite(s.site_id);
    if (!site) fail(422, 'SITE_REQUIRED', 'Confirm the site first.');

    if (s.mode === 'normal') {
      const qr = db.prepare('SELECT status FROM qr_codes WHERE token = ?').get(s.qr_token);
      if (!qr || qr.status !== 'active') fail(410, 'QR_REVOKED', 'The scanned label is no longer active.');
      if (st.auto_snapshot_on_scan === '1' && !db.prepare('SELECT 1 FROM snapshots WHERE session_id = ?').get(s.id)) {
        fail(422, 'SNAPSHOT_REQUIRED', 'The scan photo is missing. Scan the QR again.');
      }
    }
    const eventType = str(b.event_type, 40);
    if (!D.INSPECTION_EVENT_TYPES.includes(eventType)) fail(422, 'EVENT_TYPE', 'Select a valid event type.');
    if (s.audit_id && eventType !== 'inspection') fail(422, 'AUDIT_EVENT_TYPE', 'An audit is recorded as an inspection.');
    const destination = b.destination_site_id ? getSite(b.destination_site_id) : null;
    if (b.destination_site_id && (!destination || !destination.active)) fail(422, 'DESTINATION_INVALID', 'Destination site not found.');
    const checklist = b.checklist || {};
    const required = s.mode === 'damaged_label' ? D.CHECKLIST_KEYS.filter((k) => k !== 'qr_attached') : D.CHECKLIST_KEYS;
    const missing = required.filter((k) => checklist[k] !== true);
    if (missing.length) fail(422, 'CHECKLIST_INCOMPLETE', 'Confirm every checklist item.', { missing });
    const condition = str(b.condition, 30);
    if (!D.CONDITIONS.includes(condition)) fail(422, 'CONDITION_REQUIRED', 'Select the cylinder condition.');
    const comments = str(b.comments, 2000);
    if ((condition !== 'good' || s.mode === 'damaged_label') && comments.length < 5) fail(422, 'COMMENTS_REQUIRED', 'Describe the problem in the comments.');
    let auditOutcome = null;
    if (s.audit_id) {
      auditOutcome = str(b.audit_outcome, 20);
      if (!['found_ok', 'found_mismatch'].includes(auditOutcome)) fail(422, 'AUDIT_OUTCOME_REQUIRED', 'Select the audit outcome.');
      if (auditOutcome === 'found_mismatch' && comments.length < 5) fail(422, 'COMMENTS_REQUIRED', 'Describe what does not match.');
    }
    // Weighing at warehouse sites (entered by the person at the scale).
    const weighed = ['dispatched', 'empty_returned', 'warehouse_received'].includes(eventType) && site.kind === 'warehouse';
    let gross = b.gross_weight_kg === '' || b.gross_weight_kg == null ? null : Number(b.gross_weight_kg);
    if (gross != null && (!Number.isFinite(gross) || gross <= 0 || gross > 1000)) fail(422, 'WEIGHT_INVALID', 'Enter the gross weight in kg.');
    if (weighed && st.require_weight_at_warehouse === '1' && gross == null) fail(422, 'WEIGHT_REQUIRED', 'Weigh the cylinder and enter the gross weight.');
    if (gross != null) gross = Math.round(gross * 100) / 100;
    D.applyMovement(eventType, cyl, site, destination); // validate now; applied again on confirmation

    // Who receives the code.
    let recipient = 'operator';
    let phone = user.phone_e164;
    if (eventType === 'customer_received' && st.customer_receipt_code_to_site_contact === '1' && site.contact_phone_e164 && site.contact_phone_verified_at) {
      recipient = 'site_contact';
      phone = site.contact_phone_e164;
    }
    const payload = {
      event_type: eventType, site_id: site.id, bay: str(b.bay, 60), destination_site_id: destination ? destination.id : null,
      delivery_ref: str(b.delivery_ref, 80) || null, responsible_person: str(b.responsible_person, 120) || req.user.display_name,
      expected_return_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.expected_return_date || '')) ? b.expected_return_date : null,
      condition, comments: comments || null, checklist: Object.fromEntries(D.CHECKLIST_KEYS.map((k) => [k, checklist[k] === true])),
      gross_weight_kg: gross, scale_id: str(b.scale_id, 40) || null, audit_outcome: auditOutcome,
      location_gate: gate, snapshot_id: (db.prepare('SELECT id FROM snapshots WHERE session_id = ?').get(s.id) || {}).id || null,
    };
    const now = new Date();
    const id = randomId(12);
    const code = codes.newCode();
    const p = {
      id, session_id: s.id, user_id: req.user.id, cylinder_id: cyl.id, payload_json: JSON.stringify(payload), recipient, phone_e164: phone,
      code_hash: codes.hash(code, id), first_sent_at: now.toISOString(), last_sent_at: now.toISOString(),
      expires_at: new Date(now.getTime() + S('sms_code_ttl_s') * 1000).toISOString(), idempotency_key: key, created_at: now.toISOString(),
    };
    db.prepare(`INSERT INTO pending_submissions (id, session_id, user_id, cylinder_id, payload_json, recipient, phone_e164, code_hash, first_sent_at,
      last_sent_at, expires_at, status, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?, ?)`)
      .run(p.id, p.session_id, p.user_id, p.cylinder_id, p.payload_json, p.recipient, p.phone_e164, p.code_hash, p.first_sent_at,
        p.last_sent_at, p.expires_at, p.idempotency_key, p.created_at);
    await sendCode(req, p, code, cyl.serial);
    res.status(201).json({ pending: pendingView({ ...p, attempts: 0, resends: 0, status: 'awaiting' }) });
  }));

  app.post('/api/inspections/:id/resend-code', inspector, h(async (req, res) => {
    sweepPending();
    const s = getOpenSession(req);
    const p = db.prepare("SELECT * FROM pending_submissions WHERE session_id = ? AND status = 'awaiting'").get(s.id);
    if (!p) fail(409, 'NO_PENDING_CODE', 'There is no code waiting. Submit again.');
    if (p.resends >= S('sms_resend_max')) fail(429, 'RESEND_LIMIT', 'No more resends allowed. Cancel and start a new inspection.');
    const wait = Date.parse(p.last_sent_at) + S('sms_resend_cooldown_s') * 1000 - Date.now();
    if (wait > 0) fail(429, 'RESEND_COOLDOWN', `Wait ${Math.ceil(wait / 1000)} s before resending.`);
    const code = codes.newCode();
    const now = new Date();
    const upd = { code_hash: codes.hash(code, p.id), last_sent_at: now.toISOString(), expires_at: new Date(now.getTime() + S('sms_code_ttl_s') * 1000).toISOString() };
    db.prepare('UPDATE pending_submissions SET code_hash = ?, last_sent_at = ?, expires_at = ?, resends = resends + 1 WHERE id = ?')
      .run(upd.code_hash, upd.last_sent_at, upd.expires_at, p.id);
    const fresh = db.prepare('SELECT * FROM pending_submissions WHERE id = ?').get(p.id);
    await sendCode(req, fresh, code, getCyl(p.cylinder_id).serial);
    res.json({ pending: pendingView(fresh) });
  }));

  // Step 5: confirm the code -> write and apply the event atomically.
  app.post('/api/inspections/:id/confirm-code', inspector, h((req, res) => {
    sweepPending();
    const sid = String(req.params.id);
    const session = db.prepare('SELECT * FROM inspection_sessions WHERE id = ?').get(sid);
    if (!session || session.user_id !== req.user.id) fail(404, 'SESSION_NOT_FOUND', 'Inspection session not found.');
    const done = db.prepare("SELECT * FROM pending_submissions WHERE session_id = ? AND status = 'confirmed'").get(sid);
    if (done) return res.json({ event: eventView(db.prepare('SELECT * FROM events WHERE id = ?').get(done.event_id), { full: true }), replayed: true });
    const p = db.prepare("SELECT * FROM pending_submissions WHERE session_id = ? AND status IN ('awaiting','expired','burned') ORDER BY created_at DESC LIMIT 1").get(sid);
    if (!p) fail(409, 'NO_PENDING_CODE', 'There is no code waiting. Submit again.');
    if (p.status === 'expired') fail(410, 'CODE_EXPIRED', 'The code expired. The event was not saved. Start a new inspection.');
    if (p.status === 'burned') fail(403, 'CODE_BURNED', 'Too many wrong codes. The event was not saved and the attempt was flagged.');
    const code = str(req.body.code, 10);
    if (!/^\d{4}$/.test(code)) fail(422, 'CODE_FORMAT', 'Enter the 4-digit code.');
    if (!codes.equal(codes.hash(code, p.id), p.code_hash)) {
      const attempts = p.attempts + 1;
      const max = S('sms_code_max_attempts');
      if (attempts >= max) {
        db.prepare("UPDATE pending_submissions SET attempts = ?, failed_attempts_total = failed_attempts_total + 1, status = 'burned', closed_at = ? WHERE id = ?").run(attempts, nowIso(), p.id);
        audit(req, 'sms_code_burned', 'cylinder', p.cylinder_id, { pending: p.id, attempts });
        fail(403, 'CODE_BURNED', 'Too many wrong codes. The code is cancelled, the event was not saved and the attempt is flagged for the supervisor.');
      }
      db.prepare('UPDATE pending_submissions SET attempts = ?, failed_attempts_total = failed_attempts_total + 1 WHERE id = ?').run(attempts, p.id);
      fail(422, 'CODE_WRONG', `Wrong code. ${max - attempts} tries left.`, { attempts_left: max - attempts });
    }
    const ev = dbm.tx(db, () => applyPending(req, p));
    res.status(201).json({ event: eventView(ev, { full: true }) });
  }));

  function applyPending(req, p) {
    const s = db.prepare('SELECT * FROM inspection_sessions WHERE id = ?').get(p.session_id);
    if (s.status !== 'open') fail(409, 'SESSION_CLOSED', 'Inspection session is closed. Start a new inspection.');
    const payload = JSON.parse(p.payload_json);
    const cyl = getCyl(p.cylinder_id);
    if (cyl.version !== s.scan_cylinder_version) {
      db.prepare("UPDATE pending_submissions SET status = 'expired', closed_at = ? WHERE id = ?").run(nowIso(), p.id);
      fail(409, 'CONCURRENT_UPDATE', 'Another event was recorded for this cylinder after you scanned it. Start a new inspection to see its current state.');
    }
    if (s.mode === 'normal') {
      const qr = db.prepare('SELECT status FROM qr_codes WHERE token = ?').get(s.qr_token);
      if (!qr || qr.status !== 'active') fail(410, 'QR_REVOKED', 'The scanned label is no longer active.');
    }
    const site = getSite(payload.site_id);
    const destination = payload.destination_site_id ? getSite(payload.destination_site_id) : null;
    const movement = D.applyMovement(payload.event_type, cyl, site, destination);
    const isException = s.mode === 'damaged_label' || payload.location_gate === 'exception';
    const hasCoords = s.loc_lat != null;
    const confirmedAt = nowIso();
    const user = db.prepare('SELECT phone_changed_at FROM users WHERE id = ?').get(p.user_id);
    const ev = {
      cylinder_id: cyl.id, event_type: payload.event_type, movement_status_after: movement, user_id: p.user_id,
      responsible_person: payload.responsible_person, site_id: site.id, bay: payload.bay, destination_site_id: payload.destination_site_id,
      delivery_ref: payload.delivery_ref, expected_return_date: payload.expected_return_date, condition: payload.condition,
      comments: payload.comments, checklist_json: JSON.stringify(payload.checklist),
      lat: hasCoords ? s.loc_lat : null, lng: hasCoords ? s.loc_lng : null, accuracy_m: s.loc_accuracy_m, fix_timestamp: s.loc_fix_timestamp,
      fix_age_ms: s.loc_fix_age_ms, location_status: payload.location_gate === 'confirmed' ? 'verified' : 'not_verified',
      location_issue: payload.location_gate === 'confirmed' ? null : (s.loc_issue || 'LOCATION_NOT_CONFIRMED'),
      geofence_result: s.loc_geofence || 'not_checked', geofence_distance_m: s.loc_distance_m, qr_token: s.qr_token,
      qr_verified: s.mode === 'normal' ? 1 : 0, nfc_status: 'not_used', session_id: s.id,
      is_exception: isException ? 1 : 0,
      exception_kind: s.mode === 'damaged_label' ? 'damaged_label' : (payload.location_gate === 'exception' ? 'location_unverified' : null),
      exception_reason: isException ? (s.loc_exception_reason || payload.comments) : null,
      idempotency_key: p.idempotency_key, server_received_at: confirmedAt,
      gross_weight_kg: payload.gross_weight_kg, net_content_kg: payload.gross_weight_kg != null ? Math.round((payload.gross_weight_kg - cyl.tare_kg) * 100) / 100 : null,
      scale_id: payload.scale_id, weight_entered_by: payload.gross_weight_kg != null ? p.user_id : null, snapshot_id: payload.snapshot_id,
      sms_verified_at: confirmedAt, sms_recipient: p.recipient, sms_phone_masked: maskPhone(p.phone_e164),
      audit_id: s.audit_id, audit_outcome: payload.audit_outcome,
    };
    const st = settings();
    const flags = D.computeFlags(db, st, { cyl, ev, site });
    flags.push(...risk.weightFlags(db, st, { cyl, ev }));
    flags.push(...risk.pairFlags(db, st, { ev }));
    if (s.scan_far_m) flags.push(['scan_far_from_confirmed_fix', `Phone moved about ${s.scan_far_m} m between location confirmation and the QR scan.`]);
    if (p.failed_attempts_total > 0) flags.push(['sms_code_failed_attempts', `${p.failed_attempts_total} wrong code entr${p.failed_attempts_total === 1 ? 'y' : 'ies'} before the correct one.`]);
    const tookS = (Date.parse(confirmedAt) - Date.parse(p.first_sent_at)) / 1000;
    if (tookS > S('sms_confirmed_slowly_s')) flags.push(['sms_confirmed_slowly', `Code confirmed ${Math.round(tookS)} s after it was first sent.`]);
    if (p.recipient === 'site_contact' && (Date.parse(confirmedAt) - Date.parse(p.last_sent_at)) < 10000) {
      flags.push(['customer_code_entered_very_fast', 'Customer code was entered within 10 s of sending. Check that the customer really received it.']);
    }
    if (payload.event_type === 'customer_received' && p.recipient !== 'site_contact') {
      flags.push(['no_customer_confirmation', 'Receipt confirmed with the operator\'s code, not by the customer\'s registered phone.']);
    }
    if (user.phone_changed_at && Date.now() - Date.parse(user.phone_changed_at) < S('phone_changed_recent_days') * 86400000) {
      flags.push(['phone_changed_recently', `Operator's registered phone changed on ${user.phone_changed_at.slice(0, 10)}.`]);
    }
    if (payload.audit_outcome === 'found_mismatch') flags.push(['audit_mismatch', 'Auditor found the cylinder but something did not match.']);
    let initial;
    if (isException) initial = 'exception_pending';
    else if (flags.length || st.auto_accept_clean_events !== '1') initial = 'evidence_pending';
    else initial = 'recorded';
    ev.initial_verification = initial;

    const cols = ['cylinder_id', 'event_type', 'movement_status_after', 'user_id', 'responsible_person', 'site_id', 'bay',
      'destination_site_id', 'delivery_ref', 'expected_return_date', 'condition', 'comments', 'checklist_json', 'lat', 'lng',
      'accuracy_m', 'fix_timestamp', 'fix_age_ms', 'location_status', 'location_issue', 'geofence_result', 'geofence_distance_m',
      'qr_token', 'qr_verified', 'nfc_status', 'session_id', 'initial_verification', 'is_exception',
      'exception_kind', 'exception_reason', 'idempotency_key', 'server_received_at', 'gross_weight_kg', 'net_content_kg', 'scale_id',
      'weight_entered_by', 'snapshot_id', 'sms_verified_at', 'sms_recipient', 'sms_phone_masked', 'audit_id', 'audit_outcome'];
    const info = db.prepare(`INSERT INTO events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => ev[c] ?? null));
    const eventId = Number(info.lastInsertRowid);
    const insFlag = db.prepare('INSERT INTO flags (event_id, flag_type, detail, created_at) VALUES (?, ?, ?, ?)');
    for (const [t, d] of flags) insFlag.run(eventId, t, d, confirmedAt);
    db.prepare("UPDATE pending_submissions SET status = 'confirmed', event_id = ?, closed_at = ? WHERE id = ?").run(eventId, confirmedAt, p.id);
    db.prepare("UPDATE inspection_sessions SET status = 'submitted' WHERE id = ?").run(s.id);
    if (s.audit_id) {
      db.prepare("UPDATE audits SET status = 'done', outcome = ?, outcome_event_id = ?, comments = ?, completed_by = ?, completed_at = ? WHERE id = ?")
        .run(payload.audit_outcome, eventId, payload.comments, p.user_id, confirmedAt, s.audit_id);
    }
    D.recomputeCylinder(db, cyl.id, { bumpVersion: true });
    audit(req, 'event_submitted', 'event', eventId, { cylinder: cyl.id, type: payload.event_type, verification: initial, sms_recipient: p.recipient });
    return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  }

  // Secure NFC: integration point only (see server/nfc.js). Never simulated.
  app.post('/api/inspections/:id/nfc', inspector, h((req, res) => {
    getOpenSession(req);
    const r = ctx.nfc.verifySunMessage({ message: req.body.message });
    res.status(501).json({ error: 'NFC_NOT_CONFIGURED', message: r.reason });
  }));

  // Closes codes that were never confirmed. Leaves the cylinder unchanged.
  function sweepPending() {
    const now = nowIso();
    const rows = db.prepare("SELECT id, cylinder_id, user_id FROM pending_submissions WHERE status = 'awaiting' AND expires_at <= ?").all(now);
    for (const r of rows) {
      db.prepare("UPDATE pending_submissions SET status = 'expired', closed_at = ? WHERE id = ?").run(now, r.id);
      db.prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at) VALUES (?, 'sms_unconfirmed', 'cylinder', ?, ?, ?)")
        .run(r.user_id, r.cylinder_id, JSON.stringify({ pending: r.id }), now);
    }
    return rows.length;
  }
  ctx.sweepPending = sweepPending;

  // Missing report: the cylinder cannot be scanned, so no location is verified.
  app.post('/api/cylinders/:id/missing', inspector, h((req, res) => {
    const key = str(req.get('Idempotency-Key'), 100);
    if (key.length < 8) fail(422, 'IDEMPOTENCY_KEY', 'Missing Idempotency-Key header.');
    const prior = db.prepare('SELECT * FROM events WHERE idempotency_key = ?').get(key);
    if (prior) return res.json({ event: eventView(prior), replayed: true });
    const comments = str(req.body.comments, 2000);
    if (comments.length < 5) fail(422, 'COMMENTS_REQUIRED', 'Describe where the cylinder was expected and what was checked.');
    const ev = dbm.tx(db, () => ctx.recordMissing(req, getCyl(req.params.id), comments, key, req.body.site_id));
    res.status(201).json({ event: eventView(ev) });
  }));

  ctx.recordMissing = (req, cyl, comments, key, siteId, extraFlags = []) => {
    if (!cyl) fail(404, 'NOT_FOUND', 'Cylinder not found.');
    if (['retired', 'missing'].includes(cyl.movement_status)) fail(409, 'INVALID_STATE', `Cylinder is already ${cyl.movement_status}.`);
    const site = getSite(siteId) || getSite(cyl.current_site_id);
    const t = nowIso();
    const info = db.prepare(`INSERT INTO events (cylinder_id, event_type, movement_status_after, user_id, responsible_person, site_id, comments,
      location_status, geofence_result, initial_verification, is_exception, exception_kind, exception_reason, idempotency_key, server_received_at)
      VALUES (?, 'missing_reported', 'missing', ?, ?, ?, ?, 'not_applicable', 'not_checked', 'exception_pending', 1, 'missing_reported', ?, ?, ?)`)
      .run(cyl.id, req.user.id, req.user.display_name, site ? site.id : null, comments, comments, key || null, t);
    const id = Number(info.lastInsertRowid);
    const insFlag = db.prepare('INSERT INTO flags (event_id, flag_type, detail, created_at) VALUES (?, ?, ?, ?)');
    insFlag.run(id, 'exception', 'missing_reported', t);
    for (const [ft, d] of extraFlags) insFlag.run(id, ft, d, t);
    D.recomputeCylinder(db, cyl.id, { bumpVersion: true });
    audit(req, 'missing_reported', 'event', id, { cylinder: cyl.id });
    return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  };
};
