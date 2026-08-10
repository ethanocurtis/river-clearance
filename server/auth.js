const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Cookies are `secure` (HTTPS-only) by default -- set COOKIE_SECURE=false
// only for local http:// testing, never in production.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}
function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function issueSession(res, userId) {
  const token = randomToken();
  db.createSession(token, userId, isoIn(SESSION_TTL_MS));
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  return token;
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function issueEmailToken(userId, purpose) {
  const token = randomToken();
  const ttl = purpose === 'reset' ? RESET_TOKEN_TTL_MS : VERIFY_TOKEN_TTL_MS;
  db.createEmailToken(token, userId, purpose, isoIn(ttl));
  return token;
}

// Attaches req.user if a valid session cookie is present; never blocks the
// request on its own. Use requireAuth for routes that must reject anonymous
// requests.
function loadSession(req, _res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const session = db.getSession(token);
    if (session) req.user = db.getUserById(session.user_id);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}
function isValidEmail(email) {
  return EMAIL_RE.test(email) && email.length <= 254;
}
function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  randomToken,
  issueSession,
  clearSessionCookie,
  issueEmailToken,
  loadSession,
  requireAuth,
  requireAdmin,
  normalizeEmail,
  isValidEmail,
  isValidPassword,
};
