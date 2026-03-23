/**
 * Context Enrichment — Support Copilot
 *
 * Fetches operational data from OCPP, Vercel, and station sources
 * to enrich the copilot prompt with diagnostic information.
 *
 * All access is read-only. Data is filtered by user/charger to comply with LGPD.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { LOG_TAG } = require('./constants');

// ─── DB paths (read-only) ────────────────────────────────────────────────────
const DB_DIR = path.join(__dirname, '..', '..', '..', 'db');
const OCPP_DB_PATH = path.join(DB_DIR, 'ocpp.db');
const VERCEL_DB_PATH = path.join(DB_DIR, 'vercel.db');
const STATIONS_MAP_PATH = path.join(__dirname, '..', '..', '..', 'history', 'stations-map.json');

// Lazy-init DBs (only open when needed)
let ocppDb = null;
let vercelDb = null;

function getOcppDb() {
  if (!ocppDb) {
    try {
      ocppDb = new Database(OCPP_DB_PATH, { readonly: true });
      ocppDb.pragma('journal_mode = WAL');
    } catch (err) {
      console.warn(`${LOG_TAG} Cannot open OCPP DB: ${err.message}`);
      return null;
    }
  }
  return ocppDb;
}

function getVercelDb() {
  if (!vercelDb) {
    try {
      vercelDb = new Database(VERCEL_DB_PATH, { readonly: true });
      vercelDb.pragma('journal_mode = WAL');
    } catch (err) {
      console.warn(`${LOG_TAG} Cannot open Vercel DB: ${err.message}`);
      return null;
    }
  }
  return vercelDb;
}

// ─── Station lookup ──────────────────────────────────────────────────────────

function lookupStation(chargerId) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(STATIONS_MAP_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(STATIONS_MAP_PATH, 'utf-8'));
    return data.stations?.[chargerId] || null;
  } catch {
    return null;
  }
}

// ─── OCPP context ────────────────────────────────────────────────────────────

/**
 * Sanitize OCPP meta field to prevent LGPD cross-contamination.
 * Removes user IDs from the meta JSON that don't belong to the current user.
 *
 * @param {string|null} metaJson - Raw meta field from ocpp_events
 * @param {string|null} allowedUserId - The current user's ID (keep this one if found)
 * @returns {object|null} Sanitized meta object
 */
function sanitizeOcppMeta(metaJson, allowedUserId) {
  if (!metaJson) return null;
  try {
    const meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson;
    // Remove any userId/user_id fields that are not the allowed user
    const sensitiveKeys = ['userId', 'user_id', 'uid', 'idTag', 'id_tag'];
    for (const key of sensitiveKeys) {
      if (meta[key] && meta[key] !== allowedUserId) {
        meta[key] = '[REDACTED]';
      }
    }
    // Also check nested objects
    if (meta.data && typeof meta.data === 'object') {
      for (const key of sensitiveKeys) {
        if (meta.data[key] && meta.data[key] !== allowedUserId) {
          meta.data[key] = '[REDACTED]';
        }
      }
    }
    return meta;
  } catch {
    return null;
  }
}

/**
 * Get recent OCPP events for a charger (last 24h).
 * Optionally sanitizes the meta field for LGPD compliance.
 */
