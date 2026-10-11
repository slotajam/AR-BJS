// Acceptance tests for Freon TankTracker. Run: npm test
//
// Exercises the real HTTP API against a fresh database with the development
// "console" SMS provider: codes are read from its in-memory outbox, exactly
// as a person would read them from the phone. Browser behaviour (split
// screen, live camera, geolocation) is covered by test/e2e.js.
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
const { createSms } = require('../server/sms');

const PASSWORD = 'test-password-123';
let server; let base; let db; let dataDir; let outbox;
const sites = {};
const PHONES = { op1: '+66811110001', op2: '+66811110002', sup: '+66811110003', sup2: '+66811110004', admin: '+66811110005', udn: '+66899990001' };

const BKK = { lat: 13.6683, lng: 100.6044 };
const UDN = { lat: 17.4138, lng: 102.7872 };
const CNX = { lat: 18.7883, lng: 98.9853 };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { headers = {}, form } = {}) {
    const hd = { 'X-Requested-With': 'TankTracker', ...headers };
    if (this.cookie) hd.Cookie = this.cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { hd['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: hd, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b, o); }
  put(u, b) { return this.req('PUT', u, b); }
  async login(username) {
    const r = await this.post('/api/auth/login', { username, password: PASSWORD });
    assert.equal(r.status, 200, `login ${username}`);
    this.username = username;
    return this;
  }
}

const tinyPng = () => QRCode.toBuffer(crypto.randomBytes(8).toString('hex'), { type: 'png', width: 64 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setSetting = (admin, obj) => admin.put('/api/admin/settings', obj);

function lastCode(phone) {
  const m = [...outbox].reverse().find((x) => x.to === phone);
  assert.ok(m, `an SMS was sent to ${phone}`);
  return /code (\d{4})/.exec(m.text)[1];
}

function fix(point, { accuracy = 12, ageMs = 2000 } = {}) {
  const now = Date.now();
  return { lat: point.lat, lng: point.lng, accuracy_m: accuracy, fix_timestamp: new Date(now - ageMs).toISOString(), client_sent_at: new Date(now).toISOString() };
}

async function register(admin, serial, siteId = sites.bkk, tare = '6.5') {
  const fd = new FormData();
  Object.entries({ serial, brand_owner: 'BJC', gas_type: 'R-32', size: '9 kg', tare_kg: tare, initial_site_id: String(siteId), initial_bay: 'A-01', initial_condition: 'good' })
    .forEach(([k, v]) => fd.append(k, v));
  fd.append('photo_whole', new Blob([await tinyPng()], { type: 'image/png' }), 'whole.png');
  fd.append('photo_serial', new Blob([await tinyPng()], { type: 'image/png' }), 'serial.png');
  const r = await admin.post('/api/cylinders', undefined, { form: fd });
  return r;
}
const token = (cylId) => db.prepare("SELECT token FROM qr_codes WHERE cylinder_id = ? AND status = 'active'").get(cylId).token;
const ALL_CHECKED = { beside_cylinder: true, serial_matches: true, qr_attached: true, condition_checked: true, site_bay_correct: true };

async function start(client, body = {}) {
  const r = await client.post('/api/inspections', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.session.id;
}
const confirmLocation = (client, sid, siteId, point, opts) => client.post(`/api/inspections/${sid}/location`, { site_id: siteId, location: fix(point, opts) });
const scan = (client, sid, cylId, qrText) => client.post(`/api/inspections/${sid}/scan`, { qr_text: qrText || `${base}/c/${token(cylId)}`, scan_method: 'live_camera' });
async function snapshot(client, sid, source = 'live_camera_frame') {
  const fd = new FormData();
  fd.append('capture_source', source);
  fd.append('snapshot', new Blob([await tinyPng()], { type: 'image/png' }), 'frame.png');
  return client.post(`/api/inspections/${sid}/snapshot`, undefined, { form: fd });
}
const submit = (client, sid, overrides = {}, key = crypto.randomUUID()) => client.post(`/api/inspections/${sid}/submit`, {
  event_type: 'inspection', bay: 'A-01', condition: 'good', checklist: ALL_CHECKED, ...overrides,
}, { headers: { 'Idempotency-Key': key } });
const confirm = (client, sid, code) => client.post(`/api/inspections/${sid}/confirm-code`, { code });

// Full flow up to the pending SMS code.
async function upToCode(client, cylId, { siteId = sites.bkk, point = BKK, overrides = {}, qrText } = {}) {
  const sid = await start(client);
  const loc = await confirmLocation(client, sid, siteId, point);
  assert.equal(loc.status, 200, JSON.stringify(loc.data));
  const sc = await scan(client, sid, cylId, qrText);
  assert.equal(sc.status, 200, JSON.stringify(sc.data));
  assert.equal((await snapshot(client, sid)).status, 201);
  const sub = await submit(client, sid, overrides);
  return { sid, sub };
}
async function full(client, cylId, opts = {}) {
  const { sid, sub } = await upToCode(client, cylId, opts);
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const phone = opts.codePhone || PHONES[client.username];
  const res = await confirm(client, sid, lastCode(phone));
  return { sid, sub, res };
}

let admin; let sup; let sup2; let op1; let op2; let op3; let anon; let built;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftt-test-'));
  built = createApp({ dataDir, tileUrl: '', env: { SMS_PROVIDER: 'console' } });
  db = built.db;
  outbox = built.sms.outbox;
  const now = new Date().toISOString();
  for (const [u, role] of [['admin', 'admin'], ['sup', 'supervisor'], ['sup2', 'supervisor'], ['op1', 'operator'], ['op2', 'operator'], ['op3', 'operator']]) {
    db.prepare('INSERT INTO users (username, display_name, password_hash, role, phone_e164, phone_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(u, u.toUpperCase(), hashPassword(PASSWORD), role, PHONES[u] || null, PHONES[u] ? now : null, now);
  }
  const ins = db.prepare('INSERT INTO sites (code, name, kind, customer_name, lat, lng, radius_m, contact_phone_e164, contact_phone_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  sites.bkk = Number(ins.run('WH-BKK', 'Bangkok WH', 'warehouse', null, BKK.lat, BKK.lng, 250, null, null, now).lastInsertRowid);
  sites.udn = Number(ins.run('CU-UDN', 'Udon Customer', 'customer', 'Udon Cool Co.', UDN.lat, UDN.lng, 150, PHONES.udn, now, now).lastInsertRowid);
  sites.cnx = Number(ins.run('CU-CNX', 'Chiang Mai Customer', 'customer', 'CNX Air', CNX.lat, CNX.lng, 150, null, null, now).lastInsertRowid);
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await new Client().login('admin');
  sup = await new Client().login('sup');
  sup2 = await new Client().login('sup2');
  op1 = await new Client().login('op1');
  op2 = await new Client().login('op2');
  op3 = await new Client().login('op3');
  anon = new Client();
  await setSetting(admin, { audits_per_week: 0, holdings_statement_days: 0 });
});

test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('01 registration and duplicate-serial rejection', async () => {
  const r = await register(admin, 'SN-1001');
  assert.equal(r.status, 201);
  assert.match(r.data.cylinder.id, /^FTT-\d{6}$/);
  assert.equal((await register(admin, 'sn-1001')).data.error, 'DUPLICATE_SERIAL');
  assert.equal((await register(op1, 'SN-OP')).status, 403);
});

test('02 opaque QR label and read-only QR landing page', async () => {
  const id = (await register(admin, 'SN-2001')).data.cylinder.id;
  const tk = token(id);
  assert.ok(!tk.includes(id) && !tk.includes('SN-2001'));
  const p = await admin.post('/api/labels/print', { cylinder_ids: [id] });
  const page = await admin.get(p.data.url);
  for (const s of ['BJC Cylinder Tracker', 'SN-2001', id, 'Scan to record inspection / movement']) assert.ok(page.data.includes(s));
  const before = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  assert.equal((await anon.get(`/c/${tk}`)).status, 200);
  assert.equal((await anon.get(`/api/public/qr/${tk}`)).data.status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, before, 'opening the QR URL writes nothing');
});

test('03 operator without a verified phone cannot start; phone verification; changing the number clears it', async () => {
  const r = await op3.post('/api/inspections', {});
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'PHONE_NOT_VERIFIED');
  const users = (await admin.get('/api/admin/users')).data.users;
  const op3id = users.find((u) => u.username === 'op3').id;
  assert.equal((await admin.put(`/api/admin/users/${op3id}`, { phone: '081-234-5678' })).status, 200);
  assert.equal(db.prepare('SELECT phone_e164 FROM users WHERE id = ?').get(op3id).phone_e164, '+66812345678');
  assert.equal((await op3.post('/api/me/phone/send-code', {})).status, 200);
  assert.equal((await op3.post('/api/me/phone/verify', { code: '0000' === lastCode('+66812345678') ? '1111' : '0000' })).data.error, 'CODE_WRONG');
  const ok = await op3.post('/api/me/phone/verify', { code: lastCode('+66812345678') });
  assert.equal(ok.status, 200);
  assert.equal((await op3.get('/api/me/phone')).data.verified, true);
  assert.equal((await op3.post('/api/inspections', {})).status, 201);
  await admin.put(`/api/admin/users/${op3id}`, { phone: '0899998888' });
  assert.equal((await op3.get('/api/me/phone')).data.verified, false, 'new number must be verified again');
  assert.equal((await op3.post('/api/inspections', {})).data.error, 'PHONE_NOT_VERIFIED');
  const dup = await admin.put(`/api/admin/users/${op3id}`, { phone: PHONES.op1 });
  assert.equal(dup.data.error, 'PHONE_TAKEN');
});

test('04 scanning before location confirmation is refused', async () => {
  const id = (await register(admin, 'SN-4001')).data.cylinder.id;
  const sid = await start(op1);
  const r = await scan(op1, sid, id);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'LOCATION_NOT_CONFIRMED');
  const sub = await submit(op1, sid);
  assert.ok([409].includes(sub.status));
});

test('05 stale, inaccurate and outside-site locations are not confirmed; exception path is never location-verified', async () => {
  const id = (await register(admin, 'SN-5001')).data.cylinder.id;
  const sid = await start(op1);
  assert.equal((await confirmLocation(op1, sid, sites.bkk, BKK, { ageMs: 45000 })).data.error, 'LOCATION_STALE');
  assert.equal((await confirmLocation(op1, sid, sites.bkk, BKK, { accuracy: 120 })).data.error, 'LOCATION_INACCURATE');
  const out = await confirmLocation(op1, sid, sites.bkk, UDN);
  assert.equal(out.data.error, 'OUTSIDE_SITE');
  assert.equal(out.data.exception_allowed, true);
  assert.equal((await scan(op1, sid, id)).data.error, 'LOCATION_NOT_CONFIRMED');
  const ex = await op1.post(`/api/inspections/${sid}/location-exception`, { site_id: sites.bkk, reason: 'GPS not working inside the steel warehouse', location: fix(UDN) });
  assert.equal(ex.status, 200);
  assert.equal((await scan(op1, sid, id)).status, 200, 'exception unlocks the scan');
  await snapshot(op1, sid);
  assert.equal((await submit(op1, sid)).status, 201);
  const res = await confirm(op1, sid, lastCode(PHONES.op1));
  assert.equal(res.status, 201);
  assert.equal(res.data.event.verification_status, 'exception_pending');
  assert.equal(res.data.event.location_status, 'not_verified');
  const cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.last_approved.event_type, 'registered');
});

test('06 location confirmation expires and re-locks the scanner', async () => {
  const id = (await register(admin, 'SN-6001')).data.cylinder.id;
  await setSetting(admin, { location_lock_s: 1 });
  const sid = await start(op1);
  assert.equal((await confirmLocation(op1, sid, sites.bkk, BKK)).status, 200);
  await sleep(1300);
  assert.equal((await scan(op1, sid, id)).data.error, 'LOCATION_NOT_CONFIRMED');
  await setSetting(admin, { location_lock_s: 120 });
  assert.equal((await confirmLocation(op1, sid, sites.bkk, BKK)).status, 200);
  assert.equal((await scan(op1, sid, id)).status, 200);
});

test('07 successful flow: event is written only after the SMS code is confirmed', async () => {
  const id = (await register(admin, 'SN-7001')).data.cylinder.id;
  const { sid, sub } = await upToCode(op1, id);
  assert.equal(sub.status, 201);
  assert.equal(sub.data.pending.recipient, 'operator');
  assert.equal(sub.data.pending.phone_masked, '+66 8x-xxx-0001');
  let cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.latest_submitted.event_type, 'registered', 'nothing applied before the code');
  const res = await confirm(op1, sid, lastCode(PHONES.op1));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const ev = res.data.event;
  assert.equal(ev.verification_status, 'recorded');
  assert.equal(ev.location_status, 'verified');
  assert.equal(ev.geofence_result, 'inside');
  assert.ok(ev.snapshot_id);
  assert.ok(ev.sms_verified_at);
  cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.last_approved.id, ev.id);
  const replay = await confirm(op1, sid, '0000');
  assert.equal(replay.data.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE cylinder_id = ? AND event_type <> 'registered'").get(id).n, 1);
});

test('08 wrong code x5 burns it; expired code leaves the cylinder unchanged; resend limits', async () => {
  const id = (await register(admin, 'SN-8001')).data.cylinder.id;
  const { sid } = await upToCode(op1, id);
  const real = lastCode(PHONES.op1);
  const wrong = real === '1234' ? '4321' : '1234';
  for (let i = 1; i <= 4; i++) assert.equal((await confirm(op1, sid, wrong)).data.error, 'CODE_WRONG');
  assert.equal((await confirm(op1, sid, wrong)).data.error, 'CODE_BURNED');
  assert.equal((await confirm(op1, sid, real)).data.error, 'CODE_BURNED', 'burned code cannot be used');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'sms_code_burned' AND entity_id = ?").get(id));

  await setSetting(admin, { sms_code_ttl_s: 1 });
  const id2 = (await register(admin, 'SN-8002')).data.cylinder.id;
  const s2 = await upToCode(op1, id2);
  await setSetting(admin, { sms_code_ttl_s: 300 });
  await sleep(1300);
  assert.equal((await confirm(op1, s2.sid, lastCode(PHONES.op1))).data.error, 'CODE_EXPIRED');
  assert.equal((await admin.get(`/api/cylinders/${id2}`)).data.cylinder.latest_submitted.event_type, 'registered');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'sms_unconfirmed' AND entity_id = ?").get(id2));

  const id3 = (await register(admin, 'SN-8003')).data.cylinder.id;
  const s3 = await upToCode(op1, id3);
  assert.equal((await op1.post(`/api/inspections/${s3.sid}/resend-code`, {})).data.error, 'RESEND_COOLDOWN');
  await setSetting(admin, { sms_resend_cooldown_s: 0 });
  assert.equal((await op1.post(`/api/inspections/${s3.sid}/resend-code`, {})).status, 200);
  assert.equal((await op1.post(`/api/inspections/${s3.sid}/resend-code`, {})).status, 200);
  assert.equal((await op1.post(`/api/inspections/${s3.sid}/resend-code`, {})).data.error, 'RESEND_LIMIT');
  await setSetting(admin, { sms_resend_cooldown_s: 60 });
  const res = await confirm(op1, s3.sid, lastCode(PHONES.op1));
  assert.equal(res.status, 201, 'only the latest code works');
});

test('09 gallery images, manual QR entry and missing scan photo are refused; photo can be switched off', async () => {
  const id = (await register(admin, 'SN-9001')).data.cylinder.id;
  const sid = await start(op1);
  await confirmLocation(op1, sid, sites.bkk, BKK);
  assert.equal((await op1.post(`/api/inspections/${sid}/scan`, { qr_text: `${base}/c/${token(id)}`, scan_method: 'manual_entry' })).data.error, 'LIVE_SCAN_REQUIRED');
  assert.equal((await scan(op1, sid, id)).status, 200);
  assert.equal((await snapshot(op1, sid, 'gallery')).data.error, 'LIVE_CAPTURE_REQUIRED');
  assert.equal((await submit(op1, sid)).data.error, 'SNAPSHOT_REQUIRED');
  await setSetting(admin, { auto_snapshot_on_scan: 0 });
  assert.equal((await submit(op1, sid)).status, 201);
  await setSetting(admin, { auto_snapshot_on_scan: 1 });
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const scanSrc = src.slice(src.indexOf('// ---------- split-screen inspection'), src.indexOf('// ---------- end split-screen inspection'));
  assert.ok(scanSrc.length > 1000, 'split-screen section found');
  assert.ok(!/type="file"/.test(scanSrc), 'no file input on the scanning page');
});

test('10 a QR photo on another screen still decodes; review signals flag it; rejection keeps the approved location', async () => {
  const id = (await register(admin, 'SN-1010')).data.cylinder.id;
  const first = await full(op1, id);
  assert.equal(first.res.status, 201);
  const url = `${base}/c/${token(id)}`;
  const qr = QRCode.create(url, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size; const scale = 6; const pad = 40; const W = n * scale + pad * 2;
  const rgba = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const bezel = x < 12 || y < 12 || x >= W - 12 || y >= W - 12;
    const mx = Math.floor((x - pad) / scale); const my = Math.floor((y - pad) / scale);
    const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx);
    const v = bezel ? 15 : (dark ? 60 : 200) + Math.round((Math.random() - 0.5) * 30);
    const i = (y * W + x) * 4; rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v + 8; rgba[i + 3] = 255;
  }
  const decoded = jsQR(rgba, W, W);
  assert.equal(decoded.data, url, 'photo of the QR decodes');
  // Someone at a customer site 450 km away scans the photo, with a real location there.
  const r = await full(op2, id, { siteId: sites.udn, point: UDN, qrText: decoded.data });
  const ev = r.res.data.event;
  const types = ev.flags.map((f) => f.flag_type);
  assert.ok(types.includes('implausible_travel'));
  assert.ok(types.includes('unexpected_custody'));
  assert.equal(ev.verification_status, 'evidence_pending');
  const rej = await sup.post(`/api/events/${ev.id}/review`, { decision: 'rejected', reason_code: 'screen_or_photo_suspected', notes: 'Snapshot shows a phone screen.' });
  assert.equal(rej.data.event.verification_status, 'rejected');
  const cyl = (await admin.get(`/api/cylinders/${id}`)).data.cylinder;
  assert.equal(cyl.last_approved.id, first.res.data.event.id);
  assert.equal(cyl.latest_submitted.id, ev.id);
});

