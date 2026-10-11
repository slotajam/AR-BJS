// Freon TankTracker HTTP application.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const dbm = require('./db');
const auth = require('./auth');
const nfc = require('./nfc');
const D = require('./domain');
const risk = require('./risk');
const smsLib = require('./sms');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const REJECT_REASONS = ['screen_or_photo_suspected', 'snapshot_not_cylinder', 'serial_not_visible', 'wrong_cylinder',
  'location_implausible', 'weight_mismatch', 'custody_doubt', 'other'];

function createApp({ dataDir, publicBaseUrl, tileUrl, env = process.env } = {}) {
  const db = dbm.open(dataDir);
  const sms = smsLib.createSms(env);
  const codes = smsLib.codeHasher(smsLib.loadSecret(dataDir));
  const { maskPhone, normalizePhone } = smsLib;
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');

  const tileHost = (() => { try { return new URL((tileUrl || '').replace(/\{s\}/, 'a')).host; } catch { return ''; } })();
  const tileHostSrc = tileHost ? ` https://${tileHost.replace(/^a\./, '*.')}` : '';
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob:${tileHostSrc}`, "media-src 'self' blob:", "connect-src 'self'",
      "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"].join('; '));
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '200kb' }));
  app.use(auth.loadUser(db));
  app.use('/api', auth.requireCsrfHeader);

  const nowIso = () => new Date().toISOString();
  const settings = () => dbm.getSettings(db);
  const S = (k) => dbm.num(settings(), k);
  const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
  const baseUrl = (req) => (publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  function audit(req, action, entity, entityId, detail) {
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user ? req.user.id : null, action, entity || null, entityId == null ? null : String(entityId),
        detail ? JSON.stringify(detail) : null, req.ip || null, nowIso());
  }

  // Wraps a handler so RuleErrors become JSON responses.
  const h = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof D.RuleError) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.extra || {}) });
      if (String(e.message).includes('UNIQUE constraint failed: cylinders.serial')) {
        return res.status(409).json({ error: 'DUPLICATE_SERIAL', message: 'A cylinder with this engraved serial number is already registered.' });
      }
      console.error(e);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
    }
  };
  const fail = (status, code, message, extra) => { throw new D.RuleError(status, code, message, extra); };
  const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 4 } });

  function saveFile(subdir, buf, ext) {
    const name = `${randomId(18)}${ext}`;
    fs.writeFileSync(path.join(dataDir, subdir, name), buf);
    return name;
  }
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  // ---------- helpers ----------
  const getSite = (id) => (id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(id)) : null);
  const getCyl = (id) => db.prepare('SELECT * FROM cylinders WHERE id = ?').get(String(id));
  const userName = (id) => (id ? (db.prepare('SELECT display_name FROM users WHERE id = ?').get(id) || {}).display_name : null);

  function eventView(ev, { full = false } = {}) {
    if (!ev) return null;
    const site = getSite(ev.site_id);
    const dest = getSite(ev.destination_site_id);
    const flags = db.prepare('SELECT flag_type, detail FROM flags WHERE event_id = ? ORDER BY id').all(ev.id);
    const correction = db.prepare("SELECT id FROM events WHERE corrects_event_id = ? ORDER BY id DESC LIMIT 1").get(ev.id);
    const v = {
      id: ev.id, cylinder_id: ev.cylinder_id, event_type: ev.event_type, movement_status_after: ev.movement_status_after,
      recorded_by: userName(ev.user_id), recorded_by_id: ev.user_id, responsible_person: ev.responsible_person,
      site: site ? { id: site.id, name: site.name, kind: site.kind, customer_name: site.customer_name } : null,
      destination: dest ? { id: dest.id, name: dest.name } : null, bay: ev.bay, delivery_ref: ev.delivery_ref,
      expected_return_date: ev.expected_return_date, condition: ev.condition, comments: ev.comments,
      lat: ev.lat, lng: ev.lng, accuracy_m: ev.accuracy_m, fix_timestamp: ev.fix_timestamp, fix_age_ms: ev.fix_age_ms,
      location_status: ev.location_status, location_issue: ev.location_issue,
      geofence_result: ev.geofence_result, geofence_distance_m: ev.geofence_distance_m,
      qr_verified: !!ev.qr_verified, nfc_status: ev.nfc_status,
      verification_status: D.effectiveVerification(db, ev), initial_verification: ev.initial_verification,
      is_exception: !!ev.is_exception, exception_kind: ev.exception_kind, exception_reason: ev.exception_reason,
      corrects_event_id: ev.corrects_event_id, corrected_by_event_id: correction ? correction.id : null,
      server_received_at: ev.server_received_at, flags,
      gross_weight_kg: ev.gross_weight_kg, net_content_kg: ev.net_content_kg, scale_id: ev.scale_id, snapshot_id: ev.snapshot_id,
      sms_verified_at: ev.sms_verified_at, sms_recipient: ev.sms_recipient, sms_phone_masked: ev.sms_phone_masked,
      audit_id: ev.audit_id, audit_outcome: ev.audit_outcome,
    };
    if (full) {
      v.checklist = ev.checklist_json ? JSON.parse(ev.checklist_json) : null;
      v.reviews = db.prepare(`SELECT r.id, r.decision, r.reason_code, r.notes, r.created_at, u.display_name AS reviewer
        FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.event_id = ? ORDER BY r.id`).all(ev.id);
      if (ev.session_id) {
        const ses = db.prepare('SELECT loc_confirmed_at, loc_exception_reason, scan_far_m, created_at FROM inspection_sessions WHERE id = ?').get(ev.session_id);
        const pend = db.prepare("SELECT first_sent_at, last_sent_at, resends, failed_attempts_total FROM pending_submissions WHERE event_id = ?").get(ev.id);
        v.timeline_detail = {
          session_started_at: ses && ses.created_at, location_confirmed_at: ses && ses.loc_confirmed_at,
          location_exception_reason: ses && ses.loc_exception_reason, scan_far_m: ses && ses.scan_far_m,
          code_sent_at: pend && pend.first_sent_at, code_resends: pend ? pend.resends : null,
          code_wrong_attempts: pend ? pend.failed_attempts_total : null, code_confirmed_at: ev.sms_verified_at,
        };
      }
      const photos = db.prepare('SELECT id, kind FROM cylinder_photos WHERE cylinder_id = ? ORDER BY id').all(ev.cylinder_id);
      v.reference_photos = photos;
      const cyl = getCyl(ev.cylinder_id);
      v.cylinder = cyl ? { id: cyl.id, serial: cyl.serial, gas_type: cyl.gas_type } : null;
    }
    return v;
  }

  function cylinderView(cyl, { full = false } = {}) {
    const latestSubmitted = cyl.latest_submitted_event_id ? db.prepare('SELECT * FROM events WHERE id = ?').get(cyl.latest_submitted_event_id) : null;
    const latestApproved = cyl.latest_approved_event_id ? db.prepare('SELECT * FROM events WHERE id = ?').get(cyl.latest_approved_event_id) : null;
    const site = getSite(cyl.current_site_id);
    const dest = getSite(cyl.destination_site_id);
    const v = {
      id: cyl.id, serial: cyl.serial, brand_owner: cyl.brand_owner, gas_type: cyl.gas_type, size: cyl.size, tare_kg: cyl.tare_kg,
      registration_date: cyl.registration_date, initial_condition: cyl.initial_condition, initial_bay: cyl.initial_bay,
      initial_site: getSite(cyl.initial_site_id), expected_return_days: cyl.expected_return_days,
      movement_status: cyl.movement_status, current_site: site, destination_site: dest,
      latest_submitted: eventView(latestSubmitted), last_approved: eventView(latestApproved),
      photos: db.prepare('SELECT id, kind, created_at FROM cylinder_photos WHERE cylinder_id = ? ORDER BY id').all(cyl.id),
      version: cyl.version,
    };
    if (full) {
      v.qr_codes = db.prepare('SELECT token, status, created_at, revoked_at, revoked_reason, replaced_by FROM qr_codes WHERE cylinder_id = ? ORDER BY created_at').all(cyl.id);
      v.label_prints = db.prepare(`SELECT p.id, p.kind, p.batch_id, p.printed_at, p.qr_token, u.display_name AS printed_by
        FROM label_prints p JOIN users u ON u.id = p.printed_by WHERE p.cylinder_id = ? ORDER BY p.id`).all(cyl.id);
      v.nfc_tags = db.prepare('SELECT tag_uid, tag_type, status, bound_at, revoked_at FROM nfc_tags WHERE cylinder_id = ?').all(cyl.id);
    }
    return v;
  }

  // ---------- auth ----------
  app.post('/api/auth/login', h((req, res) => {
    const username = str(req.body.username, 64);
    const password = String(req.body.password || '');
    const key = `${username.toLowerCase()}|${req.ip}`;
    const wait = auth.loginThrottle(key);
    if (wait) return res.status(429).json({ error: 'THROTTLED', message: `Too many attempts. Try again in ${wait} s.` });
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || !u.active || !auth.verifyPassword(password, u.password_hash)) {
      auth.loginFailed(key);
      audit(req, 'login_failed', 'user', username);
      return res.status(401).json({ error: 'BAD_LOGIN', message: 'Incorrect username or password.' });
    }
    auth.loginSucceeded(key);
    const { token, expires } = auth.createSession(db, u.id);
    auth.setSessionCookie(req, res, token, expires);
    req.user = u;
    audit(req, 'login', 'user', u.id);
    res.json({ user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role, preferred_lang: u.preferred_lang } });
  }));

  app.post('/api/auth/logout', h((req, res) => {
    if (req.sessionTokenHash) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null }));

  app.post('/api/me/lang', auth.requireAuth, h((req, res) => {
    const lang = req.body.lang === 'th' ? 'th' : 'en';
    db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(lang, req.user.id);
    res.json({ ok: true });
  }));

  // ---------- public QR landing (read-only, never records location) ----------
  app.get('/api/public/qr/:token', h((req, res) => {
    const qr = db.prepare('SELECT * FROM qr_codes WHERE token = ?').get(String(req.params.token));
    if (!qr) return res.status(404).json({ status: 'unknown', message: 'This QR code is not recognised.' });
    const cyl = getCyl(qr.cylinder_id);
    const pub = { id: cyl.id, serial: cyl.serial, gas_type: cyl.gas_type, size: cyl.size, brand_owner: cyl.brand_owner };
    res.json({ status: qr.status, cylinder: pub, logged_in: !!req.user });
  }));

  app.get('/api/config', (req, res) => {
    const s = settings();
    res.json({
      max_fix_age_s: Number(s.max_fix_age_s), max_accuracy_m: Number(s.max_accuracy_m),
      geolocation_timeout_s: Number(s.geolocation_timeout_s),
      location_lock_s: Number(s.location_lock_s), snapshot_required: s.auto_snapshot_on_scan === '1',
      require_weight: s.require_weight_at_warehouse === '1', sms_provider: sms.name, sms_dev: !!sms.isDev, sms_available: !sms.unavailable,
      tile_url: tileUrl || '', nfc_verifier: nfc.verifierConfigured(),
      secure_context_hint: req.secure || ['localhost', '127.0.0.1'].includes(req.hostname),
    });
  });

  // ---------- shared reads ----------
  app.get('/api/sites', auth.requireAuth, (req, res) => {
    res.json({ sites: db.prepare('SELECT id, code, name, kind, customer_name, lat, lng, radius_m FROM sites WHERE active = 1 ORDER BY kind, name').all() });
  });

  app.get('/api/cylinders/:id', auth.requireAuth, h((req, res) => {
    const cyl = getCyl(req.params.id);
    if (!cyl) fail(404, 'NOT_FOUND', 'Cylinder not found.');
    const isAdmin = req.user.role === 'admin';
    const v = cylinderView(cyl, { full: isAdmin || req.user.role === 'supervisor' });
    v.events = db.prepare('SELECT * FROM events WHERE cylinder_id = ? ORDER BY id DESC').all(cyl.id).map((e) => eventView(e));
    res.json({ cylinder: v });
  }));

  app.get('/api/cylinders/by-token/:token', auth.requireAuth, h((req, res) => {
    const qr = db.prepare('SELECT * FROM qr_codes WHERE token = ?').get(String(req.params.token));
    if (!qr) fail(404, 'NOT_FOUND', 'QR not recognised.');
    res.json({ cylinder_id: qr.cylinder_id, status: qr.status });
  }));

  app.get('/api/photos/:id', auth.requireAuth, h((req, res) => {
    const p = db.prepare('SELECT * FROM cylinder_photos WHERE id = ?').get(Number(req.params.id));
    if (!p) fail(404, 'NOT_FOUND', 'Photo not found.');
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(path.join(dataDir, 'photos', p.file)).pipe(res);
  }));

  app.get('/api/me/events', auth.requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ events: rows.map((e) => { const v = eventView(e); const c = getCyl(e.cylinder_id); v.serial = c.serial; return v; }) });
  });

  app.get('/api/cylinders-lookup', auth.requireAuth, h((req, res) => {
    const serial = str(req.query.serial, 80);
    if (serial.length < 3) fail(422, 'SERIAL_SHORT', 'Enter at least 3 characters of the engraved serial.');
    const rows = db.prepare("SELECT id, serial, gas_type, size FROM cylinders WHERE serial LIKE ? AND movement_status <> 'retired' LIMIT 10").all(`%${serial}%`);
    res.json({ cylinders: rows });
  }));

  // ---------- inspection, phones, audits, statements ----------
  const ctx = {
    db, dbm, h, fail, str, S, settings, nowIso, randomId, audit, auth, getCyl, getSite, eventView, sms, codes,
    maskPhone, normalizePhone, upload, saveFile, sha, baseUrlFor: baseUrl, nfc,
  };
  require('./inspection')(app, ctx);
  require('./phone')(app, ctx);
  require('./audits')(app, ctx);
  require('./statements')(app, ctx);

  app.get('/api/snapshots/:id', auth.requireAuth, h((req, res) => {
    const m = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(String(req.params.id));
    if (!m) fail(404, 'NOT_FOUND', 'Snapshot not found.');
    if (!['admin', 'supervisor'].includes(req.user.role) && m.user_id !== req.user.id) fail(403, 'FORBIDDEN', 'You cannot view this evidence.');
    if (m.purged_at || !m.file) fail(410, 'PURGED', 'Evidence was removed under the retention policy.');
    audit(req, 'snapshot_viewed', 'snapshot', m.id);
    res.setHeader('Content-Type', m.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(path.join(dataDir, 'snapshots', m.file)).pipe(res);
  }));

  // ---------- evidence access (restricted) ----------
  // ---------- supervisor review ----------
  const reviewer = auth.requireRole('supervisor', 'admin');

  app.get('/api/review/queue', reviewer, (req, res) => {
    const rows = db.prepare(`SELECT * FROM events WHERE initial_verification IN ('evidence_pending','exception_pending','recorded')
      AND event_type <> 'correction' ORDER BY id DESC LIMIT 500`).all();
    const out = [];
    for (const e of rows) {
      const v = eventView(e);
      if (['evidence_pending', 'exception_pending'].includes(v.verification_status)) {
        v.serial = getCyl(e.cylinder_id).serial;
        v.own_submission = e.user_id === req.user.id;
        out.push(v);
      }
    }
    res.json({ events: out });
  });

  app.get('/api/events/:id', auth.requireAuth, h((req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id));
    if (!e) fail(404, 'NOT_FOUND', 'Event not found.');
    const privileged = ['admin', 'supervisor'].includes(req.user.role);
    if (!privileged && e.user_id !== req.user.id) {
      return res.json({ event: eventView(e) });
    }
    res.json({ event: eventView(e, { full: true }), reject_reasons: REJECT_REASONS });
  }));

  app.post('/api/events/:id/review', reviewer, h((req, res) => {
    const decision = req.body.decision;
    if (!['approved', 'rejected'].includes(decision)) fail(422, 'DECISION', 'Decision must be approved or rejected.');
    const reason = str(req.body.reason_code, 40) || null;
    const notes = str(req.body.notes, 2000);
    if (decision === 'rejected' && (!reason || !REJECT_REASONS.includes(reason))) fail(422, 'REASON_REQUIRED', 'Select a rejection reason.');
    if (decision === 'rejected' && notes.length < 3) fail(422, 'NOTES_REQUIRED', 'Add review notes for a rejection.');
    const out = dbm.tx(db, () => {
      const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id));
      if (!e) fail(404, 'NOT_FOUND', 'Event not found.');
      if (e.event_type === 'correction' || e.event_type === 'registered') fail(409, 'NOT_REVIEWABLE', 'This entry is not reviewable.');
      if (e.user_id === req.user.id) fail(403, 'OWN_EVENT', 'You cannot review your own submission.');
      const t = nowIso();
      db.prepare('INSERT INTO reviews (event_id, reviewer_id, decision, reason_code, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e.id, req.user.id, decision, reason, notes || null, t);
      D.recomputeCylinder(db, e.cylinder_id);
      audit(req, `event_${decision}`, 'event', e.id, { reason });
      return e;
    });
    res.json({ event: eventView(out, { full: true }) });
  }));

  // Corrections create a new audit entry that references the original.
  app.post('/api/events/:id/correction', reviewer, h((req, res) => {
    const notes = str(req.body.notes, 2000);
    if (notes.length < 5) fail(422, 'NOTES_REQUIRED', 'Explain the correction.');
    const out = dbm.tx(db, () => {
      const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id));
      if (!e || e.event_type === 'correction') fail(404, 'NOT_FOUND', 'Event not found.');
      const site = req.body.site_id ? getSite(req.body.site_id) : null;
      if (req.body.site_id && !site) fail(422, 'SITE_INVALID', 'Site not found.');
      const t = nowIso();
      const info = db.prepare(`INSERT INTO events (cylinder_id, event_type, user_id, responsible_person, site_id, bay, delivery_ref, comments,
        location_status, geofence_result, initial_verification, corrects_event_id, server_received_at)
        VALUES (?, 'correction', ?, ?, ?, ?, ?, ?, 'not_applicable', 'not_checked', 'recorded', ?, ?)`)
        .run(e.cylinder_id, req.user.id, str(req.body.responsible_person, 120) || null, site ? site.id : null,
          str(req.body.bay, 60) || null, str(req.body.delivery_ref, 80) || null, notes, e.id, t);
      D.recomputeCylinder(db, e.cylinder_id);
      audit(req, 'event_corrected', 'event', e.id, { correction_event: Number(info.lastInsertRowid) });
      return db.prepare('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid));
    });
    res.status(201).json({ event: eventView(out) });
  }));

  // ---------- admin: registration and labels ----------
  const admin = auth.requireRole('admin');

  function nextCylinderId() {
    const r = db.prepare("SELECT id FROM cylinders WHERE id LIKE 'FTT-%' ORDER BY id DESC LIMIT 1").get();
    const n = r ? Number(r.id.slice(4)) + 1 : 1;
    return `FTT-${String(n).padStart(6, '0')}`;
  }

  app.post('/api/cylinders', admin, upload.fields([{ name: 'photo_whole', maxCount: 1 }, { name: 'photo_serial', maxCount: 1 }]), h((req, res) => {
    const b = req.body;
    const serial = str(b.serial, 80);
    const fields = {
      brand_owner: str(b.brand_owner, 120), gas_type: str(b.gas_type, 60), size: str(b.size, 40),
      registration_date: str(b.registration_date, 10), initial_bay: str(b.initial_bay, 60), initial_condition: str(b.initial_condition, 30),
    };
    const tare = Number(b.tare_kg);
    if (!serial) fail(422, 'SERIAL_REQUIRED', 'Enter the engraved serial number.');
    for (const k of ['brand_owner', 'gas_type', 'size']) if (!fields[k]) fail(422, 'FIELD_REQUIRED', `Field required: ${k}.`);
    if (!Number.isFinite(tare) || tare <= 0 || tare > 500) fail(422, 'TARE_INVALID', 'Enter the tare weight in kg.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.registration_date)) fields.registration_date = nowIso().slice(0, 10);
    if (!D.CONDITIONS.includes(fields.initial_condition)) fail(422, 'CONDITION_REQUIRED', 'Select the initial condition.');
    const site = getSite(b.initial_site_id);
    if (!site || !site.active) fail(422, 'SITE_REQUIRED', 'Select the initial site.');
    const whole = req.files && req.files.photo_whole && req.files.photo_whole[0];
    const serialPhoto = req.files && req.files.photo_serial && req.files.photo_serial[0];
    if (!whole || !serialPhoto) fail(422, 'PHOTOS_REQUIRED', 'Add reference photos of the complete cylinder and the engraved serial.');
    for (const p of [whole, serialPhoto]) if (!/^image\/(jpeg|png|webp)$/.test(p.mimetype)) fail(422, 'PHOTO_TYPE', 'Photos must be JPEG, PNG or WebP.');
    if (db.prepare('SELECT 1 FROM cylinders WHERE serial = ?').get(serial)) fail(409, 'DUPLICATE_SERIAL', 'A cylinder with this engraved serial number is already registered.');
    const returnDays = b.expected_return_days ? Math.max(1, Math.min(3650, Number(b.expected_return_days) || 0)) : null;

    const result = dbm.tx(db, () => {
      const id = nextCylinderId();
      const t = nowIso();
      const status = site.kind === 'warehouse' ? 'in_warehouse' : 'at_customer';
      db.prepare(`INSERT INTO cylinders (id, serial, brand_owner, gas_type, size, tare_kg, registration_date, initial_site_id, initial_bay,
        initial_condition, expected_return_days, movement_status, current_site_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, serial, fields.brand_owner, fields.gas_type, fields.size, tare,
        fields.registration_date, site.id, fields.initial_bay || null, fields.initial_condition, returnDays, status, site.id, req.user.id, t);
      for (const [kind, p] of [['whole', whole], ['serial', serialPhoto]]) {
        const ext = p.mimetype === 'image/png' ? '.png' : p.mimetype === 'image/webp' ? '.webp' : '.jpg';
        db.prepare('INSERT INTO cylinder_photos (cylinder_id, kind, file, mime, sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, kind, saveFile('photos', p.buffer, ext), p.mimetype, sha(p.buffer), req.user.id, t);
      }
      const token = randomId(16);
      db.prepare("INSERT INTO qr_codes (token, cylinder_id, status, created_by, created_at) VALUES (?, ?, 'active', ?, ?)").run(token, id, req.user.id, t);
      const nfcUid = str(b.nfc_tag_uid, 64);
      db.prepare(`INSERT INTO events (cylinder_id, event_type, movement_status_after, user_id, responsible_person, site_id, bay, condition,
        location_status, geofence_result, initial_verification, server_received_at, comments)
        VALUES (?, 'registered', ?, ?, ?, ?, ?, ?, 'not_applicable', 'not_checked', 'recorded', ?, ?)`)
        .run(id, status, req.user.id, req.user.display_name, site.id, fields.initial_bay || null, fields.initial_condition, t,
          nfcUid ? `NFC tag identifier noted at registration (not bound or verified): ${nfcUid}` : null);
      D.recomputeCylinder(db, id, { bumpVersion: true });
      audit(req, 'cylinder_registered', 'cylinder', id, { serial });
      return id;
    });
    res.status(201).json({ cylinder: cylinderView(getCyl(result), { full: true }) });
  }));

  function filterCylinders(q) {
    let rows = db.prepare('SELECT * FROM cylinders ORDER BY id').all();
    const like = (a, b) => String(a || '').toLowerCase().includes(String(b).toLowerCase());
    if (q.serial) rows = rows.filter((c) => like(c.serial, q.serial) || like(c.id, q.serial));
    if (q.gas_type) rows = rows.filter((c) => like(c.gas_type, q.gas_type));
    if (q.movement_status) rows = rows.filter((c) => c.movement_status === q.movement_status);
    if (q.site_id) rows = rows.filter((c) => String(c.current_site_id) === String(q.site_id) || String(c.destination_site_id) === String(q.site_id));
    const out = [];
    for (const c of rows) {
      const v = cylinderView(c);
      const ls = v.latest_submitted;
      if (q.customer && !like(v.current_site && v.current_site.customer_name, q.customer) && !like(v.destination_site && v.destination_site.name, q.customer)) continue;
      if (q.operator_id && (!ls || String(ls.recorded_by_id) !== String(q.operator_id))) continue;
      if (q.verification_status && (!ls || ls.verification_status !== q.verification_status)) continue;
      if (q.date_from && (!ls || ls.server_received_at.slice(0, 10) < q.date_from)) continue;
      if (q.date_to && (!ls || ls.server_received_at.slice(0, 10) > q.date_to)) continue;
      out.push(v);
    }
    return out;
  }

  const staff = auth.requireRole('admin', 'supervisor');

  app.get('/api/cylinders', staff, (req, res) => res.json({ cylinders: filterCylinders(req.query) }));

  function filterEvents(q) {
    const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 5000').all();
    const out = [];
    for (const e of rows) {
      if (q.cylinder_id && e.cylinder_id !== q.cylinder_id) continue;
      if (q.operator_id && String(e.user_id) !== String(q.operator_id)) continue;
      if (q.site_id && String(e.site_id) !== String(q.site_id)) continue;
      if (q.date_from && e.server_received_at.slice(0, 10) < q.date_from) continue;
      if (q.date_to && e.server_received_at.slice(0, 10) > q.date_to) continue;
      if (q.movement_status && e.movement_status_after !== q.movement_status) continue;
      const v = eventView(e);
      if (q.verification_status && v.verification_status !== q.verification_status) continue;
      const c = getCyl(e.cylinder_id);
      v.serial = c.serial;
      v.gas_type = c.gas_type;
      if (q.serial && !c.serial.toLowerCase().includes(String(q.serial).toLowerCase())) continue;
      if (q.gas_type && !c.gas_type.toLowerCase().includes(String(q.gas_type).toLowerCase())) continue;
      if (q.customer && !String(v.site && v.site.customer_name || '').toLowerCase().includes(String(q.customer).toLowerCase())) continue;
      if (q.flagged === '1' && !v.flags.length) continue;
      out.push(v);
    }
    return out;
  }

  app.get('/api/events', staff, (req, res) => res.json({ events: filterEvents(req.query).slice(0, 500) }));

  // Labels: record each print, then render a printable page.
  app.post('/api/labels/print', admin, h((req, res) => {
    const ids = Array.isArray(req.body.cylinder_ids) ? req.body.cylinder_ids.map(String).slice(0, 500) : [];
    if (!ids.length) fail(422, 'NO_CYLINDERS', 'Select at least one cylinder.');
    const batch = randomId(9);
    dbm.tx(db, () => {
      for (const id of ids) {
        const qr = db.prepare("SELECT token FROM qr_codes WHERE cylinder_id = ? AND status = 'active'").get(id);
        if (!qr) fail(404, 'NO_ACTIVE_QR', `No active QR for ${id}.`);
        const printed = db.prepare('SELECT 1 FROM label_prints WHERE qr_token = ?').get(qr.token);
        db.prepare('INSERT INTO label_prints (cylinder_id, qr_token, kind, batch_id, printed_by, printed_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, qr.token, printed ? 'reprint' : 'initial', batch, req.user.id, nowIso());
      }
      audit(req, 'labels_printed', 'label_batch', batch, { count: ids.length });
    });
    res.status(201).json({ batch_id: batch, url: `/labels/${batch}` });
  }));

  app.post('/api/cylinders/:id/replace-label', admin, h((req, res) => {
    const reason = str(req.body.reason, 300);
    if (reason.length < 3) fail(422, 'REASON_REQUIRED', 'Give a reason for the replacement.');
    const batch = randomId(9);
    const token = dbm.tx(db, () => {
      const cyl = getCyl(req.params.id);
      if (!cyl) fail(404, 'NOT_FOUND', 'Cylinder not found.');
      const old = db.prepare("SELECT token FROM qr_codes WHERE cylinder_id = ? AND status = 'active'").get(cyl.id);
      const t = nowIso();
      const fresh = randomId(16);
      if (old) {
        db.prepare("UPDATE qr_codes SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = ?, replaced_by = ? WHERE token = ?")
          .run(t, req.user.id, reason, fresh, old.token);
      }
      db.prepare("INSERT INTO qr_codes (token, cylinder_id, status, created_by, created_at) VALUES (?, ?, 'active', ?, ?)").run(fresh, cyl.id, req.user.id, t);
      db.prepare("INSERT INTO label_prints (cylinder_id, qr_token, kind, batch_id, printed_by, printed_at) VALUES (?, ?, 'replacement', ?, ?, ?)")
        .run(cyl.id, fresh, batch, req.user.id, t);
      audit(req, 'label_replaced', 'cylinder', cyl.id, { revoked: old && old.token.slice(0, 6), reason });
      return fresh;
    });
    res.status(201).json({ batch_id: batch, url: `/labels/${batch}`, token_prefix: token.slice(0, 6) });
  }));

  app.get('/labels/:batch', (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).send('Administrator login required.');
    next();
  }, h(async (req, res) => {
    const rows = db.prepare(`SELECT p.*, c.serial FROM label_prints p JOIN cylinders c ON c.id = p.cylinder_id
      WHERE p.batch_id = ? ORDER BY p.id`).all(String(req.params.batch));
    if (!rows.length) return res.status(404).send('Label batch not found.');
    const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const labels = [];
    for (const r of rows) {
      const qr = db.prepare('SELECT status FROM qr_codes WHERE token = ?').get(r.qr_token);
      const url = `${baseUrl(req)}/c/${r.qr_token}`;
      const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 });
      labels.push(`<div class="label${qr.status !== 'active' ? ' revoked' : ''}">
        <div class="brand">BJC Cylinder Tracker</div>
        <div class="qr">${svg}</div>
        <div class="serial">S/N ${esc(r.serial)}</div>
        <div class="iid">ID ${esc(r.cylinder_id)}</div>
        <div class="cta">Scan to record inspection / movement<br><span lang="th">สแกนเพื่อบันทึกการตรวจ / การเคลื่อนย้าย</span></div>
        ${qr.status !== 'active' ? '<div class="void">REVOKED – DO NOT USE</div>' : ''}
      </div>`);
    }
    const httpWarn = baseUrl(req).startsWith('https://') ? '' : '<p class="warn">Warning: labels encode a non-HTTPS URL. Set PUBLIC_BASE_URL to your HTTPS address before printing production labels.</p>';
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Labels ${esc(req.params.batch)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:12px;background:#fff;color:#0b2e1a}
  .bar{margin-bottom:12px}.bar p{margin:4px 0;font-size:14px}.warn{color:#9a3412;font-weight:600}
  .sheet{display:flex;flex-wrap:wrap;gap:6mm}
  .label{width:62mm;border:0.4mm solid #0f7a3d;border-radius:3mm;padding:3mm;text-align:center;break-inside:avoid;position:relative}
  .brand{background:#0f7a3d;color:#fff;font-weight:700;font-size:10pt;border-radius:1.5mm;padding:1mm}
  .qr svg{width:44mm;height:44mm}
  .serial{font-size:12pt;font-weight:800;letter-spacing:.3px}.iid{font-size:9pt;color:#335}
  .cta{font-size:7.5pt;margin-top:1mm;color:#0b2e1a}
  .void{position:absolute;top:40%;left:0;right:0;color:#b91c1c;font-weight:900;font-size:14pt;transform:rotate(-20deg)}
  @media print{.bar{display:none}body{padding:0}}
</style></head><body>
<div class="bar"><p><strong>${rows.length} label(s)</strong> · batch ${esc(req.params.batch)} · use durable, weather-resistant label stock. Do not cover existing cylinder markings, engraved serials, or safety labels.</p>${httpWarn}<p>Use your browser's Print command (Ctrl/Cmd+P).</p></div>
<div class="sheet">${labels.join('')}</div></body></html>`);
  }));

  app.post('/api/cylinders/:id/retire', admin, h((req, res) => {
    const reason = str(req.body.reason, 500);
    if (reason.length < 3) fail(422, 'REASON_REQUIRED', 'Give a reason.');
    const ev = dbm.tx(db, () => {
      const cyl = getCyl(req.params.id);
      if (!cyl) fail(404, 'NOT_FOUND', 'Cylinder not found.');
      if (cyl.movement_status === 'retired') fail(409, 'CYLINDER_RETIRED', 'Already retired.');
      const t = nowIso();
      const info = db.prepare(`INSERT INTO events (cylinder_id, event_type, movement_status_after, user_id, responsible_person, site_id, comments,
        location_status, geofence_result, initial_verification, server_received_at) VALUES (?, 'retired', 'retired', ?, ?, ?, ?, 'not_applicable', 'not_checked', 'recorded', ?)`)
        .run(cyl.id, req.user.id, req.user.display_name, cyl.current_site_id, reason, t);
      db.prepare("UPDATE qr_codes SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = 'cylinder retired' WHERE cylinder_id = ? AND status = 'active'")
        .run(t, req.user.id, cyl.id);
      D.recomputeCylinder(db, cyl.id, { bumpVersion: true });
      audit(req, 'cylinder_retired', 'cylinder', cyl.id, { reason });
      return db.prepare('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid));
    });
    res.status(201).json({ event: eventView(ev) });
  }));

  app.post('/api/cylinders/:id/nfc', admin, (req, res) => {
    res.status(501).json({ error: 'NFC_NOT_CONFIGURED', message: 'Secure NFC tag binding requires a configured backend verifier, tag keys and tested hardware. Not available in this build.' });
  });

  // ---------- admin: sites, users, settings ----------
  app.get('/api/admin/sites', admin, (req, res) => res.json({ sites: db.prepare('SELECT * FROM sites ORDER BY kind, name').all() }));

  function siteFields(b) {
    const f = {
      code: str(b.code, 30), name: str(b.name, 120), kind: b.kind === 'customer' ? 'customer' : 'warehouse',
      customer_name: str(b.customer_name, 120) || null, address: str(b.address, 300) || null,
      lat: b.lat === '' || b.lat == null ? null : Number(b.lat), lng: b.lng === '' || b.lng == null ? null : Number(b.lng),
      radius_m: b.radius_m === '' || b.radius_m == null ? null : Number(b.radius_m), active: b.active === false || b.active === 0 ? 0 : 1,
      contact_phone_e164: b.contact_phone ? normalizePhone(b.contact_phone) : null,
    };
    if (b.contact_phone && !f.contact_phone_e164) fail(422, 'PHONE_INVALID', 'Enter a valid contact mobile number.');
    if (!f.code || !f.name) fail(422, 'FIELD_REQUIRED', 'Code and name are required.');
    if ((f.lat != null && (!Number.isFinite(f.lat) || Math.abs(f.lat) > 90)) || (f.lng != null && (!Number.isFinite(f.lng) || Math.abs(f.lng) > 180))) fail(422, 'COORDS', 'Invalid geofence centre.');
    if (f.radius_m != null && (!Number.isFinite(f.radius_m) || f.radius_m < 10 || f.radius_m > 20000)) fail(422, 'RADIUS', 'Radius must be 10–20000 m.');
    return f;
  }

  app.post('/api/admin/sites', admin, h((req, res) => {
    const f = siteFields(req.body);
    const info = db.prepare(`INSERT INTO sites (code, name, kind, customer_name, address, lat, lng, radius_m, active, contact_phone_e164, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.code, f.name, f.kind, f.customer_name, f.address, f.lat, f.lng, f.radius_m, f.active, f.contact_phone_e164, nowIso());
    audit(req, 'site_created', 'site', info.lastInsertRowid, f);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  app.put('/api/admin/sites/:id', admin, h((req, res) => {
    const f = siteFields(req.body);
    const before = db.prepare('SELECT contact_phone_e164 FROM sites WHERE id = ?').get(Number(req.params.id));
    if (!before) fail(404, 'NOT_FOUND', 'Site not found.');
    db.prepare(`UPDATE sites SET code = ?, name = ?, kind = ?, customer_name = ?, address = ?, lat = ?, lng = ?, radius_m = ?, active = ? WHERE id = ?`)
      .run(f.code, f.name, f.kind, f.customer_name, f.address, f.lat, f.lng, f.radius_m, f.active, Number(req.params.id));
    if (f.contact_phone_e164 !== before.contact_phone_e164) {
      db.prepare('UPDATE sites SET contact_phone_e164 = ?, contact_phone_verified_at = NULL WHERE id = ?').run(f.contact_phone_e164, Number(req.params.id));
    }
    audit(req, 'site_updated', 'site', req.params.id, f);
    res.json({ ok: true });
  }));

  app.get('/api/admin/users', staff, (req, res) => {
    const rows = db.prepare('SELECT id, username, display_name, role, active, created_at, phone_e164, phone_verified_at FROM users ORDER BY id').all();
    const isAdmin = req.user.role === 'admin';
    res.json({ users: rows.map(({ phone_e164: ph, phone_verified_at: pv, ...u }) => ({ ...u, phone: isAdmin ? ph : undefined, phone_masked: maskPhone(ph), phone_verified: !!pv })) });
  });

  app.post('/api/admin/users', admin, h((req, res) => {
    const username = str(req.body.username, 64);
    const role = req.body.role;
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) fail(422, 'USERNAME', 'Username: 3–64 letters, digits, . _ -');
    if (!['admin', 'operator', 'supervisor'].includes(role)) fail(422, 'ROLE', 'Invalid role.');
    if (String(req.body.password || '').length < 10) fail(422, 'PASSWORD', 'Password must be at least 10 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'USERNAME_TAKEN', 'Username already exists.');
    const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
    if (req.body.phone && !phone) fail(422, 'PHONE_INVALID', 'Enter a valid mobile number, e.g. 081-234-5678.');
    if (phone && db.prepare('SELECT 1 FROM users WHERE phone_e164 = ?').get(phone)) fail(409, 'PHONE_TAKEN', 'This mobile number is already registered to another user.');
    const info = db.prepare('INSERT INTO users (username, display_name, password_hash, role, phone_e164, phone_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(username, str(req.body.display_name, 120) || username, auth.hashPassword(String(req.body.password)), role, phone, null, nowIso());
    audit(req, 'user_created', 'user', info.lastInsertRowid, { username, role });
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  app.put('/api/admin/users/:id', admin, h((req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) fail(404, 'NOT_FOUND', 'User not found.');
    if (id === req.user.id && (req.body.active === false || (req.body.role && req.body.role !== 'admin'))) fail(409, 'SELF', 'You cannot deactivate or demote yourself.');
    const role = req.body.role && ['admin', 'operator', 'supervisor'].includes(req.body.role) ? req.body.role : u.role;
    const active = req.body.active === undefined ? u.active : (req.body.active ? 1 : 0);
    const name = str(req.body.display_name, 120) || u.display_name;
    db.prepare('UPDATE users SET role = ?, active = ?, display_name = ? WHERE id = ?').run(role, active, name, id);
    if (req.body.phone !== undefined) {
      const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
      if (req.body.phone && !phone) fail(422, 'PHONE_INVALID', 'Enter a valid mobile number, e.g. 081-234-5678.');
      if (phone !== u.phone_e164) {
        if (phone && db.prepare('SELECT 1 FROM users WHERE phone_e164 = ? AND id <> ?').get(phone, id)) fail(409, 'PHONE_TAKEN', 'This mobile number is already registered to another user.');
        // Only a replacement of an existing number counts as a "change" signal.
        db.prepare('UPDATE users SET phone_e164 = ?, phone_verified_at = NULL, phone_changed_at = ? WHERE id = ?').run(phone, u.phone_e164 ? nowIso() : u.phone_changed_at, id);
        audit(req, 'phone_changed', 'user', id, { phone: maskPhone(phone) });
      }
    }
    if (req.body.password) {
      if (String(req.body.password).length < 10) fail(422, 'PASSWORD', 'Password must be at least 10 characters.');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(req.body.password)), id);
    }
    if (!active || req.body.password) db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
    audit(req, 'user_updated', 'user', id, { role, active, password_reset: !!req.body.password });
    res.json({ ok: true });
  }));

  app.get('/api/admin/settings', admin, (req, res) => res.json({ settings: settings(), defaults: dbm.DEFAULT_SETTINGS }));

  app.put('/api/admin/settings', admin, h((req, res) => {
    const t = nowIso();
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!(k in dbm.DEFAULT_SETTINGS)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(422, 'SETTING', `Invalid value for ${k}.`);
      db.prepare('UPDATE settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?').run(String(n), req.user.id, t, k);
    }
    audit(req, 'settings_updated', 'settings', null, req.body);
    res.json({ settings: settings() });
  }));

  app.get('/api/admin/audit', admin, (req, res) => {
    res.json({ entries: db.prepare(`SELECT a.*, u.display_name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`).all() });
  });

  function runRetention() {
    const days = S('evidence_retention_days');
    if (!days) return 0;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const snaps = db.prepare('SELECT id, file FROM snapshots WHERE purged_at IS NULL AND created_at < ?').all(cutoff);
    for (const m of snaps) {
      try { fs.unlinkSync(path.join(dataDir, 'snapshots', m.file)); } catch (_) { /* already gone */ }
      db.prepare('UPDATE snapshots SET purged_at = ?, file = NULL WHERE id = ?').run(nowIso(), m.id);
    }
    return snaps.length;
  }

  app.post('/api/admin/retention/run', admin, h((req, res) => {
    const n = runRetention();
    audit(req, 'retention_run', 'snapshot', null, { purged: n });
    res.json({ purged: n });
  }));

  // ---------- dashboard ----------
  app.get('/api/dashboard', staff, (req, res) => {
    ctx.sweepPending();
    const cyls = db.prepare('SELECT * FROM cylinders').all();
    const sites = new Map(db.prepare('SELECT * FROM sites').all().map((s) => [s.id, s]));
    const byStatus = {};
    const bySite = {};
    for (const c of cyls) {
      byStatus[c.movement_status] = (byStatus[c.movement_status] || 0) + 1;
      const s = c.movement_status === 'in_transit' ? null : sites.get(c.current_site_id);
      const key = s ? s.name : (c.movement_status === 'in_transit' ? '— in transit —' : '— unknown —');
      bySite[key] = bySite[key] || {};
      bySite[key][c.movement_status] = (bySite[key][c.movement_status] || 0) + 1;
    }
    const now = Date.now();
    const overdueDays = S('inspection_overdue_days');
    const defaultReturn = S('default_return_days');
    const overdueReturns = [];
    const noRecent = [];
    const markers = [];
    for (const c of cyls) {
      if (c.movement_status === 'retired') continue;
      const evs = db.prepare("SELECT * FROM events WHERE cylinder_id = ? AND event_type <> 'correction' ORDER BY id DESC").all(c.id)
        .filter((e) => D.effectiveVerification(db, e) !== 'rejected');
      const last = evs[0];
      if (!last || now - Date.parse(last.server_received_at) > overdueDays * 86400000) {
        noRecent.push({ id: c.id, serial: c.serial, last_event_at: last ? last.server_received_at : null });
      }
      if (c.movement_status === 'at_customer') {
        const recv = evs.find((e) => e.event_type === 'customer_received') || evs.find((e) => e.movement_status_after === 'at_customer');
        const dispatch = evs.find((e) => ['dispatched', 'transferred'].includes(e.event_type) && e.expected_return_date);
        let due = null;
        if (dispatch && dispatch.expected_return_date) due = Date.parse(`${dispatch.expected_return_date}T23:59:59Z`);
        else if (recv) due = Date.parse(recv.server_received_at) + (c.expected_return_days || defaultReturn) * 86400000;
        if (due && due < now) {
          const s = sites.get(c.current_site_id);
          overdueReturns.push({ id: c.id, serial: c.serial, site: s ? s.name : null, customer: s ? s.customer_name : null, due_at: new Date(due).toISOString() });
        }
      }
      if (c.latest_approved_event_id) {
        const e = db.prepare('SELECT * FROM events WHERE id = ?').get(c.latest_approved_event_id);
        if (e && e.lat != null) {
          markers.push({ cylinder_id: c.id, serial: c.serial, lat: e.lat, lng: e.lng, accuracy_m: e.accuracy_m,
            recorded_at: e.server_received_at, age_hours: Math.round((now - Date.parse(e.server_received_at)) / 36e5),
            movement_status: c.movement_status, event_id: e.id });
        }
      }
    }
    const pending = { evidence_pending: 0, exception_pending: 0 };
    for (const e of db.prepare("SELECT * FROM events WHERE initial_verification IN ('evidence_pending','exception_pending')").all()) {
      const st = D.effectiveVerification(db, e);
      if (st in pending) pending[st] += 1;
    }
    const suspiciousTypes = ['implausible_travel', 'repeated_scan', 'unexpected_custody', 'out_of_geofence', 'geofence_uncertain', 'clock_skew',
      'scan_far_from_confirmed_fix', 'driver_customer_pair_concentration', 'customer_code_entered_very_fast', 'sms_code_failed_attempts', 'audit_not_found', 'audit_mismatch'];
    const suspicious = db.prepare(`SELECT f.event_id, f.flag_type, f.detail, f.created_at, e.cylinder_id, c.serial
      FROM flags f JOIN events e ON e.id = f.event_id JOIN cylinders c ON c.id = e.cylinder_id
      WHERE f.flag_type IN (${suspiciousTypes.map(() => '?').join(',')}) ORDER BY f.id DESC LIMIT 50`).all(...suspiciousTypes);
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const codes24 = {
      awaiting_sms_code: db.prepare("SELECT COUNT(*) n FROM pending_submissions WHERE status = 'awaiting'").get().n,
      sms_unconfirmed: db.prepare("SELECT COUNT(*) n FROM pending_submissions WHERE status IN ('expired','burned','send_failed') AND closed_at >= ?").get(dayAgo).n,
      sms_burned: db.prepare("SELECT COUNT(*) n FROM pending_submissions WHERE status = 'burned' AND closed_at >= ?").get(dayAgo).n,
    };
    const audits = {
      open: db.prepare("SELECT COUNT(*) n FROM audits WHERE status = 'open'").get().n,
      unassigned: db.prepare("SELECT COUNT(*) n FROM audits WHERE status = 'open' AND assigned_to IS NULL").get().n,
      done_30d: db.prepare("SELECT outcome, COUNT(*) n FROM audits WHERE status = 'done' AND completed_at >= ? GROUP BY outcome")
        .all(new Date(Date.now() - 30 * 86400000).toISOString()),
    };
    const weightTypes = ['weight_below_tare', 'weight_gain', 'returned_unused', 'self_weighed_return'];
    const weightSignals = db.prepare(`SELECT f.event_id, f.flag_type, f.detail, f.created_at, c.serial FROM flags f JOIN events e ON e.id = f.event_id
      JOIN cylinders c ON c.id = e.cylinder_id WHERE f.flag_type IN (${weightTypes.map(() => '?').join(',')}) ORDER BY f.id DESC LIMIT 30`).all(...weightTypes);
    const statements = db.prepare(`SELECT h.id, s.name AS site_name, h.response, h.comments, h.expires_at, h.responded_at FROM holdings_statements h
      JOIN sites s ON s.id = h.site_id WHERE h.response = 'disputed' OR (h.response IS NULL AND h.expires_at < ?) ORDER BY h.id DESC LIMIT 30`).all(nowIso());
    res.json({
      codes: codes24, audits, weight_signals: weightSignals, risk: risk.riskSummary(db), statement_followups: statements,
      registered_count: cyls.length, by_status: byStatus, by_site: bySite, overdue_returns: overdueReturns,
      no_recent_inspection: noRecent, no_recent_days: overdueDays, pending, suspicious, markers,
      sites: [...sites.values()].filter((s) => s.lat != null).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, radius_m: s.radius_m, kind: s.kind })),
    });
  });

  // ---------- CSV export ----------
  function csv(rows, cols) {
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return `﻿${cols.join(',')}\r\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\r\n')}\r\n`;
  }

  app.get('/api/export/cylinders.csv', staff, (req, res) => {
    const rows = filterCylinders(req.query).map((c) => ({
      internal_id: c.id, serial: c.serial, brand_owner: c.brand_owner, gas_type: c.gas_type, size: c.size, tare_kg: c.tare_kg,
      movement_status: c.movement_status, current_site: c.current_site && c.current_site.name, customer: c.current_site && c.current_site.customer_name,
      destination_site: c.destination_site && c.destination_site.name,
      last_recorded_lat: c.last_approved && c.last_approved.lat, last_recorded_lng: c.last_approved && c.last_approved.lng,
      location_accuracy_m: c.last_approved && c.last_approved.accuracy_m, recorded_at: c.last_approved && c.last_approved.server_received_at,
      recorded_by: c.last_approved && c.last_approved.recorded_by, last_approved_verification: c.last_approved && c.last_approved.verification_status,
      latest_submitted_event: c.latest_submitted && c.latest_submitted.id, latest_submitted_verification: c.latest_submitted && c.latest_submitted.verification_status,
    }));
    audit(req, 'export_cylinders', 'export', null, { count: rows.length, query: req.query });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cylinders.csv"');
    res.send(csv(rows, ['internal_id', 'serial', 'brand_owner', 'gas_type', 'size', 'tare_kg', 'movement_status', 'current_site', 'customer',
      'destination_site', 'last_recorded_lat', 'last_recorded_lng', 'location_accuracy_m', 'recorded_at', 'recorded_by', 'last_approved_verification',
      'latest_submitted_event', 'latest_submitted_verification']));
  });

  app.get('/api/export/events.csv', staff, (req, res) => {
    const rows = filterEvents(req.query).map((e) => ({
      event_id: e.id, cylinder_id: e.cylinder_id, serial: e.serial, event_type: e.event_type, movement_status_after: e.movement_status_after,
      recorded_at: e.server_received_at, recorded_by: e.recorded_by, responsible_person: e.responsible_person, site: e.site && e.site.name,
      customer: e.site && e.site.customer_name, bay_operator_reported: e.bay, destination: e.destination && e.destination.name, delivery_ref: e.delivery_ref,
      condition: e.condition, lat: e.lat, lng: e.lng, accuracy_m: e.accuracy_m, fix_timestamp: e.fix_timestamp, location_status: e.location_status,
      geofence_result: e.geofence_result, verification_status: e.verification_status, exception_kind: e.exception_kind,
      flags: e.flags.map((f) => f.flag_type).join(' '), corrects_event_id: e.corrects_event_id,
    }));
    audit(req, 'export_events', 'export', null, { count: rows.length, query: req.query });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
    res.send(csv(rows, Object.keys(rows[0] || { event_id: 1 })));
  });

  // ---------- static app ----------
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  const sendIndex = (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  app.get('/', sendIndex);
  app.get('/c/:token', sendIndex); // QR landing: read-only page, no location request
  app.get('/s/:token', sendIndex); // customer holdings statement (public, single-use link)
  app.get('/app/*', sendIndex);
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' }));

  return { app, db, runRetention, sms, ctx };
}

module.exports = { createApp };
