// Individual accounts, server-side sessions and role checks.
const crypto = require('crypto');

const COOKIE = 'ftt_session';
const SESSION_HOURS = 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600000);
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now.toISOString(), expires.toISOString());
  return { token, expires };
}

function setSessionCookie(req, res, token, expires) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Attaches req.user when a valid session cookie is present.
function loadUser(db) {
  const q = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.active, u.preferred_lang
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const u = q.get(sha256(token), new Date().toISOString());
      if (u && u.active) { req.user = u; req.sessionTokenHash = sha256(token); }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Please log in.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Please log in.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: `This action requires role: ${roles.join(' or ')}.` });
    }
    next();
  };
}

// CSRF defence for cookie-authenticated mutations: browsers will not add a
// custom header to a cross-site form post, and SameSite=Lax blocks the cookie
// on cross-site subrequests.
function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'TankTracker') {
    return res.status(403).json({ error: 'CSRF', message: 'Missing request header.' });
  }
  next();
}

// Small in-memory login throttle per username+IP.
const attempts = new Map();
function loginThrottle(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (a.until > now) return Math.ceil((a.until - now) / 1000);
  return 0;
}
function loginFailed(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (now - a.first > 15 * 60000) { a.n = 0; a.first = now; }
  a.n += 1;
  if (a.n >= 5) a.until = now + 60000 * Math.min(15, a.n - 4);
  attempts.set(key, a);
}
function loginSucceeded(key) { attempts.delete(key); }

module.exports = {
  COOKIE, hashPassword, verifyPassword, sha256, createSession, setSessionCookie, clearSessionCookie,
  loadUser, requireAuth, requireRole, requireCsrfHeader, loginThrottle, loginFailed, loginSucceeded,
};
