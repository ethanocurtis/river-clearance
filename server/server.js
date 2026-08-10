// River Bridge Clearance backend: real email/password accounts (sessions via
// httpOnly cookie), email verification + password reset over SMTP, per-user
// vessel sync, and an admin API for editing docs/data/bridges.json and
// gauges.json without hand-editing files + git push.

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const mailer = require('./mailer');
const auth = require('./auth');

const PORT = process.env.PORT || 8787;
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const STATIC_DIR = process.env.STATIC_DIR || '';
const DATA_DIR = process.env.DATA_DIR || (STATIC_DIR ? path.join(STATIC_DIR, 'data') : '');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '500kb' }));
app.use(cookieParser());
app.use(
  cors({
    // Reflect the actual request origin (rather than a literal "*") when
    // allowed -- required for cookies to work at all; browsers reject
    // Access-Control-Allow-Origin: * combined with credentials.
    origin(origin, callback) {
      if (!origin) return callback(null, true); // same-origin / curl / server-to-server
      if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(auth.loadSession);

if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR));
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', authLimiter, async (req, res, next) => {
  try {
    const email = auth.normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!auth.isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!auth.isValidPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });

    const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'user';
    const passwordHash = await auth.hashPassword(password);
    const user = db.createUser(email, passwordHash, role);

    const token = auth.issueEmailToken(user.id, 'verify');
    const verifyUrl = `${APP_BASE_URL}/api/auth/verify?token=${token}`;
    // Fire-and-forget: the account is already created at this point, and a
    // slow/unreachable SMTP server shouldn't hang the signup request itself
    // (mailer.js logs any failure). See "Resend verification email" for
    // recovering an account whose first send failed.
    mailer.sendVerificationEmail(email, verifyUrl).catch((err) => {
      console.error(`[signup] Verification email failed for ${email}:`, err.message);
    });

    res.status(201).json({ message: 'Account created. Check your email to verify it before logging in.' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/verify', (req, res) => {
  const token = String(req.query.token || '');
  const record = token && db.getEmailToken(token, 'verify');
  if (!record) return res.redirect(`${APP_BASE_URL}/?verify_error=1`);
  db.markEmailVerified(record.user_id);
  db.consumeEmailToken(token);
  auth.issueSession(res, record.user_id); // verifying logs you in
  res.redirect(`${APP_BASE_URL}/?verified=1`);
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = auth.normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const user = db.getUserByEmail(email);
    if (!user || !(await auth.verifyPassword(String(password || ''), user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in -- check your inbox for the link.' });
    }
    auth.issueSession(res, user.id);
    res.json({ user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/resend-verification', authLimiter, async (req, res, next) => {
  try {
    const email = auth.normalizeEmail(req.body?.email);
    const user = auth.isValidEmail(email) ? db.getUserByEmail(email) : null;
    if (user && !user.email_verified) {
      const token = auth.issueEmailToken(user.id, 'verify');
      const verifyUrl = `${APP_BASE_URL}/api/auth/verify?token=${token}`;
      mailer.sendVerificationEmail(email, verifyUrl).catch((err) => {
        console.error(`[resend-verification] Failed for ${email}:`, err.message);
      });
    }
    // Same generic response whether the account doesn't exist, is already
    // verified, or the email is about to be sent -- don't leak account state.
    res.json({ message: 'If that account needs verification, a new link has been sent.' });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[auth.SESSION_COOKIE];
  if (token) db.deleteSession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role } });
});

app.post('/api/auth/request-password-reset', authLimiter, async (req, res, next) => {
  try {
    const email = auth.normalizeEmail(req.body?.email);
    const user = auth.isValidEmail(email) ? db.getUserByEmail(email) : null;
    if (user) {
      const token = auth.issueEmailToken(user.id, 'reset');
      const resetUrl = `${APP_BASE_URL}/?reset_token=${token}`;
      // Fire-and-forget, same reasoning as signup above.
      mailer.sendPasswordResetEmail(email, resetUrl).catch((err) => {
        console.error(`[request-password-reset] Email failed for ${email}:`, err.message);
      });
    }
    // Same response whether or not the email exists -- don't leak which emails are registered.
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res, next) => {
  try {
    const token = String(req.body?.token || '');
    const newPassword = req.body?.newPassword;
    if (!auth.isValidPassword(newPassword)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const record = token && db.getEmailToken(token, 'reset');
    if (!record) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const passwordHash = await auth.hashPassword(newPassword);
    db.setPasswordHash(record.user_id, passwordHash);
    db.markEmailVerified(record.user_id); // clicking the emailed link proves ownership same as verify does
    db.consumeEmailToken(token);
    db.deleteAllSessionsForUser(record.user_id); // force re-login everywhere after a password change
    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Vessels (per logged-in account)
// ---------------------------------------------------------------------------

app.get('/api/vessels', apiLimiter, auth.requireAuth, (req, res) => {
  const record = db.getVesselData(req.user.id);
  res.json(record || { data: { vessels: [], activeVesselIndex: 0 }, updatedAt: null });
});

app.put('/api/vessels', apiLimiter, auth.requireAuth, (req, res) => {
  const { vessels, activeVesselIndex } = req.body || {};
  if (!Array.isArray(vessels)) return res.status(400).json({ error: '"vessels" must be an array.' });
  if (vessels.length > 50) return res.status(400).json({ error: 'Too many vessels (max 50).' });
  for (const v of vessels) {
    if (typeof v?.name !== 'string' || v.name.length > 100) {
      return res.status(400).json({ error: 'Each vessel needs a name (string, <=100 chars).' });
    }
    if (typeof v?.airDraftFt !== 'number' || !Number.isFinite(v.airDraftFt) || v.airDraftFt < 0 || v.airDraftFt > 500) {
      return res.status(400).json({ error: 'Each vessel needs a valid airDraftFt (0-500).' });
    }
    if (v.marginFt != null && (typeof v.marginFt !== 'number' || !Number.isFinite(v.marginFt) || v.marginFt < 0 || v.marginFt > 100)) {
      return res.status(400).json({ error: 'marginFt, if present, must be a valid number (0-100).' });
    }
  }
  const record = db.saveVesselData(req.user.id, {
    vessels,
    activeVesselIndex: Number.isInteger(activeVesselIndex) ? activeVesselIndex : 0,
  });
  res.json(record);
});

// ---------------------------------------------------------------------------
// Admin: edit docs/data/bridges.json + gauges.json without git/SSH
// ---------------------------------------------------------------------------

const ADMIN_FILES = { bridges: 'bridges.json', gauges: 'gauges.json' };

app.get('/api/admin/data/:file', auth.requireAdmin, (req, res) => {
  const filename = ADMIN_FILES[req.params.file];
  if (!filename) return res.status(404).json({ error: 'Unknown data file.' });
  if (!DATA_DIR) return res.status(501).json({ error: 'Admin data editing requires DATA_DIR/STATIC_DIR to be configured (see README).' });
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
    res.type('application/json').send(raw);
  } catch (err) {
    res.status(500).json({ error: `Couldn't read ${filename}: ${err.message}` });
  }
});

app.put('/api/admin/data/:file', auth.requireAdmin, (req, res) => {
  const filename = ADMIN_FILES[req.params.file];
  if (!filename) return res.status(404).json({ error: 'Unknown data file.' });
  if (!DATA_DIR) return res.status(501).json({ error: 'Admin data editing requires DATA_DIR/STATIC_DIR to be configured (see README).' });

  const body = req.body;
  if (!Array.isArray(body)) return res.status(400).json({ error: 'Content must be a JSON array.' });
  for (const item of body) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string') {
      return res.status(400).json({ error: 'Every entry needs at least a string "id" and "name".' });
    }
  }
  try {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(body, null, 2) + '\n');
    res.json({ ok: true, count: body.length });
  } catch (err) {
    res.status(500).json({ error: `Couldn't write ${filename}: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`river-clearance API listening on :${PORT}`);
  if (STATIC_DIR) console.log(`also serving static site from ${path.resolve(STATIC_DIR)}`);
  if (DATA_DIR) console.log(`admin data editing enabled: ${path.resolve(DATA_DIR)}`);
  if (!mailer.mailerConfigured) console.warn('SMTP not configured -- verification/reset emails will only be logged, not sent.');
  if (!APP_BASE_URL) console.warn('APP_BASE_URL not set -- verification/reset links will be broken (relative with no host). Set it in .env.');
});