test('11 dispatch needs weight; receipt needs its own inspection; customer code goes to the site contact phone', async () => {
  const id = (await register(admin, 'SN-1111')).data.cylinder.id;
  const early = await upToCode(op1, id, { siteId: sites.udn, point: UDN, overrides: { event_type: 'customer_received' } });
  assert.equal(early.sub.data.error, 'NOT_IN_TRANSIT');
  const noWeight = await upToCode(op1, id, { overrides: { event_type: 'dispatched', destination_site_id: sites.udn } });
  assert.equal(noWeight.sub.data.error, 'WEIGHT_REQUIRED');
  const d = await full(op1, id, { overrides: { event_type: 'dispatched', destination_site_id: sites.udn, gross_weight_kg: 15.5 } });
  assert.equal(d.res.status, 201, JSON.stringify(d.res.data));
  assert.equal(d.res.data.event.net_content_kg, 9);
  assert.equal((await admin.get(`/api/cylinders/${id}`)).data.cylinder.movement_status, 'in_transit');
  const recv = await upToCode(op2, id, { siteId: sites.udn, point: UDN, overrides: { event_type: 'customer_received' } });
  assert.equal(recv.sub.data.pending.recipient, 'site_contact');
  assert.equal(recv.sub.data.pending.phone_masked, '+66 8x-xxx-0001');
  assert.equal((await confirm(op2, recv.sid, lastCode(PHONES.op2) || '0000')).status === 201, false, 'driver\'s own code is not valid');
  const ok = await confirm(op2, recv.sid, lastCode(PHONES.udn));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.event.sms_recipient, 'site_contact');
  assert.ok(!ok.data.event.flags.some((f) => f.flag_type === 'no_customer_confirmation'));
  assert.equal((await admin.get(`/api/cylinders/${id}`)).data.cylinder.movement_status, 'at_customer');
  // Site without a verified contact phone: operator's code, flagged.
  const id2 = (await register(admin, 'SN-1112')).data.cylinder.id;
  await full(op1, id2, { overrides: { event_type: 'dispatched', destination_site_id: sites.cnx, gross_weight_kg: 15.5 } });
  const r2 = await full(op2, id2, { siteId: sites.cnx, point: CNX, overrides: { event_type: 'customer_received' } });
  assert.ok(r2.res.data.event.flags.some((f) => f.flag_type === 'no_customer_confirmation'));
});

