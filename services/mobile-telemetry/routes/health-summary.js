// Read-only deploy/runtime health from the Vercel drain (vercel.db).
// Aggregate + PII-free: endpoints + status codes + counts only.
// Secret-gated by requireSecret at the mount in index.js.
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const router = express.Router();
const VERCEL_DB_PATH = path.join(__dirname, '..', '..', '..', 'db', 'vercel.db');

// vercel.db is owned by the separate vercel-drain process. Connecting only
// once at require-time meant that if it wasn't ready yet when this process
// booted (fresh VPS boot before vercel-drain created db/, a transient
// filesystem hiccup, ...), this route stayed 503 for the rest of the
// process's life even after vercel.db became available. Retrying lazily
// (at most once per interval) lets it self-heal without a manual restart.
const RECONNECT_INTERVAL_MS = 30_000;

function createLazyConnection(dbPath, { retryIntervalMs = RECONNECT_INTERVAL_MS } = {}) {
  let db = null;
  let lastAttempt = 0;

  return function getConnection() {
    if (db) return db;
    const now = Date.now();
    if (now - lastAttempt < retryIntervalMs) return null;
    lastAttempt = now;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      console.log('[health-summary] Database connected:', dbPath);
    } catch (err) {
      console.error('[health-summary] cannot open vercel.db:', err.message);
      db = null;
    }
    return db;
  };
}

const getDb = createLazyConnection(VERCEL_DB_PATH);

router.get('/', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'vercel.db unavailable' });
  const windowMinutes = Math.max(5, Math.min(720, parseInt(req.query.window_minutes || '60', 10) || 60));
  const sinceMs = Date.now() - windowMinutes * 60000;
  try {
    const freshness = db.prepare('SELECT MAX(last_ts) AS m FROM vercel_requests').get();
    const mixRows = db.prepare(
      'SELECT status_code AS code, COUNT(*) AS n FROM vercel_requests WHERE last_ts >= ? AND status_code IS NOT NULL GROUP BY status_code'
    ).all(sinceMs);
    const statusMix = {};
    for (const r of mixRows) statusMix[String(r.code)] = r.n;
    const endpoints = db.prepare(
      'SELECT endpoint, method, status_code AS statusCode, COUNT(*) AS count FROM vercel_requests ' +
      'WHERE last_ts >= ? AND status_code >= 300 GROUP BY endpoint, method, status_code ORDER BY count DESC LIMIT 50'
    ).all(sinceMs);
    res.json({ freshnessMs: freshness && freshness.m != null ? freshness.m : null, windowMinutes, statusMix, endpoints });
  } catch (err) {
    console.error('[health-summary] query failed:', err.message);
    res.status(500).json({ error: 'query failed' });
  }
});

module.exports = router;
module.exports.createLazyConnection = createLazyConnection;
