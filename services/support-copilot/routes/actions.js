/**
 * Actions Routes — Support Copilot
 *
 * Operator action shortcuts: start recharge, reset station, station status.
 * All actions are configurable per brand and logged in audit_log.
 *
 * @module routes/actions
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { LOG_TAG } = require('../lib/constants');
const { db, stmts, nowIso } = require('../lib/db');

// ─── Configurable action registry ────────────────────────────────────────────

/**
 * Default action config — can be overridden per brand via copilot_settings.
 * Each action can be: true (enabled), false (disabled), or "super_admin" (restricted).
 */
const DEFAULT_ACTION_CONFIG = {
  'station-status':   true,
  'start-recharge':   true,
  'reset-station':    true,    // potentially destructive
};

/**
 * Get the action config for a brand. Merges defaults with brand overrides.
 */
function getActionConfig(brandId) {
  try {
    const row = db.prepare(
      'SELECT tone_rules FROM copilot_settings WHERE brand_id = ?'
    ).get(brandId);
    if (row) {
      // Try to parse action_config from settings JSON if stored there
      const settings = db.prepare(
        `SELECT json_extract(metadata_json, '$.action_config') as config
         FROM copilot_settings WHERE brand_id = ?`
      ).get(brandId);
      if (settings?.config) {
        try {
          return { ...DEFAULT_ACTION_CONFIG, ...JSON.parse(settings.config) };
        } catch { /* use defaults */ }
      }
    }
  } catch { /* use defaults */ }
  return { ...DEFAULT_ACTION_CONFIG };
}

/**
 * Check if an action is allowed for the current brand.
 */
function isActionAllowed(brandId, actionName) {
  const config = getActionConfig(brandId);
  return config[actionName] === true || config[actionName] === 'super_admin';
}

/**
 * Log an action to the audit_log table with tool usage tracking.
 */
function logAction(brandId, conversationId, action, actorUserId, metadata = {}) {
  const id = `act_${crypto.randomBytes(8).toString('hex')}`;
  try {
    db.prepare(
      `INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, brandId, conversationId, action, actorUserId || 'operator', JSON.stringify(metadata), nowIso());
    console.log(`${LOG_TAG} Action logged: ${action} for ${brandId} (conv: ${conversationId || 'none'})`);
  } catch (err) {
    console.warn(`${LOG_TAG} Failed to log action:`, err.message);
  }
  return id;
}

// ─── Context enrichment imports ──────────────────────────────────────────────

const { getChargerStatus, getRecentOcppEvents, lookupStation, getRecentApiErrors, getStationStatusBatch } = require('../lib/context-enrichment');

// ─── GET /api/support/actions/:brandId/config ────────────────────────────────

/**
 * Returns the current action config for a brand.
 * Used by the frontend to show/hide action buttons.
 */
router.get('/:brandId/config', (req, res) => {
  const { brandId } = req.params;
  const config = getActionConfig(brandId);
  res.json(config);
});

// ─── GET /api/support/actions/:brandId/station-status/:stationId ─────────────

/**
 * Returns OCPP status and recent events for a station.
 * Useful for diagnosis before deciding to reset.
 */
router.get('/:brandId/station-status/:stationId', (req, res) => {
  const { brandId, stationId } = req.params;

  if (!isActionAllowed(brandId, 'station-status')) {
    return res.status(403).json({ error: 'Action disabled for this brand' });
  }

  try {
    const status = getChargerStatus(stationId);
    const stationInfo = lookupStation(stationId);
    const events = getRecentOcppEvents(stationId, 10);

    // Log this lookup
    logAction(brandId, req.query.conversationId || null, 'station-status', null, {
      stationId,
      found: !!(status || stationInfo),
    });

    res.json({
      stationId,
      station: stationInfo,
      currentStatus: status ? {
        message: status.message,
        timestamp: status.timestamp,
        age: status.timestamp ? `${Math.round((Date.now() - status.timestamp) / 60000)}min ago` : null,
      } : null,
      recentEvents: events.map(e => ({
        time: new Date(e.timestamp).toLocaleTimeString('pt-BR'),
        type: e.event_type,
        category: e.category,
        severity: e.severity,
        message: e.message?.substring(0, 150),
      })),
    });
  } catch (err) {
    console.error(`${LOG_TAG} Station status error:`, err.message);
    res.status(500).json({ error: 'Failed to get station status' });
  }
});

// ─── GET /api/support/actions/:brandId/conversation-tools/:conversationId ────

/**
 * Returns the list of tools/actions used in a conversation.
 * This is displayed in the chat as internal-only metadata.
 */
router.get('/:brandId/conversation-tools/:conversationId', (req, res) => {
  const { brandId, conversationId } = req.params;

  try {
    const actions = db.prepare(
      `SELECT action, metadata_json, created_at FROM audit_log
       WHERE brand_id = ? AND conversation_id = ?
       ORDER BY datetime(created_at) ASC`
    ).all(brandId, conversationId);

    const tools = actions.map(a => {
      let meta = {};
      try { meta = JSON.parse(a.metadata_json || '{}'); } catch { /* */ }
      return {
        action: a.action,
        timestamp: a.created_at,
        details: meta,
      };
    });

    res.json({ conversationId, tools });
  } catch (err) {
    console.error(`${LOG_TAG} Conversation tools error:`, err.message);
    res.status(500).json({ error: 'Failed to get conversation tools' });
  }
});

// ─── POST /api/support/actions/:brandId/start-recharge ───────────────────────

/**
 * Initiate a charging session for a user.
 * Proxies to the Next.js /api/recharge/start-transaction endpoint.
 */
router.post('/:brandId/start-recharge', async (req, res) => {
  const { brandId } = req.params;
  const { userId, stationId, connectorId, conversationId } = req.body;

  if (!isActionAllowed(brandId, 'start-recharge')) {
    return res.status(403).json({ error: 'Action disabled for this brand' });
  }

  if (!userId || !stationId || !connectorId) {
    return res.status(400).json({ error: 'Missing required fields: userId, stationId, connectorId' });
  }

  // Log the action attempt
  const actionId = logAction(brandId, conversationId, 'start-recharge', null, {
    userId, stationId, connectorId, status: 'initiated',
  });

  try {
    // Use the Next.js API to start the transaction
    const NEXT_API_URL = process.env.NEXT_API_URL || 'https://app.turbostation.com.br';
    const NEXT_API_KEY = process.env.NEXT_API_KEY || '';

    const response = await fetch(`${NEXT_API_URL}/api/recharge/start-transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(NEXT_API_KEY ? { 'Authorization': `Bearer ${NEXT_API_KEY}` } : {}),
        'x-api-key': NEXT_API_KEY,
      },
      body: JSON.stringify({
        charger_id: stationId,
        connector_id: connectorId,
        user_id: userId,
      }),
    });

    const result = await response.json();

    // Update audit log with result
    logAction(brandId, conversationId, 'start-recharge-result', null, {
      userId, stationId, connectorId,
      success: result.success,
      error: result.error || null,
      transactionId: result.details?.transaction?.id || null,
      actionId,
    });

    res.status(response.status).json(result);
  } catch (err) {
    console.error(`${LOG_TAG} Start recharge error:`, err.message);
    logAction(brandId, conversationId, 'start-recharge-error', null, {
      userId, stationId, connectorId, error: err.message, actionId,
    });
    res.status(500).json({ error: 'Failed to start recharge: ' + err.message });
  }
});

