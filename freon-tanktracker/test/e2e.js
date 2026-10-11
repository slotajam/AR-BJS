// Browser end-to-end run (Chromium via Playwright) for Freon TankTracker.
//
// The phone camera is Chromium's fake capture device playing a video of the
// QR label (a picture, not a real cylinder) — so a successful scan also
// demonstrates that a QR shown on a screen still decodes. Geolocation comes
// from the browser context. SMS uses the development console provider; the
// page shows the "sent" message, which the test reads like a person would.
//
// Run: npm run test:e2e   (screenshots are written to test-output/)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const QRCode = require('qrcode');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');
const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'e2e-password-123';
const BKK = { latitude: 13.6684, longitude: 100.6045, accuracy: 15 };
const UDN = { latitude: 17.4138, longitude: 102.7872, accuracy: 15 };
const executablePath = process.env.CHROMIUM_PATH || findChromium();

function findChromium() {
  const dir = '/opt/pw-browsers';
  if (!fs.existsSync(dir)) return undefined;
  for (const d of fs.readdirSync(dir).filter((x) => x.startsWith('chromium-'))) {
    const p = path.join(dir, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

// Minimal API client for test setup (as the admin would do in the UI).
async function apiLogin(username) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TankTracker' }, body: JSON.stringify({ username, password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'TankTracker' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftt-e2e-'));
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), SEED_PASSWORD: PASSWORD, TILE_URL: '', SMS_PROVIDER: 'console', NODE_ENV: 'development' };
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/seed.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  await new Promise((r) => setTimeout(r, 1200));
  const results = [];
  const check = (name, cond) => { results.push([name, !!cond]); console.log(cond ? '  ✔' : '  ✘', name); };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

  try {
    // ---- Admin setup: register phone numbers, a customer contact, a cylinder.
    const adminApi = await apiLogin('admin');
    const users = (await adminApi('GET', '/api/admin/users')).users;
    const id = (u) => users.find((x) => x.username === u).id;
    await adminApi('PUT', `/api/admin/users/${id('operator1')}`, { phone: '081-111-0001' });
    await adminApi('PUT', `/api/admin/users/${id('supervisor')}`, { phone: '081-111-0003' });

    const browser0 = await chromium.launch({ executablePath });
    const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-GB' };
    const adminCtx = await browser0.newContext(mobile);
    const a = await adminCtx.newPage();
    await a.goto(BASE);
    await a.fill('input[name=username]', 'admin');
    await a.fill('input[name=password]', PASSWORD);
    await a.click('button[type=submit]');
    await a.waitForSelector('text=Register Cylinder');
    await a.click('text=Register Cylinder');
    const photo = path.join(dataDir, 'ref.png');
    await QRCode.toFile(photo, 'reference photo placeholder', { width: 300 });
    await a.fill('input[name=serial]', 'KX-778812');
    await a.fill('input[name=brand_owner]', 'BJC');
    await a.fill('input[name=gas_type]', 'R-32');
    await a.fill('input[name=size]', '9 kg');
    await a.fill('input[name=tare_kg]', '6.4');
    await a.selectOption('select[name=initial_site_id]', { label: 'Bangkok Main Warehouse' });
    await a.setInputFiles('input[name=photo_whole]', photo);
    await a.setInputFiles('input[name=photo_serial]', photo);
    await a.click('button[type=submit]');
    await a.waitForURL(/\/app\/cylinder\/FTT-000001/);
    check('admin registered a cylinder', true);
    await a.goto(`${BASE}/app/users`);
    await a.waitForSelector('text=Phone not verified');
    await shot(a, '01-admin-users-phones');
    const cyl = await adminApi('GET', '/api/cylinders/FTT-000001');
    const token = cyl.cylinder.qr_codes.find((q) => q.status === 'active').token;

    const qrPng = path.join(dataDir, 'qr.png');
    const y4m = path.join(dataDir, 'qr.y4m');
    await QRCode.toFile(qrPng, `${BASE}/c/${token}`, { width: 480, margin: 4 });
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', qrPng, '-vf', 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=white', '-t', '3', '-r', '15', '-pix_fmt', 'yuv420p', y4m]);
    await browser0.close();

    const browser = await chromium.launch({
      executablePath,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    });

    // ---- Operator verifies their own phone.
    const opCtx = await browser.newContext({ ...mobile, geolocation: BKK, permissions: ['geolocation', 'camera'] });
    const op = await opCtx.newPage();
    op.on('pageerror', (e) => console.error('page error:', e.message));
    await op.goto(BASE);
    await op.fill('input[name=username]', 'operator1');
    await op.fill('input[name=password]', PASSWORD);
    await op.click('button[type=submit]');
    await op.waitForSelector('text=Your mobile number is not verified.');
    await shot(op, '02-home-phone-not-verified');
    await op.click('a[href="/app/phone"] >> nth=0');
    await op.click('.vb-send');
    await op.waitForSelector('.vb-msg:has-text("Development SMS")');
    const msg = await op.textContent('.vb-msg');
    const vcode = /code (\d{4})/.exec(msg)[1];
    await op.fill('.vb-code', vcode);
    await shot(op, '03-verify-phone');
    await op.click('.vb-verify');
    await op.waitForSelector('text=Verified');
    check('operator verified phone with SMS code', true);

    // ---- Split-screen inspection.
    await op.goto(`${BASE}/app/inspect`);
    await op.waitForSelector('text=QR scanner locked');
    await op.waitForSelector('#lv-acc:has-text("±")');
    await op.waitForTimeout(3000);
    const stillLocked = (await op.textContent('#cam-overlay')).includes('QR scanner locked');
    check('QR in camera view is NOT decoded while location is unconfirmed', stillLocked);
    await shot(op, '04-split-locked');
    await op.waitForFunction(() => !document.querySelector('#loc-confirm').disabled);
    await op.click('#loc-confirm');
    await op.waitForSelector('text=Check that the engraved serial', { state: 'detached' }).catch(() => {});
    await op.waitForSelector('#det', { timeout: 20000 });
    check('after location confirmation the live camera decoded the QR (from a picture)', (await op.textContent('#cam-overlay')).includes('KX-778812'));
    await shot(op, '05-split-scanned-details');
    for (const cb of await op.$$('#det input[type=checkbox]')) await cb.check();
    await op.click('#det-submit');
    await op.waitForSelector('#code-in');
    await op.waitForSelector('#dev-sms:has-text("TankTracker code")');
    const smsText = await op.textContent('#dev-sms');
    const code = /code (\d{4})/.exec(smsText)[1];
    await shot(op, '06-sms-code');
    await op.fill('#code-in', code);
    await op.click('#code-ok');
    await op.waitForSelector('text=Event submitted');
    await shot(op, '07-recorded');
    check('event recorded only after the SMS code', (await op.textContent('#panel')).includes('Recorded'));

    // ---- Outside the site: confirm stays disabled, scanner stays locked.
    const outCtx = await browser.newContext({ ...mobile, geolocation: UDN, permissions: ['geolocation', 'camera'] });
    const out = await outCtx.newPage();
    await out.goto(BASE);
    await out.fill('input[name=username]', 'operator1');
    await out.fill('input[name=password]', PASSWORD);
    await out.click('button[type=submit]');
    await out.waitForSelector('text=Scan Cylinder');
    await out.goto(`${BASE}/app/inspect`);
    await out.waitForSelector('#loc-site');
    await out.selectOption('#loc-site', { label: 'Bangkok Main Warehouse' });
    await out.waitForSelector('#loc-hint:has-text("outside")');
    await out.waitForTimeout(1500);
    check('outside the site: confirm button disabled and scanner locked',
      (await out.$eval('#loc-confirm', (b) => b.disabled)) && (await out.textContent('#cam-overlay')).includes('locked'));
    await shot(out, '08-outside-site-locked');

    // ---- Supervisor review with the scan photo; audits; dashboard.
    const supCtx = await browser.newContext({ ...mobile });
    const sp = await supCtx.newPage();
    await sp.goto(BASE);
    await sp.fill('input[name=username]', 'admin');
    await sp.fill('input[name=password]', PASSWORD);
    await sp.click('button[type=submit]');
    await sp.goto(`${BASE}/app/event/2`);
    await sp.waitForSelector('img.snapshot');
    await sp.waitForFunction(() => { const i = document.querySelector('img.snapshot'); return i && i.complete && i.naturalWidth > 0; });
    check('reviewer sees the scan photo, timings and SMS confirmation', (await sp.textContent('main')).includes('Confirmed by operator phone'));
    await sp.screenshot({ path: path.join(OUT, '09-review-event.png'), fullPage: true });
    await sp.goto(`${BASE}/app/audits`);
    await sp.click('#gen');
    await sp.waitForSelector('text=Risk:');
    await shot(sp, '10-audits');
    check('random audit generated', true);

    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dk = await deskCtx.newPage();
    await dk.goto(BASE);
    await dk.fill('input[name=username]', 'admin');
    await dk.fill('input[name=password]', PASSWORD);
    await dk.click('button[type=submit]');
    await dk.goto(`${BASE}/app/dashboard`);
    await dk.waitForSelector('#cyl-table table');
    await dk.screenshot({ path: path.join(OUT, '11-dashboard.png'), fullPage: true });
    check('dashboard shows risk, audit and statement sections', (await dk.textContent('main')).includes('Risk summary'));

    // ---- Thai split screen.
    await op.goto(`${BASE}/app/inspect`);
    await op.waitForSelector('#loc-confirm');
    await op.click('#lang-toggle');
    await op.waitForSelector('text=เครื่องสแกน QR ถูกล็อก');
    await shot(op, '12-split-thai');
    check('Thai interface', true);

    await browser.close();
  } finally {
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed. Screenshots: ${OUT}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