test('12 weighing signals: below tare, returned unused, weight gain, self-weighed return', async () => {
  await setSetting(admin, { unused_after_days: 0 });
  const id = (await register(admin, 'SN-1212')).data.cylinder.id;
  await full(op1, id, { overrides: { event_type: 'dispatched', destination_site_id: sites.cnx, gross_weight_kg: 15.5 } });
  await full(op2, id, { siteId: sites.cnx, point: CNX, overrides: { event_type: 'customer_received' } });
  const back = await full(op2, id, { overrides: { event_type: 'empty_returned', gross_weight_kg: 15.5 } });
  const t1 = back.res.data.event.flags.map((f) => f.flag_type);
  assert.ok(t1.includes('returned_unused'), JSON.stringify(t1));
  assert.ok(t1.includes('self_weighed_return'));
  const id2 = (await register(admin, 'SN-1213')).data.cylinder.id;
  await full(op1, id2, { overrides: { event_type: 'dispatched', destination_site_id: sites.cnx, gross_weight_kg: 10 } });
  await full(op2, id2, { siteId: sites.cnx, point: CNX, overrides: { event_type: 'customer_received' } });
  const gain = await full(op1, id2, { overrides: { event_type: 'empty_returned', gross_weight_kg: 14 } });
  assert.ok(gain.res.data.event.flags.some((f) => f.flag_type === 'weight_gain'));
  const id3 = (await register(admin, 'SN-1214')).data.cylinder.id;
  const low = await full(op1, id3, { overrides: { event_type: 'warehouse_received', gross_weight_kg: 3 } });
  assert.ok(low.res.data.event.flags.some((f) => f.flag_type === 'weight_below_tare'));
  await setSetting(admin, { unused_after_days: 7 });
});

