// Database schema and helpers. Uses Node's built-in SQLite (node:sqlite).
//
// Audit design:
//  * `events`, `reviews`, `flags`, `audit_log` and `label_prints` are append-only.
//    SQLite triggers abort any UPDATE or DELETE, so even a bug or a crafted
//    request cannot rewrite history. Corrections are new rows that reference
//    the original (events.corrects_event_id).
//  * `cylinders` holds a projection (movement status, latest submitted event,
//    latest approved event) that is recomputed from the append-only history.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','supervisor')),
  active INTEGER NOT NULL DEFAULT 1,
  preferred_lang TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('warehouse','customer')),
  customer_name TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  radius_m REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cylinders (
  id TEXT PRIMARY KEY,                       -- internal ID, e.g. FTT-000001
  serial TEXT NOT NULL UNIQUE COLLATE NOCASE, -- manufacturer's engraved serial
  brand_owner TEXT NOT NULL,
  gas_type TEXT NOT NULL,
  size TEXT NOT NULL,
  tare_kg REAL NOT NULL,
  registration_date TEXT NOT NULL,
  initial_site_id INTEGER NOT NULL REFERENCES sites(id),
  initial_bay TEXT,
  initial_condition TEXT NOT NULL,
  expected_return_days INTEGER,
  -- projection, recomputed from events + reviews
  movement_status TEXT NOT NULL,
  current_site_id INTEGER REFERENCES sites(id),
  destination_site_id INTEGER REFERENCES sites(id),
  latest_submitted_event_id INTEGER,
  latest_approved_event_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cylinder_photos (
  id INTEGER PRIMARY KEY,
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  kind TEXT NOT NULL CHECK (kind IN ('whole','serial','other')),
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_codes (
  token TEXT PRIMARY KEY,                    -- opaque random identifier
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id),
  revoked_reason TEXT,
  replaced_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS qr_one_active ON qr_codes(cylinder_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS label_prints (
  id INTEGER PRIMARY KEY,
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  qr_token TEXT NOT NULL REFERENCES qr_codes(token),
  kind TEXT NOT NULL CHECK (kind IN ('initial','reprint','replacement')),
  batch_id TEXT,
  printed_by INTEGER NOT NULL REFERENCES users(id),
  printed_at TEXT NOT NULL
);

-- Secure NFC integration point. Rows exist only when a real tag is bound;
-- verification requires a configured backend verifier (see server/nfc.js).
CREATE TABLE IF NOT EXISTS nfc_tags (
  id INTEGER PRIMARY KEY,
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  tag_uid TEXT NOT NULL,
  tag_type TEXT,
  key_ref TEXT,
  last_counter INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  bound_by INTEGER NOT NULL REFERENCES users(id),
  bound_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS nfc_one_active ON nfc_tags(cylinder_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS inspection_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('normal','damaged_label')),
  status TEXT NOT NULL CHECK (status IN ('open','submitted','expired','cancelled')),
  cylinder_id TEXT REFERENCES cylinders(id),
  qr_token TEXT,
  scan_method TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inspection_sessions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  code TEXT NOT NULL,
  instruction_key TEXT NOT NULL,
  cylinder_version INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id),
  session_id TEXT NOT NULL REFERENCES inspection_sessions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  file TEXT,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  capture_source TEXT NOT NULL,
  client_started_at TEXT,
  client_stopped_at TEXT,
  duration_ms INTEGER,
  server_received_at TEXT NOT NULL,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS media_sha ON media(sha256);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  cylinder_id TEXT NOT NULL REFERENCES cylinders(id),
  event_type TEXT NOT NULL,
  movement_status_after TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  responsible_person TEXT,
  site_id INTEGER REFERENCES sites(id),
  bay TEXT,
  destination_site_id INTEGER REFERENCES sites(id),
  delivery_ref TEXT,
  expected_return_date TEXT,
  condition TEXT,
  comments TEXT,
  checklist_json TEXT,
  lat REAL,
  lng REAL,
  accuracy_m REAL,
  fix_timestamp TEXT,
  fix_age_ms INTEGER,
  location_status TEXT NOT NULL,          -- verified | not_verified | not_applicable
  location_issue TEXT,
  geofence_result TEXT,                   -- inside | boundary_uncertain | outside | no_geofence | not_checked
  geofence_distance_m REAL,
  qr_token TEXT,
  qr_verified INTEGER NOT NULL DEFAULT 0,
  nfc_status TEXT NOT NULL DEFAULT 'not_used',
  session_id TEXT,
  challenge_id TEXT,
  media_id TEXT,
  initial_verification TEXT NOT NULL,
  is_exception INTEGER NOT NULL DEFAULT 0,
  exception_kind TEXT,
  exception_reason TEXT,
  corrects_event_id INTEGER REFERENCES events(id),
  idempotency_key TEXT UNIQUE,
  server_received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_cyl ON events(cylinder_id, id);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason_code TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_event ON reviews(event_id, id);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  flag_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flags_event ON flags(event_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);
`;

const APPEND_ONLY = ['events', 'reviews', 'flags', 'audit_log', 'label_prints'];

function appendOnlyTriggers() {
  return APPEND_ONLY.map((t) => `
CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT, 'append-only table: ${t} cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
BEGIN SELECT RAISE(ABORT, 'append-only table: ${t} cannot be deleted'); END;`).join('\n');
}

const DEFAULT_SETTINGS = {
  max_fix_age_s: '30',              // pilot setting
  max_accuracy_m: '50',             // pilot setting
  geolocation_timeout_s: '20',
  inspection_session_ttl_s: '1800',
  challenge_ttl_s: '600',
  max_clip_seconds: '30',
  min_clip_seconds: '4',
  fast_travel_kmh: '150',
  repeat_scan_minutes: '10',
  inspection_overdue_days: '30',
  default_return_days: '45',
  evidence_retention_days: '365',
  auto_accept_clean_events: '1',    // clean events count as accepted ("Recorded") until rejected
  clock_skew_tolerance_s: '120',
};

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'tanktracker.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.exec(appendOnlyTriggers());
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v, now);
  return db;
}

// Runs fn inside BEGIN IMMEDIATE so concurrent writers are serialised.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function num(settings, key) {
  return Number(settings[key] ?? DEFAULT_SETTINGS[key]);
}

module.exports = { open, tx, getSettings, num, DEFAULT_SETTINGS, APPEND_ONLY };
