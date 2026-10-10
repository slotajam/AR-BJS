// Acceptance tests (section 13). Run: npm test
//
// These exercise the real HTTP API against a fresh database. Evidence clips
// are synthetic byte buffers standing in for an in-app MediaRecorder clip:
// the server cannot verify video content, which is exactly why clips go to
// supervisor review. Browser-level behaviour (live camera, geolocation,
// MediaRecorder) is covered by test/e2e.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

const PASSWORD = 'test-password-123';
let server; let base; let db; let dataDir;
const sites = {};

// Bangkok warehouse geofence centre and a point well outside it.
const BKK = { lat: 13.6683, lng: 100.6044 };
const UDN = { lat: 17.4138, lng: 102.7872 };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { headers = {}, form } = {}) {
    const h = { 'X-Requested-With': 'TankTracker', ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b, o); }
  async login(username) {
    const r = await this.post('/api/auth/login', { username, password: PASSWORD });
    assert.equal(r.status, 200, `login ${username}`);
    return this;
  }
}

const tinyPng = () => QRCode.toBuffer(crypto.randomBytes(8).toString('hex'), { type: 'png', width: 64 });
const fakeClip = (bytes = 4096) => new Blob([crypto.randomBytes(bytes)], { type: 'video/webm' });

function freshLocation(point, { accuracy = 12, ageMs = 2000 } = {}) {
  const now = Date.now();
  return { lat: point.lat, lng: point.lng, accuracy_m: accuracy, fix_timestamp: new Date(now - ageMs).toISOString(), client_sent_at: new Date(now).toISOString() };
}

async function register(admin, serial, siteId = sites.bkk) {
  const fd = new FormData();
  Object.entries({ serial, brand_owner: 'BJC', gas_type: 'R-32', size: '9 kg', tare_kg: '6.5', initial_site_id: String(siteId), initial_bay: 'A-01', initial_condition: 'good' })
    .forEach(([k, v]) => fd.append(k, v));
  fd.append('photo_whole', new Blob([await tinyPng()], { type: 'image/png' }), 'whole.png');
  fd.append('photo_serial', new Blob([await tinyPng()], { type: 'image/png' }), 'serial.png');
  return admin.post('/api/cylinders', undefined, { form: fd });
}

function activeToken(cylId) {
  return db.prepare("SELECT token FROM qr_codes WHERE cylinder_id = ? AND status = 'active'").get(cylId).token;
}

// Runs steps 1–6 of the controlled workflow and returns the session context.
async function startInspection(client, cylId, { qrText } = {}) {
  const s = await client.post('/api/inspections', {});
  assert.equal(s.status, 201);
  const session = s.data.session;
  const scan = await client.post(`/api/inspections/${session.id}/scan`, { qr_text: qrText || `${base}/c/${activeToken(cylId)}`, scan_method: 'live_camera' });
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  return { session, challenge: scan.data.challenge, cylinder: scan.data.cylinder };
}

async function uploadClip(client, ctx, { clip = fakeClip(), source = 'live_camera_recorder', duration = 1500 } = {}) {
  const fd = new FormData();
  fd.append('challenge_id', ctx.challenge.id);
  fd.append('capture_source', source);
  fd.append('duration_ms', String(duration));
  fd.append('clip', clip, 'clip');
  return client.post(`/api/inspections/${ctx.session.id}/media`, undefined, { form: fd });
}

const ALL_CHECKED = { beside_cylinder: true, serial_matches: true, qr_attached: true, condition_checked: true, site_bay_correct: true };

function submit(client, ctx, overrides = {}, key = crypto.randomUUID()) {
  return client.post(`/api/inspections/${ctx.session.id}/submit`, {
    challenge_id: ctx.challenge.id, event_type: 'inspection', site_id: sites.bkk, bay: 'A-01', condition: 'good',
    checklist: ALL_CHECKED, location: freshLocation(BKK), ...overrides,
  }, { headers: { 'Idempotency-Key': key } });
}

async function fullInspection(client, cylId, overrides = {}) {
  const ctx = await startInspection(client, cylId);
  const up = await uploadClip(client, ctx);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  return { ctx, res: await submit(client, ctx, overrides) };
}