test('13 concurrent submissions: only one is applied', async () => {
  const id = (await register(admin, 'SN-1313')).data.cylinder.id;
  const a = await upToCode(op1, id, { overrides: { event_type: 'maintenance' } });
  const b = await upToCode(op2, id, { overrides: { event_type: 'maintenance' } });
  const codeA = lastCode(PHONES.op1); const codeB = lastCode(PHONES.op2);
  const [ra, rb] = await Promise.all([confirm(op1, a.sid, codeA), confirm(op2, b.sid, codeB)]);
  assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
  assert.equal((ra.status === 409 ? ra : rb).data.error, 'CONCURRENT_UPDATE');
});

test('14 random audits: risk-weighted, independent auditor, hidden from operators, not-found flags the chain', async () => {
  const id = (await register(admin, 'SN-1414')).data.cylinder.id;
  await full(op1, id, { overrides: { event_type: 'dispatched', destination_site_id: sites.cnx, gross_weight_kg: 15 } });
  await full(sup, id, { siteId: sites.cnx, point: CNX, overrides: { event_type: 'customer_received' } });
  assert.equal((await op1.get('/api/audits')).status, 403, 'operators cannot list audit tasks');
  const gen = await admin.post('/api/audits/generate', { count: 50 });
  assert.equal(gen.status, 201);
  const a = gen.data.audits.find((x) => x.cylinder_id === id);
  assert.ok(a, 'cylinder selected');
  assert.notEqual(a.assigned_to, db.prepare("SELECT id FROM users WHERE username = 'sup'").get().id, 'last mover is not the auditor');
  const supId = db.prepare("SELECT id FROM users WHERE username = 'sup'").get().id;
  assert.equal((await admin.post(`/api/audits/${a.id}/assign`, { user_id: supId })).data.error, 'NOT_INDEPENDENT');
  const sup2Id = db.prepare("SELECT id FROM users WHERE username = 'sup2'").get().id;
  assert.equal((await admin.post(`/api/audits/${a.id}/assign`, { user_id: sup2Id })).status, 200);
  assert.equal((await sup.post(`/api/audits/${a.id}/not-found`, { comments: 'trying' })).data.error, 'AUDIT_NOT_ASSIGNED');
  const nf = await sup2.post(`/api/audits/${a.id}/not-found`, { comments: 'Not at the customer, staff had no record.' });
  assert.equal(nf.status, 200, JSON.stringify(nf.data));
  assert.ok(nf.data.flagged >= 3);
  assert.equal((await admin.get(`/api/cylinders/${id}`)).data.cylinder.movement_status, 'missing');
  // Audit performed in person: found OK.
  const id2 = (await register(admin, 'SN-1415')).data.cylinder.id;
  const g2 = await admin.post('/api/audits/generate', { count: 50 });
  const a2 = g2.data.audits.find((x) => x.cylinder_id === id2);
  await admin.post(`/api/audits/${a2.id}/assign`, { user_id: sup2Id });
  const sid = await start(sup2, { audit_id: a2.id });
  await confirmLocation(sup2, sid, sites.bkk, BKK);
  await scan(sup2, sid, id2);
  await snapshot(sup2, sid);
  assert.equal((await submit(sup2, sid)).data.error, 'AUDIT_OUTCOME_REQUIRED');
  assert.equal((await submit(sup2, sid, { audit_outcome: 'found_ok' })).status, 201);
  const done = await confirm(sup2, sid, lastCode(PHONES.sup2));
  assert.equal(done.data.event.audit_outcome, 'found_ok');
  assert.equal(db.prepare('SELECT status, outcome FROM audits WHERE id = ?').get(a2.id).outcome, 'found_ok');
});

