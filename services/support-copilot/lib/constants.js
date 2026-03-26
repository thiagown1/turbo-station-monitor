/**
 * Constants & Configuration — Support Copilot
 * @module lib/constants
 */

const path = require('path');

const PORT = parseInt(process.env.PORT || '3005', 10);

/** Shared secret for dashboard → support API. Falls back to MONITOR_API_SECRET for compat. */
const SUPPORT_API_SECRET = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '';

/** Path to the SQLite database (same dir pattern as mobile-telemetry). */
const DB_PATH = process.env.SUPPORT_COPILOT_DB_PATH ||
  path.join(__dirname, '..', '..', '..', 'db', 'support-copilot.sqlite');

const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20 MB (for base64 media uploads)

const LOG_TAG = '[support-copilot]';

// ─── Evolution API Configuration ────────────────────────────────────────────

/** Base URL of the Evolution API instance (e.g. http://localhost:8080) */
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:3006';

/** Global API key for Evolution API (set via AUTHENTICATION_API_KEY on Evolution side) */
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';

/** Optional: secret shared with Evolution API webhook config to verify inbound requests */
const EVOLUTION_WEBHOOK_SECRET = process.env.EVOLUTION_WEBHOOK_SECRET || '';

/** Agent to use for WhatsApp group conversations (partner reports, station reports, etc.) */
const GROUP_AGENT = process.env.GROUP_AGENT || 'support_turbo_station';

/**
 * Map Evolution API instance name → brand_id.
 * Format in env: "instanceA:brandA,instanceB:brandB"
 * Example: EVOLUTION_INSTANCE_MAP="turbostation:turbo,zev:zev"
 * If not set or instance not found, falls back to using the instance name as brand_id.
 */
const EVOLUTION_INSTANCE_BRAND_MAP = (process.env.EVOLUTION_INSTANCE_MAP || '')
  .split(',')
  .filter(Boolean)
  .reduce((map, pair) => {
    const [instance, brand] = pair.split(':');
    if (instance && brand) map[instance.trim()] = brand.trim();
    return map;
  }, {});

module.exports = {
  PORT,
  SUPPORT_API_SECRET,
  DB_PATH,
  MAX_PAYLOAD_BYTES,
  LOG_TAG,
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_WEBHOOK_SECRET,
  EVOLUTION_INSTANCE_BRAND_MAP,
  GROUP_AGENT,
};