let admin; let supervisor; let supervisor2; let op1; let op2; let anon;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftt-test-'));
  const built = createApp({ dataDir, tileUrl: '' });
  db = built.db;
  const now = new Date().toISOString();
  for (const [u, role] of [['admin', 'admin'], ['sup', 'supervisor'], ['sup2', 'supervisor'], ['op1', 'operator'], ['op2', 'operator']]) {
    db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(u, u.toUpperCase(), hashPassword(PASSWORD), role, now);
  }
  const ins = db.prepare('INSERT INTO sites (code, name, kind, customer_name, lat, lng, radius_m, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  sites.bkk = Number(ins.run('WH-BKK', 'Bangkok WH', 'warehouse', null, BKK.lat, BKK.lng, 250, now).lastInsertRowid);
  sites.udn = Number(ins.run('CU-UDN', 'Udon Customer', 'customer', 'Udon Cool Co.', UDN.lat, UDN.lng, 150, now).lastInsertRowid);
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await new Client().login('admin');
  supervisor = await new Client().login('sup');
  supervisor2 = await new Client().login('sup2');
  op1 = await new Client().login('op1');
  op2 = await new Client().login('op2');
  anon = new Client();
  // Short synthetic clips are used in tests; production default is 4 s.
  const st = await admin.req('PUT', '/api/admin/settings', { min_clip_seconds: 1 });
  assert.equal(st.status, 200);
});

test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('1. registers a new cylinder and rejects a duplicate engraved serial', async () => {
  const r = await register(admin, 'SN-1001');
  assert.equal(r.status, 201);
  assert.match(r.data.cylinder.id, /^FTT-\d{6}$/);
  assert.equal(r.data.cylinder.movement_status, 'in_warehouse');
  assert.equal(r.data.cylinder.photos.length, 2);
  const dup = await register(admin, 'sn-1001'); // case-insensitive
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'DUPLICATE_SERIAL');
  const opTry = await register(op1, 'SN-OP');
  assert.equal(opTry.status, 403, 'operators cannot register cylinders');
});

test('2. generates a unique opaque QR label and a normal camera scan opens the cylinder page', async () => {
  const r = await register(admin, 'SN-2001');
  const id = r.data.cylinder.id;
  const token = activeToken(id);
  assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
  assert.ok(!token.includes(id) && !token.includes('SN-2001'), 'token is opaque');
  const p = await admin.post('/api/labels/print', { cylinder_ids: [id] });
  assert.equal(p.status, 201);
  const page = await admin.get(p.data.url);
  assert.equal(page.status, 200);
  for (const s of ['BJC Cylinder Tracker', 'SN-2001', id, 'Scan to record inspection / movement', '<svg']) assert.ok(page.data.includes(s), `label has ${s}`);
  const expectedSvg = await QRCode.toString(`${base}/c/${token}`, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 });
  assert.ok(page.data.includes(expectedSvg), 'QR encodes the HTTPS-app URL with the opaque token only');
  // Batch printing and reprint tracking.
  const r2 = await register(admin, 'SN-2002');
  const batch = await admin.post('/api/labels/print', { cylinder_ids: [id, r2.data.cylinder.id] });
  assert.equal(batch.status, 201);
  const kinds = db.prepare('SELECT kind FROM label_prints WHERE cylinder_id = ? ORDER BY id').all(id).map((x) => x.kind);
  assert.deepEqual(kinds, ['initial', 'reprint']);
  // Normal phone camera: opening the URL serves the app page.
  const landing = await anon.get(`/c/${token}`);
  assert.equal(landing.status, 200);
  assert.ok(String(landing.data).includes('/app.js'));
  const pub = await anon.get(`/api/public/qr/${token}`);
  assert.equal(pub.data.status, 'active');
  assert.equal(pub.data.cylinder.serial, 'SN-2001');
  assert.equal(pub.data.cylinder.current_site, undefined, 'no customer/location data on the public page');
  const nonAdminLabels = await op1.get(p.data.url);
  assert.equal(nonAdminLabels.status, 403);
});

test('3. opening a QR URL never changes the recorded location', async () => {
  const r = await register(admin, 'SN-3001');
  const id = r.data.cylinder.id;
  const token = activeToken(id);
  const before = { events: db.prepare('SELECT COUNT(*) n FROM events').get().n, cyl: db.prepare('SELECT * FROM cylinders WHERE id = ?').get(id) };
  for (const c of [anon, op1, admin]) {
    await c.get(`/c/${token}`);
    await c.get(`/api/public/qr/${token}`);
  }
  const after = { events: db.prepare('SELECT COUNT(*) n FROM events').get().n, cyl: db.prepare('SELECT * FROM cylinders WHERE id = ?').get(id) };
  assert.equal(after.events, before.events);
  assert.deepEqual(after.cyl, before.cyl);
});