test('15 customer holdings statement: single-use, expiring link; dispute needs comments', async () => {
  const gen = await admin.post('/api/statements/generate', {});
  assert.equal(gen.status, 201);
  assert.ok(gen.data.sent.some((s) => s.site === 'Udon Customer'));
  assert.ok(gen.data.skipped.some((s) => s.site === 'Chiang Mai Customer'));
  const msg = [...outbox].reverse().find((m) => m.to === PHONES.udn && m.text.includes('/s/'));
  const tk = /\/s\/([A-Za-z0-9_-]+)/.exec(msg.text)[1];
  const view = await anon.get(`/api/public/statement/${tk}`);
  assert.equal(view.data.site_name, 'Udon Customer');
  assert.ok(view.data.cylinders.includes('SN-1111'));
  assert.equal((await anon.post(`/api/public/statement/${tk}`, { response: 'dispute' })).data.error, 'COMMENTS_REQUIRED');
  assert.equal((await anon.post(`/api/public/statement/${tk}`, { response: 'dispute', comments: 'We only have 0 cylinders' })).status, 200);
  assert.equal((await anon.post(`/api/public/statement/${tk}`, { response: 'confirm' })).data.error, 'ALREADY_ANSWERED');
  assert.equal((await anon.get('/api/public/statement/not-a-real-token')).status, 404);
  const dash = await sup.get('/api/dashboard');
  assert.ok(dash.data.statement_followups.some((s) => s.response === 'disputed'));
});