function getRecentOcppEvents(chargerId, limitRows = 10, allowedUserId = null) {
  const db = getOcppDb();
  if (!db || !chargerId) return [];

  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db.prepare(`
      SELECT timestamp, charger_id, event_type, category, severity, message, meta
      FROM ocpp_events
      WHERE charger_id = ? AND timestamp > ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(chargerId, cutoff, limitRows);

    // Sanitize meta if we have an allowed user
    if (allowedUserId) {
      for (const row of rows) {
        row.meta = sanitizeOcppMeta(row.meta, allowedUserId);
      }
    } else {
      // Strip meta entirely if no user context (prevent leakage)
      for (const row of rows) {
        delete row.meta;
      }
    }

    return rows;
  } catch (err) {
    console.warn(`${LOG_TAG} OCPP query error: ${err.message}`);
    return [];
  }
}

/**
 * Get the latest charger status from ocpp_events.
 */
function getChargerStatus(chargerId) {
  const db = getOcppDb();
  if (!db || !chargerId) return null;

  try {
    const row = db.prepare(`
      SELECT message, timestamp
      FROM ocpp_events
      WHERE charger_id = ? AND category IN ('status_notification', 'charger_status', 'status_notification_available', 'status_notification_charging', 'status_notification_faulted')
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(chargerId);
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Get OCPP status for multiple stations at once.
 * Returns an array of { stationId, status, station, recentEvents }.
 */
function getStationStatusBatch(chargerIds) {
  if (!Array.isArray(chargerIds) || chargerIds.length === 0) return [];

  return chargerIds.map(id => {
    const status = getChargerStatus(id);
    const station = lookupStation(id);
    const events = getRecentOcppEvents(id, 3);

    return {
      stationId: id,
      station: station ? { name: station.name, location: station.location } : null,
      currentStatus: status ? {
        message: status.message,
        timestamp: status.timestamp,
        age: status.timestamp ? `${Math.round((Date.now() - status.timestamp) / 60000)}min` : null,
      } : null,
      recentEvents: events.map(e => ({
        time: new Date(e.timestamp).toLocaleTimeString('pt-BR'),
        category: e.category,
        severity: e.severity,
        message: e.message?.substring(0, 100),
      })),
    };
  });
}

// ─── Vercel API context ──────────────────────────────────────────────────────

/**
 * Get recent API errors from Vercel logs (last 2h, filtered by user-related endpoints).
 * Expanded to include recharge, transaction, and payment endpoints.
 */
function getRecentApiErrors(userId, limitRows = 5) {
  const db = getVercelDb();
  if (!db || !userId) return [];

  try {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000; // last 2h (was 1h)
    return db.prepare(`
      SELECT timestamp, endpoint, status_code, body
      FROM vercel_logs
      WHERE timestamp > ? AND (status_code >= 400 OR level = 'error')
      AND (
        body LIKE ? OR endpoint LIKE ?
        OR endpoint LIKE '%recharge%'
        OR endpoint LIKE '%transaction%'
        OR endpoint LIKE '%payment%'
        OR endpoint LIKE '%station%'
      )
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(cutoff, `%${userId}%`, `%${userId}%`, limitRows);
  } catch (err) {
    console.warn(`${LOG_TAG} Vercel query error: ${err.message}`);
    return [];
  }
}

// ─── Main enrichment function ────────────────────────────────────────────────

/**
 * Enrich context based on conversation tags and user data.
 * Returns a string block to append to the copilot prompt.
 *
 * @param {{ tags: string[], userData: object|null, lastChargerId?: string }} opts
 * @returns {string} Context block for the prompt (empty string if nothing relevant)
 */
function enrichContext({ tags = [], userData = null } = {}) {
  const blocks = [];

  // Determine what data to fetch based on tags
  const needsCharger = tags.some(t => ['carregamento', 'erro', 'estação', 'estacao', 'conector', 'charging'].includes(t));
  const needsBilling = tags.some(t => ['cobrança', 'pagamento', 'taxa', 'crédito', 'credito', 'billing'].includes(t));

  // Try to find charger ID from userData or tags
  const chargerId = userData?.lastChargerId || userData?.chargerId || null;

  // OCPP: charger status and recent events
  if (needsCharger && chargerId) {
    const status = getChargerStatus(chargerId);
    const station = lookupStation(chargerId);
    if (status || station) {
      const parts = [];
      if (station) parts.push(`Estação: ${station.name} (${station.location || 'localização desconhecida'})`);
      if (status) parts.push(`Último status: ${status.message} (${new Date(status.timestamp).toLocaleString('pt-BR')})`);
      blocks.push(parts.join('\n'));
    }

    const events = getRecentOcppEvents(chargerId, 5, userData?.id);
    if (events.length > 0) {
      const eventLines = events.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString('pt-BR');
        return `  ${time} — ${e.message?.substring(0, 100) || e.category}`;
      });
      blocks.push(`Eventos recentes (${chargerId}):\n${eventLines.join('\n')}`);
    }
  }

  // Station status for recent recharges (even without specific tags)
  if (userData?.recentRecharges && userData.recentRecharges.length > 0) {
    const rechargeStationIds = [...new Set(
      userData.recentRecharges
        .map(r => r.station)
        .filter(Boolean)
    )].slice(0, 3);

    if (rechargeStationIds.length > 0 && !chargerId) {
      // Only add if we didn't already fetch a specific charger above
      const stationStatuses = getStationStatusBatch(rechargeStationIds);
      const statusLines = stationStatuses
        .filter(s => s.currentStatus)
        .map(s => {
          const name = s.station?.name || s.stationId;
          return `  ${name}: ${s.currentStatus.message} (${s.currentStatus.age} atrás)`;
        });
      if (statusLines.length > 0) {
        blocks.push(`Status das estações recentes:\n${statusLines.join('\n')}`);
      }
    }
  }

  // Vercel: API errors for this user
  if ((needsBilling || needsCharger) && userData?.id) {
    const errors = getRecentApiErrors(userData.id, 3);
    if (errors.length > 0) {
      const errorLines = errors.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString('pt-BR');
        return `  ${time} — ${e.endpoint || '?'} → ${e.status_code} ${e.body?.substring(0, 80) || ''}`;
      });
      blocks.push(`Erros recentes na API (usuário ${userData.id}):\n${errorLines.join('\n')}`);
    }
  }

  // User credits/balance
  if (userData) {
    const userParts = [];
    if (typeof userData.credits === 'number') {
      userParts.push(`Créditos: R$ ${(userData.credits / 100).toFixed(2)}`);
    }
    if (userData.lastTransaction) {
      userParts.push(`Última transação: ${userData.lastTransaction}`);
    }
    if (userParts.length > 0) {
      blocks.push(userParts.join(' | '));
    }
  }

  if (blocks.length === 0) return '';

  return [
    '',
    '[DADOS INTERNOS — use para diagnóstico, NÃO compartilhe diretamente com o cliente]:',
    ...blocks,
  ].join('\n');
}

module.exports = {
  enrichContext,
  lookupStation,
  getRecentOcppEvents,
  getChargerStatus,
  getRecentApiErrors,
  getStationStatusBatch,
  sanitizeOcppMeta,
};
