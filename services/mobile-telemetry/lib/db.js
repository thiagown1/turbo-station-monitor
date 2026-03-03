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
  `);
    console.log(`${LOG_TAG} Schema ready (mobile_raw, mobile_events)`);
} catch (err) {
    console.error(`${LOG_TAG} Failed to initialise schema:`, err.message);
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
      severity, message, data_json
    ) VALUES (
      @raw_id, @received_at, @event_timestamp, @session_id, @device_id,
      @app_version, @platform, @user_id, @event_type, @station_id,
      @severity, @message, @data_json
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
     * Heatmap queries with and without time filter.
     * Grouped by (device_id, 5-minute bucket) to avoid inflation from
     * continuous heartbeats at the same location.
     */
    heatmapWithTime: db.prepare(`
    SELECT data_json
    FROM mobile_events
    WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
      AND data_json IS NOT NULL
      AND event_timestamp > ?
    GROUP BY device_id, (event_timestamp / 300000)
    ORDER BY (event_timestamp / 300000) DESC
  `),

    heatmapAll: db.prepare(`
    SELECT data_json
    FROM mobile_events
    WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
      AND data_json IS NOT NULL
    GROUP BY device_id, (event_timestamp / 300000)
    ORDER BY (event_timestamp / 300000) DESC
  `),
};

module.exports = { db, stmts };