test('4. successful controlled inspection is recorded with server timestamps', async () => {
  const r = await register(admin, 'SN-4001');
  const id = r.data.cylinder.id;
  const { ctx, res } = await fullInspection(op1, id);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const ev = res.data.event;
  assert.equal(ev.verification_status, 'recorded');
  assert.equal(ev.location_status, 'verified');
  assert.equal(ev.geofence_result, 'inside');
  assert.equal(ev.qr_verified, true);
  assert.ok(ev.media && ev.media.server_received_at);
  assert.ok(Math.abs(Date.parse(ev.server_received_at) - Date.now()) < 5000);
  const cyl = (await op1.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.last_approved.id, ev.id);
  assert.equal(cyl.last_approved.accuracy_m, 12);
  assert.ok(ctx.challenge.code.match(/^\d{4}$/));
});

test('5. location permission denied blocks normal submission but allows an exception', async () => {
  const r = await register(admin, 'SN-5001');
  const id = r.data.cylinder.id;
  const ctx = await startInspection(op1, id);
  await uploadClip(op1, ctx);
  const blocked = await submit(op1, ctx, { location: null });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.data.error, 'LOCATION_MISSING');
  assert.equal(blocked.data.exception_allowed, true);
  const exc = await submit(op1, ctx, { location: null, location_exception: true, exception_reason: 'Location permission denied on device' });
  assert.equal(exc.status, 201);
  assert.equal(exc.data.event.verification_status, 'exception_pending');
  assert.equal(exc.data.event.location_status, 'not_verified');
  const cyl = (await op1.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.last_approved.event_type, 'registered', 'exception does not become the approved location');
});

test('6. poor accuracy and stale fixes are rejected for normal submission', async () => {
  const r = await register(admin, 'SN-6001');
  const id = r.data.cylinder.id;
  const ctx = await startInspection(op1, id);
  await uploadClip(op1, ctx);
  const poor = await submit(op1, ctx, { location: freshLocation(BKK, { accuracy: 120 }) });
  assert.equal(poor.status, 422);
  assert.equal(poor.data.error, 'LOCATION_INACCURATE');
  const stale = await submit(op1, ctx, { location: freshLocation(BKK, { ageMs: 45000 }) });
  assert.equal(stale.status, 422);
  assert.equal(stale.data.error, 'LOCATION_STALE');
  // Typed/pinned coordinates are impossible: the API accepts only a fix object, and an inaccurate one is never "verified".
  const ok = await submit(op1, ctx, { location: freshLocation(BKK, { accuracy: 30, ageMs: 5000 }) });
  assert.equal(ok.status, 201);
});

