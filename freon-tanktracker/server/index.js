// Starts Freon TankTracker. Camera and geolocation need a secure context:
// serve over HTTPS (TLS_CERT/TLS_KEY, or a TLS reverse proxy) except on localhost.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { createApp } = require('./app');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.PORT || 3000);
const { app, runRetention } = createApp({
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
});

// Evidence retention purge: at start-up and daily.
const purge = () => { const n = runRetention(); if (n) console.log(`retention: purged ${n} evidence file(s)`); };
purge();
setInterval(purge, 24 * 3600 * 1000).unref();
