// Creates the first accounts and sample sites for a pilot.
// Usage: npm run seed            (prints generated passwords)
//        SEED_PASSWORD=... npm run seed   (use one known password for all demo users)
const path = require('path');
const crypto = require('crypto');
const dbm = require('../server/db');
const { hashPassword } = require('../server/auth');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = dbm.open(dataDir);
const now = new Date().toISOString();

const users = [
  ['admin', 'Administrator', 'admin'],
  ['supervisor', 'Somchai (Supervisor)', 'supervisor'],
  ['operator1', 'Nok (Operator)', 'operator'],
  ['operator2', 'Lek (Operator)', 'operator'],
];
console.log('Accounts:');
for (const [username, name, role] of users) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { console.log(`  ${username} (exists)`); continue; }
  const pw = process.env.SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, name, hashPassword(pw), role, now);
  console.log(`  ${username.padEnd(11)} ${role.padEnd(10)} password: ${pw}`);
}

// Sample sites. Replace coordinates and radii with surveyed values.
const sites = [
  ['WH-BKK', 'Bangkok Main Warehouse', 'warehouse', null, 'Bang Na, Bangkok', 13.6683, 100.6044, 250],
  ['WH-KKC', 'Khon Kaen Depot', 'warehouse', null, 'Mueang Khon Kaen', 16.4419, 102.8360, 200],
  ['CU-UDN-01', 'Udon Cool Service', 'customer', 'Udon Cool Service Co., Ltd.', 'Mueang Udon Thani', 17.4138, 102.7872, 150],
  ['CU-CNX-01', 'Chiang Mai Air Care', 'customer', 'Chiang Mai Air Care', 'Mueang Chiang Mai', 18.7883, 98.9853, 150],
];
for (const s of sites) {
  db.prepare(`INSERT OR IGNORE INTO sites (code, name, kind, customer_name, address, lat, lng, radius_m, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(...s, now);
}
console.log(`Sites: ${db.prepare('SELECT COUNT(*) AS n FROM sites').get().n}`);
console.log('Change all passwords after first login (Admin > Users).');
