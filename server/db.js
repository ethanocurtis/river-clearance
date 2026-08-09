// SQLite storage for the sync API. One row per username, holding the whole
// vessel list as a JSON blob -- the client always sends/receives its full
// vessel array, so there's no need to model individual vessels as rows.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sync.sqlite3');

// Ensure the data directory exists (better-sqlite3 won't create it for you).
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS vessel_sync (
    username TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

const getStmt = db.prepare('SELECT data, updated_at FROM vessel_sync WHERE username = ?');
const upsertStmt = db.prepare(`
  INSERT INTO vessel_sync (username, data, updated_at)
  VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(username) DO UPDATE SET
    data = excluded.data,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM vessel_sync WHERE username = ?');

function getVesselData(username) {
  const row = getStmt.get(username);
  if (!row) return null;
  return { data: JSON.parse(row.data), updatedAt: row.updated_at };
}

function saveVesselData(username, data) {
  upsertStmt.run(username, JSON.stringify(data));
  return getVesselData(username);
}

function deleteVesselData(username) {
  const result = deleteStmt.run(username);
  return result.changes > 0;
}

module.exports = { getVesselData, saveVesselData, deleteVesselData };