// ─── POST /api/support/actions/:brandId/reset-station ────────────────────────

/**
 * Reset a charging station (Soft or Hard reset).
 * Proxies to the Next.js /api/stations/:id/reset endpoint.
 */
router.post('/:brandId/reset-station', async (req, res) => {
  const { brandId } = req.params;
  const { stationId, resetType = 'Soft', conversationId } = req.body;

  if (!isActionAllowed(brandId, 'reset-station')) {
    return res.status(403).json({ error: 'Action disabled for this brand' });
  }

  if (!stationId) {
    return res.status(400).json({ error: 'Missing required field: stationId' });
  }

  if (!['Soft', 'Hard'].includes(resetType)) {
    return res.status(400).json({ error: 'resetType must be "Soft" or "Hard"' });
  }

  // Log the action attempt
  const actionId = logAction(brandId, conversationId, 'reset-station', null, {
    stationId, resetType, status: 'initiated',
  });

  try {
    const NEXT_API_URL = process.env.NEXT_API_URL || 'https://app.turbostation.com.br';
    const NEXT_API_KEY = process.env.NEXT_API_KEY || '';

    const response = await fetch(`${NEXT_API_URL}/api/stations/${encodeURIComponent(stationId)}/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(NEXT_API_KEY ? { 'Authorization': `Bearer ${NEXT_API_KEY}` } : {}),
        'x-api-key': NEXT_API_KEY,
        'x-brand-id': brandId,
      },
      body: JSON.stringify({ resetType }),
    });

    const result = await response.json();

    // Update audit log with result
    logAction(brandId, conversationId, 'reset-station-result', null, {
      stationId, resetType,
      success: result.success,
      error: result.error || null,
      actionId,
    });

    res.status(response.status).json(result);
  } catch (err) {
    console.error(`${LOG_TAG} Reset station error:`, err.message);
    logAction(brandId, conversationId, 'reset-station-error', null, {
      stationId, resetType, error: err.message, actionId,
    });
    res.status(500).json({ error: 'Failed to reset station: ' + err.message });
  }
});

// ─── GET /api/support/actions/:brandId/enriched-context ──────────────────────

/**
 * Returns enriched context for a conversation.
 * Fetches station status for recent recharge stations, Vercel errors, etc.
 */
router.get('/:brandId/enriched-context', (req, res) => {
  const { brandId } = req.params;
  const { stationIds, userId, conversationId } = req.query;

  try {
    const result = {};

    // Station status batch
    if (stationIds) {
      const ids = String(stationIds).split(',').filter(Boolean).slice(0, 5);
      result.stations = getStationStatusBatch(ids);
    }

    // Vercel API errors for user
    if (userId) {
      result.apiErrors = getRecentApiErrors(String(userId), 5);
    }

    // Log enrichment request
    logAction(brandId, conversationId || null, 'context-enrichment', null, {
      stationIds: stationIds || null,
      userId: userId || null,
      stationCount: result.stations?.length || 0,
      errorCount: result.apiErrors?.length || 0,
    });

    res.json(result);
  } catch (err) {
    console.error(`${LOG_TAG} Enriched context error:`, err.message);
    res.status(500).json({ error: 'Failed to get enriched context' });
  }
});

module.exports = router;