test('7. expired and reused inspection challenges are rejected', async () => {
  const r = await register(admin, 'SN-7001');
  const id = r.data.cylinder.id;
  await admin.req('PUT', '/api/admin/settings', { challenge_ttl_s: 1 });
  const ctx = await startInspection(op1, id);
  await admin.req('PUT', '/api/admin/settings', { challenge_ttl_s: 600 });
  await new Promise((res) => setTimeout(res, 1300));
  const late = await uploadClip(op1, ctx);
  assert.equal(late.status, 410);
  assert.equal(late.data.error, 'CHALLENGE_EXPIRED');
  const lateSubmit = await submit(op1, ctx);
  assert.equal(lateSubmit.status, 410);
  // Fresh challenge, successful submit, then reuse.
  const nc = await op1.post(`/api/inspections/${ctx.session.id}/challenge`, {});
  ctx.challenge = nc.data.challenge;
  await uploadClip(op1, ctx);
  const key = crypto.randomUUID();
  const ok = await submit(op1, ctx, {}, key);
  assert.equal(ok.status, 201);
  const replay = await submit(op1, ctx, {}, key);
  assert.equal(replay.status, 200, 'same idempotency key returns the original event');
  assert.equal(replay.data.event.id, ok.data.event.id);
  assert.equal(replay.data.replayed, true);
  const reuse = await submit(op1, ctx, {}, crypto.randomUUID());
  assert.equal(reuse.status, 409);
  assert.equal(reuse.data.error, 'CHALLENGE_USED');
  // A challenge is bound to its user and session.
  const other = await op2.post('/api/inspections', {});
  const cross = await op2.post(`/api/inspections/${other.data.session.id}/submit`, { challenge_id: ctx.challenge.id }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.ok([404, 409].includes(cross.status));
});

test('8. gallery uploads, non-video files and manual QR entry are refused in the normal flow', async () => {
  const r = await register(admin, 'SN-8001');
  const id = r.data.cylinder.id;
  const s = await op1.post('/api/inspections', {});
  const manual = await op1.post(`/api/inspections/${s.data.session.id}/scan`, { qr_text: `${base}/c/${activeToken(id)}`, scan_method: 'manual_entry' });
  assert.equal(manual.status, 422);
  assert.equal(manual.data.error, 'LIVE_SCAN_REQUIRED');
  const ctx = await startInspection(op1, id);
  const gallery = await uploadClip(op1, ctx, { source: 'gallery' });
  assert.equal(gallery.status, 422);
  assert.equal(gallery.data.error, 'LIVE_CAPTURE_REQUIRED');
  const photo = await uploadClip(op1, ctx, { clip: new Blob([await tinyPng(), crypto.randomBytes(2000)], { type: 'image/png' }) });
  assert.equal(photo.status, 422);
  assert.equal(photo.data.error, 'VIDEO_REQUIRED');
  const noClip = await submit(op1, ctx);
  assert.equal(noClip.data.error, 'EVIDENCE_REQUIRED');
  // The inspection UI offers no file picker or manual QR field.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const wizardSrc = src.slice(src.indexOf('// ---------- controlled inspection wizard'), src.indexOf('// Damaged-label exception'));
  assert.ok(wizardSrc.length > 1000);
  assert.ok(!/type="file"/.test(wizardSrc), 'no file input in the inspection wizard');
  assert.ok(!/name="qr|qr_text.*input/i.test(wizardSrc), 'no manual QR entry field');
  // Honest limit: the server cannot prove a clip came from the camera. A
  // modified client could send prerecorded bytes labelled live_camera_recorder;
  // identical files are flagged and every clip is reviewable.
});

test('9. a QR photographed / shown on another phone still decodes; evidence review catches it and rejection leaves the approved location unchanged', async () => {
  const r = await register(admin, 'SN-9001');
  const id = r.data.cylinder.id;
  const first = await fullInspection(op1, id);
  assert.equal(first.res.status, 201);
  const approvedBefore = first.res.data.event.id;

  // Simulate a photo of the label displayed on another phone: QR rendered
  // with a dark "bezel", grey background, reduced contrast and noise.
  const url = `${base}/c/${activeToken(id)}`;
  const qr = QRCode.create(url, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size; const scale = 6; const pad = 40; const W = n * scale + pad * 2;
  const rgba = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const inBezel = x < 12 || y < 12 || x >= W - 12 || y >= W - 12;
    const mx = Math.floor((x - pad) / scale); const my = Math.floor((y - pad) / scale);
    const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx);
    const v = inBezel ? 15 : (dark ? 60 : 200) + Math.round((Math.random() - 0.5) * 30);
    const i = (y * W + x) * 4; rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v + 8; rgba[i + 3] = 255;
  }
  const decoded = jsQR(rgba, W, W);
  assert.ok(decoded, 'a screen/photo image of the QR decodes');
  assert.equal(decoded.data, url);

  // The server cannot distinguish this from a real scan. Submitted far from
  // the warehouse (where the cylinder actually is), it gets review signals.
  const ctx = await startInspection(op2, id, { qrText: decoded.data });
  await uploadClip(op2, ctx);
  const res = await submit(op2, ctx, { site_id: sites.bkk, location: freshLocation(UDN) });
  assert.equal(res.status, 201);
  const ev = res.data.event;
  const flagTypes = ev.flags.map((f) => f.flag_type);
  assert.ok(flagTypes.includes('out_of_geofence'), 'outside the selected site');
  assert.ok(flagTypes.includes('implausible_travel'), '~450 km in minutes');
  assert.equal(ev.verification_status, 'evidence_pending');
  // Supervisor reviews the clip and rejects it.
  const queue = await supervisor.get('/api/review/queue');
  assert.ok(queue.data.events.some((e) => e.id === ev.id));
  const rej = await supervisor.post(`/api/events/${ev.id}/review`, { decision: 'rejected', reason_code: 'screen_or_photo_suspected', notes: 'Clip shows a phone screen, not the cylinder.' });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.event.verification_status, 'rejected');
  const cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.last_approved.id, approvedBefore, 'rejected event did not replace the last approved location');
  assert.equal(cyl.latest_submitted.id, ev.id, 'latest submitted is tracked separately');
  assert.equal(cyl.last_approved.lat, BKK.lat);
});

