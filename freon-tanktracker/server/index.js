// Starts Freon TankTracker. Camera and geolocation need a secure context:
// serve over HTTPS (TLS_CERT/TLS_KEY, or a TLS reverse proxy) except on localhost.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { createApp } = require('./app');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.PORT || 3000);
const { app, runRetention, ctx, sms } = createApp({
  dataDir,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  tileUrl: process.env.TILE_URL ?? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
});

let server;
if (process.env.TLS_CERT && process.env.TLS_KEY) {
  server = https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, app);
} else {
  server = http.createServer(app);
}
server.listen(port, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`Freon TankTracker listening on ${proto}://localhost:${port}  (data: ${dataDir})`);
  if (!process.env.PUBLIC_BASE_URL) console.log('PUBLIC_BASE_URL not set: QR labels will use the address the admin browser used.');
  if (sms.isDev) console.log('SMS: DEVELOPMENT console provider – codes are printed here and NOT sent to real phones.');
  else if (sms.unavailable) console.log('SMS: no provider configured – inspections will be refused (503) until SMS_PROVIDER is set.');
  else console.log(`SMS: provider ${sms.name}`);
});

// Daily jobs: evidence retention, random audit selection and customer
// holdings statements (statements need PUBLIC_BASE_URL for the SMS link).
const daily = async () => {
  try {
    const n = runRetention(); if (n) console.log(`retention: purged ${n} evidence file(s)`);
    const a = ctx.autoGenerateAudits(); if (a.length) console.log(`audits: ${a.length} random audit task(s) created`);
    if (process.env.PUBLIC_BASE_URL) {
      const r = await ctx.autoGenerateStatements(process.env.PUBLIC_BASE_URL.replace(/\/$/, ''));
      if (r) console.log(`statements: sent ${r.sent.length}, skipped ${r.skipped.length}`);
    }
  } catch (e) { console.error('daily job failed:', e.message); }
};
daily();
setInterval(daily, 24 * 3600 * 1000).unref();
// Expire SMS codes that were never confirmed.
setInterval(() => ctx.sweepPending(), 60 * 1000).unref();
