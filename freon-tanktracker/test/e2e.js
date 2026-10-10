// Browser end-to-end run with Chromium (Playwright).
//
// The phone camera is replaced by Chromium's fake capture device fed with a
// video of the QR label (a picture, not a real cylinder). That the scan
// succeeds is itself the demonstration required by the spec: a QR shown on
// a screen or photo decodes. Geolocation is supplied by the browser context.
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

// Reads the active QR token through the admin API.
async function adminToken(cylinderId) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TankTracker' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const c = await fetch(`${BASE}/api/cylinders/${cylinderId}`, { headers: { Cookie: cookie } }).then((x) => x.json());
  return c.cylinder.qr_codes.find((q) => q.status === 'active').token;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftt-e2e-'));
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), SEED_PASSWORD: PASSWORD, TILE_URL: '' };
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/seed.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1200));
  const results = [];
  const check = (name, cond) => { results.push([name, !!cond]); console.log(cond ? '  ✔' : '  ✘', name); };

  try {
    const browser0 = await chromium.launch({ executablePath });
    const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-GB' };

    // --- Admin registers a cylinder through the UI and prints its label.
    const adminCtx = await browser0.newContext(mobile);
    const a = await adminCtx.newPage();
    await a.goto(BASE);
    await a.fill('input[name=username]', 'admin');
    await a.fill('input[name=password]', PASSWORD);
    await a.click('button[type=submit]');
    await a.waitForSelector('text=Register Cylinder');
    await a.screenshot({ path: path.join(OUT, '01-home-admin.png'), fullPage: true });
    await a.click('text=Register Cylinder');
    const photo = path.join(dataDir, 'ref.png');
    await QRCode.toFile(photo, 'reference photo placeholder', { width: 300 });
    await a.fill('input[name=serial]', 'KX-778812');
    await a.fill('input[name=brand_owner]', 'BJC');
    await a.fill('input[name=gas_type]', 'R-32');
    await a.fill('input[name=size]', '9 kg');
    await a.fill('input[name=tare_kg]', '6.4');
    await a.selectOption('select[name=initial_site_id]', { label: 'Bangkok Main Warehouse' });
    await a.fill('input[name=initial_bay]', 'Rack A-03');
    await a.setInputFiles('input[name=photo_whole]', photo);
    await a.setInputFiles('input[name=photo_serial]', photo);
    await a.screenshot({ path: path.join(OUT, '02-register.png'), fullPage: true });
    await a.click('button[type=submit]');
    await a.waitForURL(/\/app\/cylinder\/FTT-000001/);
    check('admin registered cylinder through the UI', true);

    // Duplicate serial is rejected in the UI.
    await a.goto(`${BASE}/app/register`);
    await a.fill('input[name=serial]', 'kx-778812');
    await a.fill('input[name=brand_owner]', 'BJC');
    await a.fill('input[name=gas_type]', 'R-32');
    await a.fill('input[name=size]', '9 kg');
    await a.fill('input[name=tare_kg]', '6.4');
    await a.selectOption('select[name=initial_site_id]', { label: 'Bangkok Main Warehouse' });
    await a.setInputFiles('input[name=photo_whole]', photo);
    await a.setInputFiles('input[name=photo_serial]', photo);
    await a.click('button[type=submit]');
    await a.waitForSelector('.notice.bad');
    check('duplicate serial rejected in UI', (await a.textContent('.notice.bad')).includes('already registered'));

    // Label page.
    const popupP = a.context().waitForEvent('page');
    await a.goto(`${BASE}/app/cylinder/FTT-000001`);
    await a.click('#print-one');
    const label = await popupP;
    await label.waitForLoadState();
    await label.screenshot({ path: path.join(OUT, '03-label.png'), fullPage: true });
    const labelSvg = await label.$('.qr svg');
    check('label page shows QR, serial and ID', !!labelSvg && (await label.textContent('body')).includes('KX-778812'));
    const token = await adminToken('FTT-000001');

    // Fake camera: a looping video of the QR label image.
    const qrPng = path.join(dataDir, 'qr.png');
    const y4m = path.join(dataDir, 'qr.y4m');
    await QRCode.toFile(qrPng, `${BASE}/c/${token}`, { width: 480, margin: 4 });
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', qrPng, '-vf', 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=white', '-t', '3', '-r', '15', '-pix_fmt', 'yuv420p', y4m]);
    await browser0.close();

    const browser = await chromium.launch({
      executablePath,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    });

    // --- Normal phone-camera open of the QR URL (not logged in).
    const anonCtx = await browser.newContext(mobile);
    const anon = await anonCtx.newPage();
    await anon.goto(`${BASE}/c/${token}`);
    await anon.waitForSelector('text=does not record a location');
    await anon.screenshot({ path: path.join(OUT, '04-qr-landing.png'), fullPage: true });
    check('QR URL opens read-only landing page', (await anon.textContent('main')).includes('KX-778812'));

    // --- Operator: controlled inspection with live camera scan.
    const opCtx = await browser.newContext({ ...mobile, geolocation: BKK, permissions: ['geolocation', 'camera', 'microphone'] });
    const op = await opCtx.newPage();
    op.on('pageerror', (e) => console.error('page error:', e.message));
    await op.goto(BASE);
    await op.fill('input[name=username]', 'operator1');
    await op.fill('input[name=password]', PASSWORD);
    await op.click('button[type=submit]');
    await op.waitForSelector('text=Scan Cylinder');
    await op.screenshot({ path: path.join(OUT, '05-home-operator.png'), fullPage: true });
    await op.click('text=Scan Cylinder');
    await op.click('#go');
    await op.click('#req');
    await op.waitForSelector('text=Check that the engraved serial', { timeout: 20000 });
    check('live camera decoded the QR (from a picture of the label)', (await op.textContent('main')).includes('KX-778812'));
    await op.screenshot({ path: path.join(OUT, '06-confirm-cylinder.png'), fullPage: true });
    await op.click('#ok');
    await op.click('#acq');
    await op.waitForSelector('#fix-map');
    await op.screenshot({ path: path.join(OUT, '07-location.png'), fullPage: true });
    check('location fix meets pilot rules', (await op.textContent('main')).includes('meets the pilot rules'));
    await op.click('#cont');
    await op.waitForSelector('#rec-btn');
    await op.waitForTimeout(800);
    await op.click('#rec-btn');
    await op.waitForTimeout(1500);
    await op.screenshot({ path: path.join(OUT, '08-evidence-recording.png'), fullPage: true });
    await op.waitForTimeout(4000);
    await op.click('#rec-btn');
    await op.waitForSelector('#ck', { timeout: 20000 });
    check('evidence clip recorded in-app and uploaded', true);
    for (const cb of await op.$$('#ck input[type=checkbox]')) await cb.check();
    await op.screenshot({ path: path.join(OUT, '09-checklist.png'), fullPage: true });
    await op.click('#ck button[type=submit]');
    await op.click('#submit');
    await op.waitForSelector('text=Event submitted');
    await op.screenshot({ path: path.join(OUT, '10-submitted.png'), fullPage: true });
    check('inspection submitted as Recorded', (await op.textContent('main')).includes('Recorded'));

    // --- Location denied: normal submission blocked, exception offered.
    const deniedCtx = await browser.newContext({ ...mobile, permissions: ['camera', 'microphone'] });
    const dn = await deniedCtx.newPage();
    await dn.goto(BASE);
    await dn.fill('input[name=username]', 'operator2');
    await dn.fill('input[name=password]', PASSWORD);
    await dn.click('button[type=submit]');
    await dn.click('text=Scan Cylinder');
    await dn.click('#go');
    await dn.click('#req');
    await dn.waitForSelector('text=Location is blocked');
    await dn.screenshot({ path: path.join(OUT, '11-location-denied.png'), fullPage: true });
    await dn.click('#cont');
    await dn.waitForSelector('#ok', { timeout: 20000 });
    await dn.click('#ok');
    await dn.click('#acq');
    await dn.waitForSelector('#cont');
    await dn.click('#cont');
    await dn.waitForSelector('#rec-btn');
    await dn.click('#rec-btn');
    await dn.waitForTimeout(5000);
    await dn.click('#rec-btn');
    await dn.waitForSelector('#ck', { timeout: 20000 });
    for (const cb of await dn.$$('#ck input[type=checkbox]')) await cb.check();
    await dn.click('#ck button[type=submit]');
    await dn.click('#submit');
    await dn.waitForSelector('text=Normal submission blocked');
    await dn.screenshot({ path: path.join(OUT, '12-submission-blocked.png'), fullPage: true });
    check('location denied blocks normal submission', true);
    await dn.fill('#exc-reason', 'Location permission blocked on this phone');
    await dn.click('#exc');
    await dn.waitForSelector('text=Event submitted');
    check('exception submitted as Exception pending', (await dn.textContent('main')).includes('Exception pending'));

    // --- Supervisor review.
    const supCtx = await browser.newContext(mobile);
    const sp = await supCtx.newPage();
    await sp.goto(BASE);
    await sp.fill('input[name=username]', 'supervisor');
    await sp.fill('input[name=password]', PASSWORD);
    await sp.click('button[type=submit]');
    await sp.click('text=Review Queue');
    await sp.waitForSelector('.timeline a');
    await sp.screenshot({ path: path.join(OUT, '13-review-queue.png'), fullPage: true });
    await sp.click('.timeline a');
    await sp.waitForSelector('video.evidence');
    await sp.screenshot({ path: path.join(OUT, '14-review-event.png'), fullPage: true });
    await sp.selectOption('#rr', 'location_implausible');
    await sp.fill('#notes', 'No location; clip unclear.');
    await sp.click('#reject');
    await sp.waitForSelector('.pill.vs-rejected');
    check('supervisor rejected exception', true);

    // --- Dashboard (desktop width) and Thai UI.
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dk = await deskCtx.newPage();
    await dk.goto(BASE);
    await dk.fill('input[name=username]', 'admin');
    await dk.fill('input[name=password]', PASSWORD);
    await dk.click('button[type=submit]');
    await dk.goto(`${BASE}/app/dashboard`);
    await dk.waitForSelector('#cyl-table table');
    await dk.screenshot({ path: path.join(OUT, '15-dashboard.png'), fullPage: true });
    check('dashboard lists cylinder', (await dk.textContent('#cyl-table')).includes('KX-778812'));

    await op.goto(`${BASE}/app/cylinder/FTT-000001`);
    await op.waitForSelector('text=Last recorded location');
    await op.screenshot({ path: path.join(OUT, '16-cylinder-record.png'), fullPage: true });
    check('cylinder page never says "live location"', !/live location/i.test(await op.textContent('main')));
    await op.click('#lang-toggle');
    await op.waitForSelector('text=ตำแหน่งที่บันทึกล่าสุด');
    await op.screenshot({ path: path.join(OUT, '17-cylinder-thai.png'), fullPage: true });
    await op.goto(BASE);
    await op.waitForSelector('text=สแกนถัง');
    await op.screenshot({ path: path.join(OUT, '18-home-thai.png'), fullPage: true });
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
