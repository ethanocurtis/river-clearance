// Minimal sync API for the River Bridge Clearance app's vessel list.
//
// Deliberately no passwords -- a username is the whole "account". Anyone who
// types the same username sees/overwrites the same data. This matches what
// was asked for: a placeholder for real auth until the site has real
// hosting, not a security boundary. Keep that in mind before storing
// anything more sensitive than "air draft + a nickname" here.

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { getVesselData, saveVesselData, deleteVesselData } = require('./db');

const PORT = process.env.PORT || 8787;
// Comma-separated list of allowed origins, e.g. "https://example.com,https://ethanocurtis.github.io".
// Defaults to "*" (open) for easy first setup -- lock this down once you know
// your real frontend origin(s).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Optional: serve the static docs/ site from this same process, so the
// frontend and this API end up same-origin (no CORS involved at all).
// Unset (default) means this container is API-only, same as before --
// nothing changes for anyone already running it that way.
const STATIC_DIR = process.env.STATIC_DIR || '';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  })
);

if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR));
}

// Generous but real: this is a hobby-scale API on a small VM, not a target
// worth hardening further given the no-password trust model already in play.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

function validateUsername(req, res, next) {
  const username = normalizeUsername(req.params.username);
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Invalid username. Use 3-32 characters: lowercase letters, numbers, - or _.',
    });
  }
  req.username = username;
  next();
}

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/api/sync/:username', syncLimiter, validateUsername, (req, res) => {
  const record = getVesselData(req.username);
  if (!record) return res.status(404).json({ error: 'No saved data for this username yet.' });
  res.json({ username: req.username, ...record });
});

app.put('/api/sync/:username', syncLimiter, validateUsername, (req, res) => {
  const { vessels, activeVesselIndex } = req.body || {};
  if (!Array.isArray(vessels)) {
    return res.status(400).json({ error: '"vessels" must be an array.' });
  }
  if (vessels.length > 50) {
    return res.status(400).json({ error: 'Too many vessels (max 50).' });
  }
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
  const record = saveVesselData(req.username, {
    vessels,
    activeVesselIndex: Number.isInteger(activeVesselIndex) ? activeVesselIndex : 0,
  });
  res.json({ username: req.username, ...record });
});

app.delete('/api/sync/:username', syncLimiter, validateUsername, (req, res) => {
  const existed = deleteVesselData(req.username);
  res.status(existed ? 200 : 404).json({ deleted: existed });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`river-clearance sync API listening on :${PORT}`);
  if (STATIC_DIR) console.log(`also serving static site from ${path.resolve(STATIC_DIR)}`);
});
