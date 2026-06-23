/**
 * Route: Funnel Counts (real prod-log signal)
 *
 * Returns REAL payment + recharge activity for a time window, sourced from the
 * Vercel log drain (`db/vercel.db`, table `vercel_requests` — 1 row per request),
 * NOT from mobile telemetry. The deploy-watch cron uses this as ground truth so a
 * dead/empty mobile-telemetry feed can no longer render as "nada anormal" while
 * real charges and payments are flowing.
 *
 * @route   GET /api/telemetry/funnel-counts
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @query   start_ms  epoch ms, inclusive lower bound (required)
 * @query   end_ms    epoch ms, exclusive upper bound (required, must be > start_ms)
 *
 * @returns {{
 *   ok: true,
 *   startMs: number, endMs: number,
 *   drainLastTs: number|null,   // max(last_ts) across the drain — freshness probe
 *   payments:  { processOk, processFailed, webhookOk },
 *   recharges: { started, failed }
 * }}
 *
 * Categories (endpoints are stable contracts of the Next.js app):
 *   - payments.processOk/Failed → POST /api/payments/process (the app charging a
 *     customer / buying credits). 2xx = money moved, 4xx/5xx = failed attempt.
 *   - payments.webhookOk        → POST /api/webhooks/pagarme 2xx (Pagar.me
 *     liveness; not 1:1 with payments, kept as a secondary signal).
 *   - recharges.started/failed  → POST /api/stations/{id}/connectors/{c}/transaction.
 *     2xx (200/201/202) = a recharge session start was accepted; 5xx = server
 *     failure. 4xx (e.g. 403 busy/forbidden) is a user-side reject, NOT a failure.
 *
 * Security/LGPD: aggregate counts only — never a body, user_id, or any PII leaves
 * here. Read-only connection; this route never writes.
 */

const { Router } = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { LOG_TAG } = require('../lib/constants');

const router = Router();

// vercel.db is a sibling of mobile.db under db/, written by the vercel-drain
// service. Opened lazily, read-only, and cached for the process lifetime.
const VERCEL_DB_PATH = path.join(__dirname, '..', '..', '..', 'db', 'vercel.db');
let vdb = null;
function getVercelDb() {
    if (vdb) return vdb;
    vdb = new Database(VERCEL_DB_PATH, { readonly: true, fileMustExist: true });
    vdb.pragma('busy_timeout = 5000');
    return vdb;
}

const PAYMENT_PROCESS = '/api/payments/process';
const PAGARME_WEBHOOK = '/api/webhooks/pagarme';
const TX_START_LIKE = '/api/stations/%/connectors/%/transaction';

router.get('/', (req, res) => {
    try {
        const startMs = Number(req.query.start_ms);
        const endMs = Number(req.query.end_ms);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return res
                .status(400)
                .json({ error: 'start_ms and end_ms are required (end_ms > start_ms)' });
        }

        const db = getVercelDb();

        const pay = db
            .prepare(
                `SELECT
                   SUM(CASE WHEN endpoint = @proc AND status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS processOk,
                   SUM(CASE WHEN endpoint = @proc AND status_code >= 400 THEN 1 ELSE 0 END) AS processFailed,
                   SUM(CASE WHEN endpoint = @hook AND status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS webhookOk
                 FROM vercel_requests
                 WHERE last_ts >= @start AND last_ts < @end
                   AND endpoint IN (@proc, @hook)`,
            )
            .get({ start: startMs, end: endMs, proc: PAYMENT_PROCESS, hook: PAGARME_WEBHOOK });

        const rec = db
            .prepare(
                `SELECT
                   SUM(CASE WHEN status_code IN (200, 201, 202) THEN 1 ELSE 0 END) AS started,
                   SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS failed
                 FROM vercel_requests
                 WHERE last_ts >= @start AND last_ts < @end
                   AND method = 'POST'
                   AND endpoint LIKE @like`,
            )
            .get({ start: startMs, end: endMs, like: TX_START_LIKE });

        const lastTsRow = db.prepare('SELECT MAX(last_ts) AS t FROM vercel_requests').get();

        res.set('Cache-Control', 'no-store').json({
            ok: true,
            startMs,
            endMs,
            drainLastTs: lastTsRow && lastTsRow.t != null ? Number(lastTsRow.t) : null,
            payments: {
                processOk: (pay && pay.processOk) || 0,
                processFailed: (pay && pay.processFailed) || 0,
                webhookOk: (pay && pay.webhookOk) || 0,
            },
            recharges: {
                started: (rec && rec.started) || 0,
                failed: (rec && rec.failed) || 0,
            },
        });
    } catch (err) {
        console.error(`${LOG_TAG} funnel-counts error:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