test('10. damaged-label exception needs supervisor approval; replacement revokes the old QR', async () => {
  const r = await register(admin, 'SN-1010');
  const id = r.data.cylinder.id;
  const oldToken = activeToken(id);
  const ex = await op1.post('/api/exceptions/damaged-label', { cylinder_id: id });
  assert.equal(ex.status, 201);
  const ctx = { session: ex.data.session, challenge: ex.data.challenge };
  await uploadClip(op1, ctx);
  const res = await submit(op1, ctx, { condition: 'label_damaged', comments: 'QR label torn, unreadable', checklist: { ...ALL_CHECKED, qr_attached: false } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.event.verification_status, 'exception_pending');
  assert.equal(res.data.event.qr_verified, false);
  assert.equal(res.data.event.exception_kind, 'damaged_label');
  const own = await op1.post(`/api/events/${res.data.event.id}/review`, { decision: 'approved' });
  assert.equal(own.status, 403, 'operator cannot approve');
  const ok = await supervisor.post(`/api/events/${res.data.event.id}/review`, { decision: 'approved', notes: 'Serial visible in clip' });
  assert.equal(ok.data.event.verification_status, 'evidence_reviewed');
  const rep = await admin.post(`/api/cylinders/${id}/replace-label`, { reason: 'Damaged label (event approved)' });
  assert.equal(rep.status, 201);
  assert.notEqual(activeToken(id), oldToken);
  const old = await anon.get(`/api/public/qr/${oldToken}`);
  assert.equal(old.data.status, 'revoked');
  const s = await op1.post('/api/inspections', {});
  const scanOld = await op1.post(`/api/inspections/${s.data.session.id}/scan`, { qr_text: `${base}/c/${oldToken}`, scan_method: 'live_camera' });
  assert.equal(scanOld.status, 410);
  assert.equal(scanOld.data.error, 'QR_REVOKED');
  const prints = db.prepare('SELECT kind FROM label_prints WHERE cylinder_id = ?').all(id).map((x) => x.kind);
  assert.ok(prints.includes('replacement'));
});

test('11. dispatch creates "In transit"; destination receipt needs its own inspection', async () => {
  const r = await register(admin, 'SN-1111');
  const id = r.data.cylinder.id;
  const early = await fullInspection(op1, id, { event_type: 'customer_received', site_id: sites.udn, location: freshLocation(UDN) });
  assert.equal(early.res.status, 409);
  assert.equal(early.res.data.error, 'NOT_IN_TRANSIT');
  const d = await fullInspection(op1, id, { event_type: 'dispatched', destination_site_id: sites.udn, delivery_ref: 'DO-7788' });
  assert.equal(d.res.status, 201, JSON.stringify(d.res.data));
  let cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.movement_status, 'in_transit');
  assert.equal(cyl.destination_site.id, sites.udn);
  assert.equal(cyl.last_approved.site.id, sites.bkk, 'arrival is not assumed');
  const again = await fullInspection(op1, id, { event_type: 'dispatched', destination_site_id: sites.udn });
  assert.equal(again.res.data.error, 'ALREADY_IN_TRANSIT');
  const recv = await fullInspection(op2, id, { event_type: 'customer_received', site_id: sites.udn, location: freshLocation(UDN) });
  assert.equal(recv.res.status, 201, JSON.stringify(recv.res.data));
  assert.notEqual(recv.ctx.session.id, d.ctx.session.id);
  cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.movement_status, 'at_customer');
  assert.equal(cyl.latest_submitted.event_type, 'customer_received');
});