test('16 driver/customer pair concentration is flagged', async () => {
  await setSetting(admin, { pair_min_events: 2, pair_concentration_pct: 60 });
  let last;
  for (const sn of ['SN-1601', 'SN-1602']) {
    const id = (await register(admin, sn)).data.cylinder.id;
    await full(op1, id, { overrides: { event_type: 'dispatched', destination_site_id: sites.cnx, gross_weight_kg: 15 } });
    last = await full(op2, id, { siteId: sites.cnx, point: CNX, overrides: { event_type: 'customer_received' } });
  }
  assert.ok(last.res.data.event.flags.some((f) => f.flag_type === 'driver_customer_pair_concentration'));
  await setSetting(admin, { pair_min_events: 5, pair_concentration_pct: 70 });
  const dash = await sup.get('/api/dashboard');
  assert.ok(dash.data.risk.drivers.length > 0);
});

test('17 operators cannot alter audit history or approve', async () => {
  const id = (await register(admin, 'SN-1717')).data.cylinder.id;
  const { res } = await full(op1, id, { overrides: { condition: 'damaged', comments: 'Dent near the foot ring' } });
  const evId = res.data.event.id;
  assert.equal((await op1.post(`/api/events/${evId}/review`, { decision: 'approved' })).status, 403);
  assert.equal((await op1.post(`/api/events/${evId}/correction`, { notes: 'change it' })).status, 403);
  assert.equal((await op1.req('PUT', `/api/events/${evId}`, {})).status, 404);
  assert.throws(() => db.prepare('UPDATE events SET lat = 0 WHERE id = ?').run(evId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  const own = await full(sup, (await register(admin, 'SN-1718')).data.cylinder.id, { overrides: { condition: 'needs_supervisor', comments: 'Valve looks bent' } });
  assert.equal((await sup.post(`/api/events/${own.res.data.event.id}/review`, { decision: 'approved' })).status, 403);
  assert.equal((await sup2.post(`/api/events/${own.res.data.event.id}/review`, { decision: 'approved' })).status, 200);
});

test('18 SMS provider rules: console refused in production; no provider -> 503, never a fake success', async () => {
  assert.throws(() => createSms({ NODE_ENV: 'production', SMS_PROVIDER: 'console' }), /not allowed/);
  assert.equal(createSms({ NODE_ENV: 'production' }).name, 'none');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftt-none-'));
  const b = createApp({ dataDir: dir, tileUrl: '', env: { NODE_ENV: 'production' } });
  const now = new Date().toISOString();
  b.db.prepare("INSERT INTO users (username, display_name, password_hash, role, phone_e164, phone_verified_at, created_at) VALUES ('x', 'X', ?, 'operator', '+66800000000', ?, ?)").run(hashPassword(PASSWORD), now, now);
  const srv = await new Promise((r) => { const s = b.app.listen(0, '127.0.0.1', () => r(s)); });
  const saved = base; base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const c = await new Client().login('x');
    const r = await c.post('/api/inspections', {});
    assert.equal(r.status, 503);
    assert.equal(r.data.error, 'SMS_NOT_CONFIGURED');
    assert.equal((await c.get('/api/dev/sms-outbox')).status, 404);
  } finally { base = saved; srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('19 NFC stays an integration point — no simulated success', async () => {
  const id = (await register(admin, 'SN-1919')).data.cylinder.id;
  const sid = await start(op1);
  assert.equal((await op1.post(`/api/inspections/${sid}/nfc`, {})).status, 501);
  assert.equal((await admin.post(`/api/cylinders/${id}/nfc`, {})).status, 501);
});
