/**
 * Constants & Configuration
 *
 * Central place for all environment variables, limits, and tunable values
 * used across the mobile telemetry service.
 *
 * @module lib/constants
 */

const path = require('path');

// ─── Server ─────────────────────────────────────────────────────────────────────

/** HTTP port for the service. */
const PORT = parseInt(process.env.PORT || '3003', 10);

// ─── Authentication ─────────────────────────────────────────────────────────────

/** API key expected from the mobile app on POST /api/telemetry/mobile. */
const TELEMETRY_API_KEY =
    process.env.TELEMETRY_API_KEY || 'f593c26c80894c8aef64a4c977f280d8ae687387b049f454';

/** Shared secret for dashboard → monitor communication (read-only endpoints). */
const MONITOR_API_SECRET = process.env.MONITOR_API_SECRET || '';

// ─── Database ───────────────────────────────────────────────────────────────────

/** Path to the dedicated mobile telemetry SQLite database. */
const DB_PATH = path.join(__dirname, '..', '..', '..', 'db', 'mobile.db');

// ─── Ingestion ──────────────────────────────────────────────────────────────────

/** Maximum request body size (uncompressed). */
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Presence ───────────────────────────────────────────────────────────────────

/**
 * How long since last heartbeat before a user is considered offline.
 * Set to 3× the mobile heartbeat interval (30s) to tolerate flush delays.
 */
const PRESENCE_WINDOW_MS = 90_000;

// ─── Heatmap ────────────────────────────────────────────────────────────────────

/** Supported heatmap time periods → milliseconds. */
const PERIOD_MS = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};

// ─── Logging ────────────────────────────────────────────────────────────────────

/** Prefix for all console logs from this service. */
const LOG_TAG = '[mobile-telemetry]';

module.exports = {
    PORT,
    TELEMETRY_API_KEY,
    MONITOR_API_SECRET,
    DB_PATH,
    MAX_PAYLOAD_BYTES,
    PRESENCE_WINDOW_MS,
    PERIOD_MS,
    LOG_TAG,
};
