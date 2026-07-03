/**
 * Database Layer
 *
 * Manages the SQLite connection, schema initialisation, and prepared
 * statements for the mobile telemetry service.
 *
 * All database access should go through this module so that connection
 * and schema are guaranteed to be ready before any route handler runs.
 *
 * @module lib/db
 */

const Database = require('better-sqlite3');
const { DB_PATH, LOG_TAG } = require('./constants');

// ─── Connection ─────────────────────────────────────────────────────────────────

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  console.log(`${LOG_TAG} Database connected: ${DB_PATH}`);
} catch (err) {
  console.error(`${LOG_TAG} Failed to connect to database:`, err.message);
  process.exit(1);
}

// ─── Schema ─────────────────────────────────────────────────────────────────────

try {
  db.exec(`
    -- Raw ingest: full payload kept for debugging and replay.
    CREATE TABLE IF NOT EXISTS mobile_raw (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at  INTEGER NOT NULL,
      session_id   TEXT,
      device_id    TEXT,
      app_version  TEXT,
      platform     TEXT,
      user_id      TEXT,
      payload_json TEXT NOT NULL
    );

    -- Normalised events: one row per event for efficient querying.
    CREATE TABLE IF NOT EXISTS mobile_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_id          INTEGER,
      received_at     INTEGER NOT NULL,
      event_timestamp INTEGER,
      session_id      TEXT,
      device_id       TEXT,
      app_version     TEXT,
      platform        TEXT,
      user_id         TEXT,
      event_type      TEXT,
      station_id      TEXT,
      brand_id        TEXT,
      severity        TEXT,
      message         TEXT,
      data_json       TEXT,
      FOREIGN KEY(raw_id) REFERENCES mobile_raw(id)
    );

    -- Indexes for the query patterns we use most.
    CREATE INDEX IF NOT EXISTS idx_mobile_raw_received_at       ON mobile_raw(received_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_raw_session_id         ON mobile_raw(session_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_received_at     ON mobile_events(received_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_event_timestamp ON mobile_events(event_timestamp);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_session_id      ON mobile_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_station_id      ON mobile_events(station_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_event_type      ON mobile_events(event_type);


    -- User-submitted diagnostic log dumps (auto-purged after 3 days).
    CREATE TABLE IF NOT EXISTS user_log_dumps (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at  INTEGER NOT NULL,
      user_id      TEXT,
      device_id    TEXT,
      app_version  TEXT,
      platform     TEXT,
      logs_json    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_log_dumps_user_id     ON user_log_dumps(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_log_dumps_received_at ON user_log_dumps(received_at);
  `);
  console.log(`${LOG_TAG} Schema ready (mobile_raw, mobile_events, user_log_dumps)`);
} catch (err) {
  console.error(`${LOG_TAG} Failed to initialise schema:`, err.message);
  process.exit(1);
}

// ─── Migrations (idempotent) ────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS above is a no-op when the table exists from a prior
// boot — so columns added later need explicit ALTER TABLE. Each step here must
// be safe to re-run on every startup.

try {
  const cols = db.prepare("PRAGMA table_info('mobile_events')").all();
  const hasBrandId = cols.some((c) => c.name === 'brand_id');
  if (!hasBrandId) {
    db.exec('ALTER TABLE mobile_events ADD COLUMN brand_id TEXT');
    console.log(`${LOG_TAG} Migration: added mobile_events.brand_id column`);
  }
  // Index creation is idempotent and safe whether the column was just
  // added (above) or already existed (fresh DB with brand_id in schema).
  db.exec('CREATE INDEX IF NOT EXISTS idx_mobile_events_brand_id ON mobile_events(brand_id)');
} catch (err) {
  console.error(`${LOG_TAG} Migration failed:`, err.message);
  process.exit(1);
}

// ─── Prepared Statements ────────────────────────────────────────────────────────
// Created once at startup, reused per request for performance.

