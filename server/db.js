// SQLite storage. Real accounts (users/sessions/email_tokens) plus one row
// per user for their saved vessel list.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sync.sqlite3');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS email_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS user_vessels (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const insertUserStmt = db.prepare(
  `INSERT INTO users (email, password_hash, role, email_verified) VALUES (?, ?, ?, 0)`
);
const getUserByEmailStmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
const getUserByIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const setEmailVerifiedStmt = db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`);
const setPasswordHashStmt = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);

function createUser(email, passwordHash, role) {
  const info = insertUserStmt.run(email, passwordHash, role);
  return getUserById(info.lastInsertRowid);
}
function getUserByEmail(email) {
  return getUserByEmailStmt.get(email) || null;
}
function getUserById(id) {
  return getUserByIdStmt.get(id) || null;
}
function markEmailVerified(userId) {
  setEmailVerifiedStmt.run(userId);
}
function setPasswordHash(userId, passwordHash) {
  setPasswordHashStmt.run(passwordHash, userId);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const insertSessionStmt = db.prepare(
  `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
);
const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE token = ?`);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE token = ?`);
const deleteExpiredSessionsStmt = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);
const deleteUserSessionsStmt = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);

function createSession(token, userId, expiresAt) {
  insertSessionStmt.run(token, userId, expiresAt);
}
function getSession(token) {
  deleteExpiredSessionsStmt.run(new Date().toISOString());
  return getSessionStmt.get(token) || null;
}
function deleteSession(token) {
  deleteSessionStmt.run(token);
}
function deleteAllSessionsForUser(userId) {
  deleteUserSessionsStmt.run(userId);
}

// ---------------------------------------------------------------------------
// Email tokens (verification + password reset, same shape, different purpose)
// ---------------------------------------------------------------------------

const insertEmailTokenStmt = db.prepare(
  `INSERT INTO email_tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)`
);
const getEmailTokenStmt = db.prepare(`SELECT * FROM email_tokens WHERE token = ? AND purpose = ?`);
const deleteEmailTokenStmt = db.prepare(`DELETE FROM email_tokens WHERE token = ?`);
const deleteUserEmailTokensStmt = db.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?`);

function createEmailToken(token, userId, purpose, expiresAt) {
  // Only one live token per purpose per user -- a new signup/reset request
  // invalidates any earlier unused one.
  deleteUserEmailTokensStmt.run(userId, purpose);
  insertEmailTokenStmt.run(token, userId, purpose, expiresAt);
}
function getEmailToken(token, purpose) {
  const row = getEmailTokenStmt.get(token, purpose);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    deleteEmailTokenStmt.run(token);
    return null;
  }
  return row;
}
function consumeEmailToken(token) {
  deleteEmailTokenStmt.run(token);
}

// ---------------------------------------------------------------------------
// Vessels (one JSON blob per user)
// ---------------------------------------------------------------------------

const getVesselsStmt = db.prepare(`SELECT data, updated_at FROM user_vessels WHERE user_id = ?`);
const upsertVesselsStmt = db.prepare(`
  INSERT INTO user_vessels (user_id, data, updated_at)
  VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

function getVesselData(userId) {
  const row = getVesselsStmt.get(userId);
  if (!row) return null;
  return { data: JSON.parse(row.data), updatedAt: row.updated_at };
}
function saveVesselData(userId, data) {
  upsertVesselsStmt.run(userId, JSON.stringify(data));
  return getVesselData(userId);
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  markEmailVerified,
  setPasswordHash,
  createSession,
  getSession,
  deleteSession,
  deleteAllSessionsForUser,
  createEmailToken,
  getEmailToken,
  consumeEmailToken,
  getVesselData,
  saveVesselData,
};
