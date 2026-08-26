/**
 * Constants & Configuration — Support Copilot
 * @module lib/constants
 */

const path = require('path');

const { resolveServicePort, BIND_HOST } = require('../../lib/service-port');

const PORT = resolveServicePort('SUPPORT_COPILOT_PORT', 3005, '[support-copilot]');

/** Shared secret for dashboard → support API. Falls back to MONITOR_API_SECRET for compat. */
const SUPPORT_API_SECRET = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '';

/** Path to the SQLite database (same dir pattern as mobile-telemetry). */
const DB_PATH = process.env.SUPPORT_COPILOT_DB_PATH ||
  path.join(__dirname, '..', '..', '..', 'db', 'support-copilot.sqlite');

/** Shared inbound-media directory. Independent from DB_PATH in production. */
const MEDIA_DIR = path.resolve(process.env.SUPPORT_COPILOT_MEDIA_DIR ||
  path.join(__dirname, '..', '..', '..', 'db', 'media'));

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

// ─── Contador (internal accounting group agent) ─────────────────────────────
// Fail closed: code can be deployed without enabling WhatsApp writes or reads.
const CONTADOR_ENABLED = process.env.CONTADOR_ENABLED === 'true';
const CONTADOR_GROUP_CONVERSATION_ID = (process.env.CONTADOR_GROUP_CONVERSATION_ID || '').trim();
// Open conversation in the Contador's own group: forward every message and let
// the agent decide (reply vs silent) instead of gating on accounting keywords.
// OPT-IN on purpose. Defaulting this ON would change behaviour for any group
// the Contador already serves the moment the code ships, with no operator
// action -- exactly what the runtime test that caught it asserts against.
// Enable per environment with CONTADOR_OPEN_CONVERSATION=true; unset or any
// other value keeps the previous keyword+reply gate.
const CONTADOR_OPEN_CONVERSATION = process.env.CONTADOR_OPEN_CONVERSATION === 'true';
const CONTADOR_NEXT_BASE_URL = (process.env.CONTADOR_NEXT_BASE_URL || '').replace(/\/$/, '');
const CONTADOR_NEXT_SECRET = process.env.CONTADOR_NEXT_SECRET || process.env.ENERGY_BILL_INTAKE_SECRET || '';
const CONTADOR_INSTANCE = process.env.CONTADOR_INSTANCE || process.env.GATEWAY_INSTANCE_NAME || 'turbostation';
const CONTADOR_OPENCLAW_AGENT = process.env.CONTADOR_OPENCLAW_AGENT || 'contador';
const CONTADOR_OPENCLAW_MODEL = process.env.CONTADOR_OPENCLAW_MODEL || 'claude-cli/claude-opus-4-8';
const CONTADOR_CODEX_FALLBACK_ENABLED = process.env.CONTADOR_CODEX_FALLBACK_ENABLED === 'true';
const CONTADOR_CODEX_FALLBACK_MODEL = process.env.CONTADOR_CODEX_FALLBACK_MODEL || 'gpt-5.6-sol';
const CONTADOR_CODEX_BIN = process.env.CONTADOR_CODEX_BIN || process.env.CODEX_BIN || '/home/openclaw/.npm-global/bin/codex';
const CONTADOR_CODEX_WORKSPACE = process.env.CONTADOR_CODEX_WORKSPACE || '/home/openclaw/.openclaw/workspace-contador';
const CONTADOR_SESSION_ID = process.env.CONTADOR_SESSION_ID || 'contador-contas';
const CONTADOR_HEARTBEAT_HOUR = Math.min(23, Math.max(0, Number(process.env.CONTADOR_HEARTBEAT_HOUR || 8)));
const CONTADOR_MONTHLY_DAY = Math.min(28, Math.max(1, Number(process.env.CONTADOR_MONTHLY_DAY || 3)));
const CONTADOR_FINANCIAL_APPROVAL_ENABLED = process.env.CONTADOR_FINANCIAL_APPROVAL_ENABLED === 'true';
const CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID = (process.env.CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID || '').trim();
const CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS = (process.env.CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS || '')
  .split(',')
  .map((value) => value.replace(/\D/g, ''))
  .filter(Boolean);
const financialApprovalTtl = Number(process.env.CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES || 15);
const CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES = Number.isFinite(financialApprovalTtl)
  ? Math.min(60, Math.max(5, financialApprovalTtl))
  : 15;

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
  BIND_HOST,
  SUPPORT_API_SECRET,
  DB_PATH,
  MEDIA_DIR,
  MAX_PAYLOAD_BYTES,
  LOG_TAG,
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_WEBHOOK_SECRET,
  EVOLUTION_INSTANCE_BRAND_MAP,
  GROUP_AGENT,
  CONTADOR_ENABLED,
  CONTADOR_GROUP_CONVERSATION_ID,
  CONTADOR_OPEN_CONVERSATION,
  CONTADOR_NEXT_BASE_URL,
  CONTADOR_NEXT_SECRET,
  CONTADOR_INSTANCE,
  CONTADOR_OPENCLAW_AGENT,
  CONTADOR_OPENCLAW_MODEL,
  CONTADOR_CODEX_FALLBACK_ENABLED,
  CONTADOR_CODEX_FALLBACK_MODEL,
  CONTADOR_CODEX_BIN,
  CONTADOR_CODEX_WORKSPACE,
  CONTADOR_SESSION_ID,
  CONTADOR_HEARTBEAT_HOUR,
  CONTADOR_MONTHLY_DAY,
  CONTADOR_FINANCIAL_APPROVAL_ENABLED,
  CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID,
  CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS,
  CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES,
};