const stmts = {
  /** Insert a raw payload into mobile_raw. */
  insertRaw: db.prepare(`
    INSERT INTO mobile_raw (received_at, session_id, device_id, app_version, platform, user_id, payload_json)
    VALUES (@received_at, @session_id, @device_id, @app_version, @platform, @user_id, @payload_json)
  `),

  /** Insert a single normalised event into mobile_events. */
  insertEvent: db.prepare(`
    INSERT INTO mobile_events (
      raw_id, received_at, event_timestamp, session_id, device_id,
      app_version, platform, user_id, event_type, station_id,
      brand_id, severity, message, data_json
    ) VALUES (
      @raw_id, @received_at, @event_timestamp, @session_id, @device_id,
      @app_version, @platform, @user_id, @event_type, @station_id,
      @brand_id, @severity, @message, @data_json
    )
  `),

  /** Get currently online users (presence heartbeats within the window). */
  onlineUsers: db.prepare(`
    SELECT device_id, user_id, data_json, MAX(event_timestamp) AS last_seen
    FROM mobile_events
    WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
      AND event_timestamp > ?
    GROUP BY device_id
    ORDER BY last_seen DESC
  `),

  /**
   * Get each device's most recent presence location, regardless of age.
   * Unlike `onlineUsers` (bounded to PRESENCE_WINDOW_MS = "online right
   * now"), this has no time filter — the caller applies its own recency
   * window (and direction: recent vs. lapsed) over the returned `last_seen`.
   * Powers geographic push-notification targeting ("opened the app near
   * here"), which needs historical reach, not just live presence.
   */
  recentLocations: db.prepare(`
    SELECT device_id, user_id, data_json, MAX(event_timestamp) AS last_seen
    FROM mobile_events
    WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
    GROUP BY device_id
    ORDER BY last_seen DESC
  `),

  /**
   * Heatmap queries with and without time filter.
   *
   * Deduplicated per (device_id, 5-minute bucket) to avoid inflation from
   * continuous heartbeats at the same location. Each row represents one
   * unique user presence observation; the frontend controls visual intensity
   * via maxIntensity so that only areas with many distinct observations
   * appear "hot".
   */
  heatmapWithTime: db.prepare(`
    SELECT data_json, 1 AS weight
    FROM mobile_events
    WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
      AND data_json IS NOT NULL
      AND event_timestamp > ?
    GROUP BY device_id, (event_timestamp / 300000)
    ORDER BY (event_timestamp / 300000) DESC
  `),

  heatmapAll: db.prepare(`
    SELECT data_json, 1 AS weight
    FROM mobile_events
    WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
      AND data_json IS NOT NULL
    GROUP BY device_id, (event_timestamp / 300000)
    ORDER BY (event_timestamp / 300000) DESC
  `),

  /**
   * Heatmap with dynamic user_id exclusion (e.g. to drop admin/internal
   * users so their home/office activity does not pollute demand suggestions).
   *
   * Better-sqlite3 needs a fresh prepared statement per placeholder count,
   * so we build (and cache) statements keyed by (hasTime, excludeCount).
   */
  heatmapFiltered({ periodMs, excludeUserIds }) {
    const exclude = Array.isArray(excludeUserIds)
      ? excludeUserIds.filter((u) => typeof u === 'string' && u.length > 0)
      : [];
    const hasTime = typeof periodMs === 'number' && periodMs > 0;

    // Fast paths — preserve existing query plans.
    if (exclude.length === 0) {
      return hasTime
        ? stmts.heatmapWithTime.all(Date.now() - periodMs)
        : stmts.heatmapAll.all();
    }

    const cacheKey = `${hasTime ? 1 : 0}:${exclude.length}`;
    if (!heatmapStmtCache.has(cacheKey)) {
      const placeholders = exclude.map(() => '?').join(',');
      const sql = `
        SELECT data_json, 1 AS weight
        FROM mobile_events
        WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
          AND data_json IS NOT NULL
          ${hasTime ? 'AND event_timestamp > ?' : ''}
          AND (user_id IS NULL OR user_id NOT IN (${placeholders}))
        GROUP BY device_id, (event_timestamp / 300000)
        ORDER BY (event_timestamp / 300000) DESC
      `;
      heatmapStmtCache.set(cacheKey, db.prepare(sql));
    }

    const stmt = heatmapStmtCache.get(cacheKey);
    const params = hasTime ? [Date.now() - periodMs, ...exclude] : exclude;
    return stmt.all(...params);
  },
};

// Cache of prepared statements keyed by (hasTime, excludeCount) so we don't
// re-parse identical SQL on every request. Capped to avoid unbounded growth
// from pathological excludeUserIds counts.
const HEATMAP_STMT_CACHE_LIMIT = 64;
const heatmapStmtCache = new Map();
const _origSet = heatmapStmtCache.set.bind(heatmapStmtCache);
heatmapStmtCache.set = function (key, value) {
  if (this.size >= HEATMAP_STMT_CACHE_LIMIT) {
    const oldestKey = this.keys().next().value;
    this.delete(oldestKey);
  }
  return _origSet(key, value);
};

module.exports = { db, stmts };