test('12. concurrent submissions: only one is applied, the other gets a conflict', async () => {
  const r = await register(admin, 'SN-1212');
  const id = r.data.cylinder.id;
  const a = await startInspection(op1, id);
  const b = await startInspection(op2, id);
  await uploadClip(op1, a);
  await uploadClip(op2, b);
  const [ra, rb] = await Promise.all([
    submit(op1, a, { event_type: 'dispatched', destination_site_id: sites.udn }),
    submit(op2, b, { event_type: 'maintenance' }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = ra.status === 409 ? ra : rb;
  assert.equal(loser.data.error, 'CONCURRENT_UPDATE');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE cylinder_id = ? AND event_type <> 'registered'").get(id).n, 1);
});

test('13. operators cannot alter audit history or approve exceptions', async () => {
  const r = await register(admin, 'SN-1313');
  const id = r.data.cylinder.id;
  const { res } = await fullInspection(op1, id, { condition: 'damaged', comments: 'Dent near the foot ring' });
  const evId = res.data.event.id;
  assert.equal(res.data.event.verification_status, 'evidence_pending');
  assert.equal((await op1.post(`/api/events/${evId}/review`, { decision: 'approved' })).status, 403);
  assert.equal((await op1.post(`/api/events/${evId}/correction`, { notes: 'change it' })).status, 403);
  assert.equal((await op1.req('PUT', `/api/events/${evId}`, { site_id: 2 })).status, 404);
  assert.equal((await op1.req('DELETE', `/api/events/${evId}`)).status, 404);
  assert.equal((await op1.get('/api/export/events.csv')).status, 403);
  assert.equal((await op1.req('PUT', '/api/admin/settings', { max_accuracy_m: 5000 })).status, 403);
  // Even direct SQL cannot rewrite history: append-only triggers.
  assert.throws(() => db.prepare('UPDATE events SET lat = 0 WHERE id = ?').run(evId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM events WHERE id = ?').run(evId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  // Supervisors cannot review their own submissions.
  const own = await fullInspection(supervisor, (await register(admin, 'SN-1314')).data.cylinder.id, { condition: 'needs_supervisor', comments: 'Valve looks bent' });
  assert.equal((await supervisor.post(`/api/events/${own.res.data.event.id}/review`, { decision: 'approved' })).status, 403);
  assert.equal((await supervisor2.post(`/api/events/${own.res.data.event.id}/review`, { decision: 'approved' })).status, 200);
  // Corrections append a new entry referencing the original.
  const corr = await supervisor.post(`/api/events/${evId}/correction`, { notes: 'Bay was B-02, not A-01', bay: 'B-02' });
  assert.equal(corr.status, 201);
  assert.equal(corr.data.event.corrects_event_id, evId);
  const original = db.prepare('SELECT bay FROM events WHERE id = ?').get(evId);
  assert.equal(original.bay, 'A-01', 'original entry unchanged');
});

test('14. problem reports require comments; review signals for repeats, identical media and custody', async () => {
  const r = await register(admin, 'SN-1414');
  const id = r.data.cylinder.id;
  const ctx = await startInspection(op1, id);
  const clip = fakeClip(5000);
  await uploadClip(op1, ctx, { clip });
  const noComment = await submit(op1, ctx, { condition: 'leaking' });
  assert.equal(noComment.data.error, 'COMMENTS_REQUIRED');
  const missingCheck = await submit(op1, ctx, { checklist: { ...ALL_CHECKED, beside_cylinder: false } });
  assert.equal(missingCheck.data.error, 'CHECKLIST_INCOMPLETE');
  const ok = await submit(op1, ctx, { condition: 'leaking', comments: 'Hissing at valve' });
  assert.equal(ok.status, 201);
  // Same clip bytes submitted again -> repeated_media; second scan in minutes -> repeated_scan.
  const ctx2 = await startInspection(op2, id);
  await uploadClip(op2, ctx2, { clip });
  const dup = await submit(op2, ctx2);
  const types = dup.data.event.flags.map((f) => f.flag_type);
  assert.ok(types.includes('repeated_media'));
  assert.ok(types.includes('repeated_scan'));
  assert.equal(dup.data.event.verification_status, 'evidence_pending');
  // Dashboard and CSV for authorised staff.
  const dash = await supervisor.get('/api/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.data.registered_count >= 10);
  assert.ok(dash.data.suspicious.length > 0);
  const csv = await admin.get('/api/export/cylinders.csv?gas_type=R-32');
  assert.equal(csv.status, 200);
  assert.ok(String(csv.data).includes('SN-1414'));
  const evCsv = await admin.get('/api/export/events.csv?flagged=1');
  assert.ok(String(evCsv.data).includes('repeated_media'));
});

test('15. NFC is an integration point only — no simulated success', async () => {
  const r = await register(admin, 'SN-1515');
  const s = await op1.post('/api/inspections', {});
  const n = await op1.post(`/api/inspections/${s.data.session.id}/nfc`, { message: 'anything' });
  assert.equal(n.status, 501);
  const bind = await admin.post(`/api/cylinders/${r.data.cylinder.id}/nfc`, { tag_uid: '04AABBCC' });
  assert.equal(bind.status, 501);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE nfc_status = 'authenticated'").get().n, 0);
});
