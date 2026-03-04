/**
 * Route: User Log Dumps
 *
 * Receives diagnostic log dumps from mobile app users and stores them
 * for later analysis. Auto-purges entries older than 3 days.
 *
 * @route   POST /api/telemetry/user-logs   — submit logs (no auth)
 * @route   GET  /api/telemetry/user-logs   — query logs (requires secret)
 */

const { Router } = require('express');
const express = require('express');
const { db } = require('../lib/db');
const { LOG_TAG } = require('../lib/constants');
const { requireSecret } = require('../middleware/auth');

const router = Router();

// JSON body parser (user-logs payloads are not gzip-compressed from mobile)
router.use(express.json({ limit: '5mb' }));

/** Auto-purge retention: 3 days in milliseconds. */
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

// ─── Prepared Statements ────────────────────────────────────────────────────────

const insertDump = db.prepare(`
  INSERT INTO user_log_dumps (
    received_at, user_id, device_id, app_version, platform, logs_json
  ) VALUES (
    @received_at, @user_id, @device_id, @app_version, @platform, @logs_json
  )
`);

const queryByUser = db.prepare(`
  SELECT id, received_at, user_id, device_id, app_version, platform, logs_json
  FROM user_log_dumps
  WHERE user_id = ?
  ORDER BY received_at DESC
  LIMIT ?
`);

const queryAll = db.prepare(`
  SELECT id, received_at, user_id, device_id, app_version, platform,
         LENGTH(logs_json) AS logs_size
  FROM user_log_dumps
  ORDER BY received_at DESC
  LIMIT ?
`);

const purgeOld = db.prepare(`
  DELETE FROM user_log_dumps WHERE received_at < ?
`);

// ─── POST: Submit logs ──────────────────────────────────────────────────────────

router.post('/', (req, res) => {
    try {
        const { user_id, device_id, app_version, platform, logs } = req.body;

        if (!logs || typeof logs !== 'object') {
            return res.status(400).json({ error: 'Invalid payload: logs object required' });
        }

        const receivedAt = Date.now();

        // Auto-purge old entries
        const purged = purgeOld.run(receivedAt - RETENTION_MS);
        if (purged.changes > 0) {
            console.log(`${LOG_TAG} Purged ${purged.changes} expired log dumps`);
        }

        const result = insertDump.run({
            received_at: receivedAt,
            user_id: user_id || null,
            device_id: device_id || null,
            app_version: app_version || null,
            platform: platform || null,
            logs_json: JSON.stringify(logs),
        });

        const appLogCount = Array.isArray(logs.app_logs) ? logs.app_logs.length : 0;
        const networkLogCount = Array.isArray(logs.network_logs) ? logs.network_logs.length : 0;

        console.log(
            `${LOG_TAG} Received log dump from user=${user_id || 'anonymous'} ` +
            `(${appLogCount} app logs, ${networkLogCount} network logs)`
        );

        res.status(202).json({
            success: true,
            id: Number(result.lastInsertRowid),
            app_logs: appLogCount,
            network_logs: networkLogCount,
        });
    } catch (err) {
        console.error(`${LOG_TAG} Error storing log dump:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── GET: Query logs (requires auth) ────────────────────────────────────────────

router.get('/', requireSecret, (req, res) => {
    try {
        const { user_id } = req.query;
        const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

        if (user_id) {
            const rows = queryByUser.all(user_id, limit);
            return res.json({
                user_id,
                count: rows.length,
                dumps: rows.map(formatDump),
            });
        }

        // No user_id — return summary list (without full logs to keep response small)
        const rows = queryAll.all(limit);
        res.json({
            count: rows.length,
            dumps: rows.map((row) => ({
                id: row.id,
                received_at: row.received_at,
                user_id: row.user_id,
                device_id: row.device_id,
                app_version: row.app_version,
                platform: row.platform,
                logs_size: row.logs_size,
            })),
        });
    } catch (err) {
        console.error(`${LOG_TAG} Error querying log dumps:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function formatDump(row) {
    let logs;
    try {
        logs = JSON.parse(row.logs_json);
    } catch {
        logs = null;
    }

    return {
        id: row.id,
        received_at: row.received_at,
        user_id: row.user_id,
        device_id: row.device_id,
        app_version: row.app_version,
        platform: row.platform,
        logs,
    };
}

module.exports = router;
