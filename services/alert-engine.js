#!/usr/bin/env node
/**
 * Alert Engine - Phase 4
 * 
 * Monitors logs.db for Vercel issues and OCPP+Vercel correlations.
 * Generates alerts and sends them via Telegram (temporary) / WhatsApp (legacy).
 * 
 * Runs every 1-2 minutes via PM2.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { lookupStation } = require('./station-lookup');
const { notifyPartnerFault } = require('./partner-fault-notifier');
const { parseStatusNotif, isEmergencyStopFault, isCableTheftSuspectFault } = require('./ocpp-utils');

// NOTE: Data is split across dedicated DBs
const DB_DIR = path.join(__dirname, '..', 'db');
const OCPP_DB_PATH = path.join(DB_DIR, 'ocpp.db');
const VERCEL_DB_PATH = path.join(DB_DIR, 'vercel.db');
const MOBILE_DB_PATH = path.join(DB_DIR, 'mobile.db');

// Alert state is persisted in a small local DB (legacy: logs.db only stores alerts now)
const ALERTS_DB_PATH = path.join(DB_DIR, 'logs.db');
// Temporary: send alerts to Telegram while we polish alert quality
// Disabled by default (Thiago request 2026-02-26). To enable:
//   export ALERT_TELEGRAM_GROUP='telegram:-5102620169'
const TELEGRAM_GROUP = process.env.ALERT_TELEGRAM_GROUP || null;
// WhatsApp alerts via the support-copilot → Evolution transport (the openclaw
// WhatsApp-Web gateway is NOT linked, so `openclaw message send` fails). This is
// the same path the Next whatsapp-notifier and the manual tests use, confirmed
// delivering to the "Notificações Turbo Station" group. Set ALERT_WHATSAPP_CONV=''
// to disable WhatsApp dispatch.
const WHATSAPP_CONV = process.env.ALERT_WHATSAPP_CONV !== undefined
    ? process.env.ALERT_WHATSAPP_CONV
    : 'conv_jiuijxjtmnet23i9';
const WHATSAPP_BRAND = process.env.ALERT_WHATSAPP_BRAND || 'turbo_station';
// Urgent alerts (cable-theft suspects) additionally go to the dedicated
// "Turbo Station + URGENTE" WhatsApp group. Same support-copilot transport as
// the normal group. Set ALERT_URGENT_WHATSAPP_CONV='' to disable.
const URGENT_WHATSAPP_CONV = process.env.ALERT_URGENT_WHATSAPP_CONV !== undefined
    ? process.env.ALERT_URGENT_WHATSAPP_CONV
    : 'conv_i7ljlrvrmrl33ohs';
const SUPPORT_API_BASE = (process.env.SUPPORT_API_URL || 'https://logs.turbostation.com.br').replace(/\/+$/, '');
const SUPPORT_API_SECRET = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '';

// Freshness guard
const MAX_ALERT_AGE_MS = 10 * 60 * 1000; // never send alerts older than 10 minutes


// Debounce settings
const DEBOUNCE_FILE = path.join(__dirname, '..', 'history', 'alert_engine_debounce.json');
const DEBOUNCE_WINDOW = 60 * 60 * 1000; // 1 hour

// Time windows for queries (in milliseconds)
const QUERY_WINDOW = 5 * 60 * 1000; // Last 5 minutes
const CORRELATION_WINDOW = 30 * 1000; // ±30 seconds for correlation

// --- Causal correlation gate (added 2026-06-12) --------------------------
// A charger fault and a backend error are only CAUSALLY related when the
// backend failure could actually have blocked a charge action on THAT charger
// (e.g. user hit "start charge" → the start route 5xx'd → the charger never
// started). Mere temporal coincidence — any 4xx/5xx anywhere in the ±30s
// window — was the #1 false-critical source: a random `/api/stations/accessible
// 403` + `/api/users/<uid> 404` got bundled as "backend afetou carregador".
//
// We now require BOTH:
//   (a) the backend endpoint is a charge-ACTION route (start/stop/authorize/…),
//   (b) it references THIS charger's id/serial in its path or query.
// Generic reads (analytics, pricing, health, accessible, user lookups) and
// errors on other chargers never escalate a fault to critical. Charger faults
// and backend errors otherwise alert as two independent streams.
const CHARGE_ACTION_ROUTE = /(remote[-_]?start|remote[-_]?stop|start[-_]?transaction|stop[-_]?transaction|\/authorize\b|\/pnc\/|\/charging\b|\/charge\b|\/sessions?\b)/i;

function endpointReferencesCharger(endpoint, chargerId) {
    if (!endpoint || !chargerId) return false;
    return String(endpoint).includes(String(chargerId));
}

function isCausalBackendError(endpoint, chargerId) {
    if (!endpoint) return false;
    return CHARGE_ACTION_ROUTE.test(endpoint) && endpointReferencesCharger(endpoint, chargerId);
}

// Ingest watchdog (if no new rows, alert)
const INGEST_STALL_OCPP_MS = 10 * 60 * 1000;
const INGEST_STALL_VERCEL_MS = 10 * 60 * 1000;
const INGEST_STALL_MOBILE_MS = 2 * 60 * 60 * 1000;

// --- Escalating backoff for chronic charger faults (added 2026-07-07) -----
// The flat 1h debounce re-alerts a charger stuck on the SAME fault forever.
// One charger alone produced 165 of 306 alerts sent to the group in 7 days,
// firing on the dot every hour non-stop — that's what trains people to stop
// reading the channel. Back off the re-alert cadence the longer the same
// charger+error persists; a chronic fault becomes a daily heartbeat instead
// of an hourly ping. `afterStreak` is the number of PRIOR alerts already
// sent for this key before the tier applies.
const CHARGER_FAULT_BACKOFF_TIERS = [
    { afterStreak: 0, windowMs: 60 * 60 * 1000 },       // alerts 1-3: hourly
    { afterStreak: 3, windowMs: 6 * 60 * 60 * 1000 },   // alerts 4-8: every 6h
    { afterStreak: 8, windowMs: 24 * 60 * 60 * 1000 },  // alerts 9+: daily
];
const CHARGER_FAULT_BACKOFF_FILE = path.join(__dirname, '..', 'history', 'charger_fault_backoff.json');

function windowForStreak(streak) {
    let win = CHARGER_FAULT_BACKOFF_TIERS[0].windowMs;
    for (const tier of CHARGER_FAULT_BACKOFF_TIERS) {
        if (streak >= tier.afterStreak) win = tier.windowMs;
    }
    return win;
}

class AlertEngine {
    constructor() {
        // Data DBs
        // (Opened read-write to avoid crashing if the DB is created on first run.
        // We only SELECT from them in this file.)
        this.ocppDb = new Database(OCPP_DB_PATH);
        this.vercelDb = new Database(VERCEL_DB_PATH);
        this.mobileDb = new Database(MOBILE_DB_PATH);

        this.ocppDb.pragma('journal_mode = WAL');
        this.vercelDb.pragma('journal_mode = WAL');
        this.mobileDb.pragma('journal_mode = WAL');

        this.ocppDb.pragma('busy_timeout = 5000');
        this.vercelDb.pragma('busy_timeout = 5000');
        this.mobileDb.pragma('busy_timeout = 5000');

        // Alerts DB (write)
        this.alertsDb = new Database(ALERTS_DB_PATH);
        this.alertsDb.pragma('journal_mode = WAL'); // Better concurrent performance
        this.initAlertsSchema();

        this.debounceCache = this.loadDebounceCache();
        this.chargerFaultBackoff = this.loadChargerFaultBackoff();

        // NOTE: Startup replay disabled.
        // This process is meant to be long-running (interval loop). Replaying on restart caused
        // duplicates and "Invalid Date" issues when older rows lacked full context.
    }

    initAlertsSchema() {
        // Keep alerts schema local to the alert engine; safe if it already exists.
        this.alertsDb.exec(`
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at INTEGER NOT NULL,
                charger_id TEXT,
                severity TEXT CHECK(severity IN ('critical', 'warning', 'info')),
                title TEXT NOT NULL,
                description TEXT,
                ocpp_log_ids TEXT,
                vercel_log_ids TEXT,
                evidence_json TEXT,
                sent BOOLEAN DEFAULT 0,
                sent_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent);
        `);

        // Backfill/migrate older DBs that predate evidence_json
        try {
            const cols = this.alertsDb.prepare(`PRAGMA table_info(alerts)`).all().map(r => r.name);
            if (!cols.includes('evidence_json')) {
                this.alertsDb.exec('ALTER TABLE alerts ADD COLUMN evidence_json TEXT');
                console.log('🧱 Migrated alerts DB: added evidence_json column');
            }
        } catch (e) {
            console.error('⚠️ Failed to migrate alerts schema:', e.message);
        }
    }

    loadDebounceCache() {
        try {
            if (fs.existsSync(DEBOUNCE_FILE)) {
                return JSON.parse(fs.readFileSync(DEBOUNCE_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('⚠️ Error loading debounce cache:', e.message);
        }
        return {};
    }

    saveDebounceCache() {
        try {
            fs.writeFileSync(DEBOUNCE_FILE, JSON.stringify(this.debounceCache, null, 2));
        } catch (e) {
            console.error('⚠️ Error saving debounce cache:', e.message);
        }
    }

    /**
     * Check if we should send this alert (debounce logic)
     */
    shouldSendAlert(alertType, chargerIdOrEndpoint = 'global') {
        const key = `${alertType}_${chargerIdOrEndpoint}`;
        const now = Date.now();

        if (this.debounceCache[key]) {
            const timeSince = now - this.debounceCache[key];
            if (timeSince < DEBOUNCE_WINDOW) {
                console.log(`🔇 Debounced: ${key} (sent ${Math.round(timeSince / 1000 / 60)}m ago)`);
                return false;
            }
        }

        this.debounceCache[key] = now;
        this.saveDebounceCache();
        return true;
    }

    loadChargerFaultBackoff() {
        try {
            if (fs.existsSync(CHARGER_FAULT_BACKOFF_FILE)) {
                return JSON.parse(fs.readFileSync(CHARGER_FAULT_BACKOFF_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('⚠️ Error loading charger fault backoff cache:', e.message);
        }
        return {};
    }

    saveChargerFaultBackoff() {
        try {
            fs.writeFileSync(CHARGER_FAULT_BACKOFF_FILE, JSON.stringify(this.chargerFaultBackoff, null, 2));
        } catch (e) {
            console.error('⚠️ Error saving charger fault backoff cache:', e.message);
        }
    }

    /**
     * Escalating debounce for repeat charger+error faults (see
     * CHARGER_FAULT_BACKOFF_TIERS). Returns `false` to skip, or
     * `{ streak, windowMs }` when the alert should send.
     *
     * A gap since the last alert bigger than 2x the window last used resets
     * the streak — the charger likely recovered in between, so the next
     * fault is treated as a fresh incident rather than the same chronic one.
     */
    shouldSendChargerFaultAlert(dedupeKey) {
        const now = Date.now();
        const state = this.chargerFaultBackoff[dedupeKey] || { lastSent: 0, streak: 0, lastWindow: 0 };

        if (state.lastSent) {
            const sinceLast = now - state.lastSent;
            if (sinceLast < state.lastWindow) {
                console.log(`🔇 Debounced (backoff): ${dedupeKey} (${Math.round(sinceLast / 60000)}m of ${Math.round(state.lastWindow / 60000)}m window)`);
                return false;
            }
            if (sinceLast > 2 * state.lastWindow) {
                console.log(`♻️ Backoff reset for ${dedupeKey} (${Math.round(sinceLast / 60000)}m gap — treating as a fresh incident)`);
                state.streak = 0;
            }
        }

        const windowMs = windowForStreak(state.streak);
        const streak = state.streak + 1;
        this.chargerFaultBackoff[dedupeKey] = { lastSent: now, streak, lastWindow: windowMs };
        this.saveChargerFaultBackoff();
        return { streak, windowMs };
    }

    /**
     * Drop backoff entries untouched for >7 days (charger long recovered).
     */
    cleanupChargerFaultBackoff() {
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        let cleaned = 0;

        Object.keys(this.chargerFaultBackoff).forEach(key => {
            if (now - this.chargerFaultBackoff[key].lastSent > weekMs) {
                delete this.chargerFaultBackoff[key];
                cleaned++;
            }
        });

        if (cleaned > 0) {
            this.saveChargerFaultBackoff();
            console.log(`🧹 Cleaned ${cleaned} old charger-fault backoff entries`);
        }
    }

    /**
     * Ingest watchdog: detect if any source DB stopped receiving new rows.
     */
    detectIngestStalls() {
        const now = Date.now();

        const getMaxTs = (db, sql) => {
            try {
                const row = db.prepare(sql).get();
                const v = row ? Object.values(row)[0] : null;
                return typeof v === 'number' ? v : (v ? Number(v) : null);
            } catch (e) {
                return null;
            }
        };

        const ocppMax = getMaxTs(this.ocppDb, 'SELECT MAX(timestamp) AS max_ts FROM ocpp_events');
        const vercelMax = getMaxTs(this.vercelDb, 'SELECT MAX(timestamp) AS max_ts FROM vercel_logs');
        const mobileMax = getMaxTs(this.mobileDb, 'SELECT MAX(received_at) AS max_ts FROM mobile_events');

        const sources = [
            { name: 'ocpp', maxTs: ocppMax, stallMs: INGEST_STALL_OCPP_MS },
            { name: 'vercel', maxTs: vercelMax, stallMs: INGEST_STALL_VERCEL_MS },
            // NOTE (Thiago 2026-02-26): não alertar ingest mobile por enquanto (fonte pode ficar sem eventos e isso é OK)
            // { name: 'mobile', maxTs: mobileMax, stallMs: INGEST_STALL_MOBILE_MS }
        ];

        const alerts = [];

        for (const s of sources) {
            const ageMs = (typeof s.maxTs === 'number') ? (now - s.maxTs) : null;
            const key = `ingest_${s.name}`;

            // If we have never seen any rows, that's a critical blind spot too.
            const isMissing = s.maxTs == null;
            const isStalled = ageMs != null && ageMs > s.stallMs;

            if (!isMissing && !isStalled) continue;
            if (!this.shouldSendAlert('ingest_stall', s.name)) continue;

            const sev = (s.name === 'mobile') ? 'warning' : 'critical';
            const humanAge = ageMs == null ? 'nunca' : `${Math.round(ageMs / 60000)} min`;

            alerts.push({
                type: 'ingest_stall',
                severity: sev,
                title: `Ingest ${s.name} parado/sem dados`,
                description: isMissing
                    ? `Nenhuma linha encontrada no banco de ${s.name} (fonte cega).`
                    : `Última linha do ${s.name} há ${humanAge} (limite ${Math.round(s.stallMs / 60000)} min).`,
                source: s.name,
                // Use NOW for freshness (this is a "health" alert about the current state)
                event_ts: now,
                timestamp: now
            });
        }

        return alerts;
    }

    /**
     * Detect Vercel 5xx errors on OCPP webhooks
     */
    detectVercel5xxErrors() {
        const cutoff = Date.now() - QUERY_WINDOW;
        
        // Catch 5xx on ANY endpoint (was previously scoped to /api/ocpp, which
        // silently missed /api/payments/process etc. — the PIX incident).
        // Grouping by endpoint + shouldSendAlert (1h debounce per endpoint) keeps
        // a storm to one alert per endpoint.
        const query = `
            SELECT id, timestamp, endpoint, status_code, duration_ms, meta
            FROM vercel_logs
            WHERE status_code >= 500
              AND status_code < 600
              AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 50
        `;

        const errors = this.vercelDb.prepare(query).all(cutoff);

        if (errors.length === 0) return [];

        // Group by endpoint to avoid spam
        const groupedByEndpoint = errors.reduce((acc, err) => {
            if (!acc[err.endpoint]) {
                acc[err.endpoint] = [];
            }
            acc[err.endpoint].push(err);
            return acc;
        }, {});

        const alerts = [];
        for (const [endpoint, errs] of Object.entries(groupedByEndpoint)) {
            const firstError = errs[0];
            const count = errs.length;

            if (!this.shouldSendAlert('vercel_5xx', endpoint)) {
                continue;
            }

            const alert = {
                type: 'vercel_5xx',
                severity: 'critical',
                title: `Erro ${firstError.status_code} no backend`,
                description: `${count} erro(s) 5xx em ${endpoint} nos últimos 5 minutos`,
                endpoint: endpoint,
                status_code: firstError.status_code,
                count: count,
                vercel_log_ids: JSON.stringify(errs.map(e => e.id)),
                // use event time (freshness) + keep created_at separately
                event_ts: firstError.timestamp,
                timestamp: Date.now()
            };

            alerts.push(alert);
        }

        return alerts;
    }

    /**
     * Detect Vercel timeouts (empty status + high latency)
     */
    detectVercelTimeouts() {
        const cutoff = Date.now() - QUERY_WINDOW;
        
        const query = `
            SELECT id, timestamp, endpoint, status_code, duration_ms, meta
            FROM vercel_logs
            WHERE (status_code IS NULL OR status_code = 0)
              AND duration_ms > 10000
              AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 10
        `;

        const timeouts = this.vercelDb.prepare(query).all(cutoff);

        if (timeouts.length === 0) return [];

        const groupedByEndpoint = timeouts.reduce((acc, timeout) => {
            if (!acc[timeout.endpoint]) {
                acc[timeout.endpoint] = [];
            }
            acc[timeout.endpoint].push(timeout);
            return acc;
        }, {});

        const alerts = [];
        for (const [endpoint, tmouts] of Object.entries(groupedByEndpoint)) {
            if (!endpoint || endpoint === 'null') continue;

            const firstTimeout = tmouts[0];
            const count = tmouts.length;

            if (!this.shouldSendAlert('vercel_timeout', endpoint)) {
                continue;
            }

            const alert = {
                type: 'vercel_timeout',
                severity: 'critical',
                title: `Timeout no backend`,
                description: `${count} timeout(s) em ${endpoint} (>${Math.round(firstTimeout.duration_ms / 1000)}s)`,
                endpoint: endpoint,
                duration_ms: firstTimeout.duration_ms,
                count: count,
                vercel_log_ids: JSON.stringify(tmouts.map(t => t.id)),
                event_ts: firstTimeout.timestamp,
                timestamp: Date.now()
            };

            alerts.push(alert);
        }

        return alerts;
    }

    /**
     * Detect high latency on critical routes (>2s)
     */
    detectHighLatency() {
        const cutoff = Date.now() - QUERY_WINDOW;
        
        const query = `
            SELECT id, timestamp, endpoint, status_code, duration_ms, meta
            FROM vercel_logs
            WHERE duration_ms > 2000
              AND status_code >= 200
              AND status_code < 400
              AND (
                  endpoint LIKE '%/api/ocpp%'
                  OR endpoint LIKE '%/api/charge%'
                  OR endpoint LIKE '%/api/transaction%'
              )
              AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 20
        `;

        const slowRequests = this.vercelDb.prepare(query).all(cutoff);

        if (slowRequests.length < 5) return []; // Only alert if multiple slow requests

        const groupedByEndpoint = slowRequests.reduce((acc, req) => {
            if (!acc[req.endpoint]) {
                acc[req.endpoint] = [];
            }
            acc[req.endpoint].push(req);
            return acc;
        }, {});

        const alerts = [];
        for (const [endpoint, reqs] of Object.entries(groupedByEndpoint)) {
            if (reqs.length < 3) continue; // Need at least 3 slow requests

            const avgLatency = Math.round(
                reqs.reduce((sum, r) => sum + r.duration_ms, 0) / reqs.length
            );

            if (!this.shouldSendAlert('vercel_latency', endpoint)) {
                continue;
            }

            const alert = {
                type: 'vercel_latency',
                severity: 'warning',
                title: `Alta latência no backend`,
                description: `${reqs.length} requests lentos em ${endpoint} (média: ${avgLatency}ms)`,
                endpoint: endpoint,
                avg_latency_ms: avgLatency,
                count: reqs.length,
                vercel_log_ids: JSON.stringify(reqs.map(r => r.id)),
                event_ts: reqs[0].timestamp,
                timestamp: Date.now()
            };

            alerts.push(alert);
        }

        return alerts;
    }

    /**
     * Correlate charger errors with backend errors (±30s window)
     */
    detectOcppVercelCorrelation() {
        const cutoff = Date.now() - QUERY_WINDOW;

        const safeJsonParse = (s) => {
            try {
                if (s == null) return null;
                if (typeof s !== 'string') return s;
                return JSON.parse(s);
            } catch {
                return null;
            }
        };

        const fetchOcppEvidence = (ocppEventId) => {
            const event = this.ocppDb
                .prepare('SELECT id, timestamp, charger_id, event_type, message, meta FROM ocpp_events WHERE id = ?')
                .get(ocppEventId);
            if (!event) return null;

            // Best-effort: find the closest raw row around the same timestamp for this charger
            const raw = this.ocppDb
                .prepare(
                    `SELECT id, timestamp, raw
                     FROM ocpp_raw
                     WHERE charger_id = ? AND timestamp BETWEEN ? AND ?
                     ORDER BY ABS(timestamp - ?) ASC
                     LIMIT 1`
                )
                .get(event.charger_id, event.timestamp - 5000, event.timestamp + 5000, event.timestamp);

            return {
                event,
                meta: safeJsonParse(event.meta),
                raw: raw ? { id: raw.id, timestamp: raw.timestamp, json: safeJsonParse(raw.raw), text: raw.raw } : null,
            };
        };

        const fetchVercelEvidence = (vercelLogId) => {
            const row = this.vercelDb
                .prepare('SELECT id, timestamp, endpoint, method, status_code, duration_ms, level, body, meta FROM vercel_logs WHERE id = ?')
                .get(vercelLogId);
            if (!row) return null;

            return {
                ...row,
                meta: safeJsonParse(row.meta),
                body: safeJsonParse(row.body) || row.body,
            };
        };

        // Get recent OCPP errors
        const ocppErrorsQuery = `
            SELECT id, timestamp, charger_id, event_type, meta, message
            FROM ocpp_events
            WHERE charger_id IS NOT NULL
              AND (
                  event_type LIKE '%fault%'
                  OR event_type LIKE '%error%'
                  OR event_type LIKE '%failed%'
              )
              AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 50
        `;

        const ocppErrors = this.ocppDb.prepare(ocppErrorsQuery).all(cutoff);

        if (ocppErrors.length === 0) return [];

        const alerts = [];

        for (const ocppError of ocppErrors) {
            // Emergency-stop presses are operator actions, not charger faults
            // (they have their own dedicated WhatsApp alert). Don't escalate them
            // into critical Charger+Backend correlations — #1 false-critical source.
            const ocppFault = parseStatusNotif(ocppError.message);
            if (isEmergencyStopFault(ocppFault, ocppError.message)) {
                continue;
            }

            // Pull backend errors within ±30s, then keep ONLY the ones that are
            // causally linked to THIS charger (charge-action route + references
            // this charger id). 405 excluded (low-signal method mismatch noise).
            // Temporal-only matches are dropped here — that was the bogus-alert
            // source the screenshots showed.
            const vercelErrorsQuery = `
                SELECT id, timestamp, endpoint, method, status_code, duration_ms
                FROM vercel_logs
                WHERE status_code >= 400
                  AND status_code != 405
                  AND timestamp BETWEEN ? AND ?
                ORDER BY timestamp
                LIMIT 50
            `;

            const vercelCandidates = this.vercelDb.prepare(vercelErrorsQuery).all(
                ocppError.timestamp - CORRELATION_WINDOW,
                ocppError.timestamp + CORRELATION_WINDOW
            );

            const vercelErrors = vercelCandidates.filter(v => isCausalBackendError(v.endpoint, ocppError.charger_id));

            if (vercelErrors.length > 0) {
                // Found correlation!
                const alertKey = `${ocppError.charger_id}_${ocppError.timestamp}`;

                if (!this.shouldSendAlert('ocpp_vercel_correlation', alertKey)) {
                    continue;
                }

                // Evidence snapshot: store full OCPP + Vercel rows inside the alert so we can debug later.
                const ocppEvidence = fetchOcppEvidence(ocppError.id);
                const vercelEvidence = vercelErrors.map(v => fetchVercelEvidence(v.id)).filter(Boolean);

                const evidence = {
                    kind: 'ocpp_vercel_correlation',
                    ocpp: ocppEvidence,
                    vercel: vercelEvidence,
                };

                const alert = {
                    type: 'ocpp_vercel_correlation',
                    severity: 'critical',
                    title: `Erro correlacionado: Charger + Backend`,
                    description: `Erro OCPP (${ocppError.event_type}${ocppFault.error ? `: ${ocppFault.error}` : ''}${ocppFault.info ? ` / ${ocppFault.info}` : ''}) correlacionado com ${vercelErrors.length} erro(s) backend`,
                    charger_id: ocppError.charger_id,
                    event_type: ocppError.event_type,
                    vercel_errors: vercelErrors.length,
                    ocpp_log_ids: JSON.stringify([ocppError.id]),
                    vercel_log_ids: JSON.stringify(vercelErrors.map(v => v.id)),
                    evidence_json: JSON.stringify(evidence),
                    event_ts: ocppError.timestamp,
                    timestamp: Date.now()
                };

                alerts.push(alert);
            }
        }

        return alerts;
    }

    /**
     * Standalone charger-fault alerts (added 2026-06-12).
     *
     * Before this, an OCPP fault only surfaced if it coincided with a backend
     * error within ±30s (detectOcppVercelCorrelation). Real faults with no
     * backend coincidence were therefore SILENT, while coincidental noise made
     * false "backend afetou carregador" criticals. Charger faults and backend
     * errors are now independent streams; this detector owns the charger side.
     * e-stop presses are excluded (operator action, has its own alert).
     */
    detectChargerFaults() {
        const cutoff = Date.now() - QUERY_WINDOW;

        const faults = this.ocppDb.prepare(`
            SELECT id, timestamp, charger_id, event_type, meta, message
            FROM ocpp_events
            WHERE charger_id IS NOT NULL
              AND (
                  event_type LIKE '%fault%'
                  OR event_type LIKE '%error%'
                  OR event_type LIKE '%failed%'
              )
              AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 50
        `).all(cutoff);

        if (faults.length === 0) return [];

        const alerts = [];
        const seen = new Set();

        for (const ev of faults) {
            const parsed = parseStatusNotif(ev.message);
            if (isEmergencyStopFault(parsed, ev.message)) continue;

            // One alert per charger+errorCode per run; shouldSendChargerFaultAlert
            // debounces with an escalating backoff so a chronic flapper doesn't
            // spam hourly forever (see CHARGER_FAULT_BACKOFF_TIERS).
            const errKey = parsed.error || ev.event_type || 'fault';
            const dedupeKey = `${ev.charger_id}::${errKey}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const backoff = this.shouldSendChargerFaultAlert(dedupeKey);
            if (!backoff) continue;

            // Evidence shaped like the correlation alert so formatAlertMessage's
            // OCPP-details block renders (it parses ocpp.event.message). No
            // `vercel` key → no "Backend afetado" section.
            const evidence = {
                kind: 'charger_fault',
                ocpp: {
                    event: {
                        id: ev.id,
                        timestamp: ev.timestamp,
                        charger_id: ev.charger_id,
                        event_type: ev.event_type,
                        message: ev.message,
                    },
                    meta: null,
                    raw: null,
                },
            };

            const detailBits = [
                parsed.status ? `status=${parsed.status}` : null,
                parsed.error ? `erro=${parsed.error}` : null,
                parsed.info ? `info=${parsed.info}` : null,
            ].filter(Boolean).join(', ');

            // Temperature faults are the cable-theft signature (see
            // isCableTheftSuspectFault) — escalate and copy the urgent group.
            const cableTheftSuspect = isCableTheftSuspectFault(parsed, ev.message);

            alerts.push({
                type: 'charger_fault',
                severity: cableTheftSuspect ? 'critical' : 'warning',
                urgent: cableTheftSuspect,
                title: cableTheftSuspect
                    ? `Falha de temperatura — possível roubo de cabo`
                    : `Carregador em falha`,
                description: `Carregador reportou falha${detailBits ? ` (${detailBits})` : ` (${ev.event_type})`}`,
                charger_id: ev.charger_id,
                event_type: ev.event_type,
                ocpp_log_ids: JSON.stringify([ev.id]),
                evidence_json: JSON.stringify(evidence),
                event_ts: ev.timestamp,
                timestamp: Date.now(),
                // Pre-parsed fault fields forwarded to partner-fault-notifier to
                // avoid re-parsing the StatusNotification message a second time.
                parsed_fault: parsed,
                // Backoff bookkeeping surfaced in the message so it's clear WHY
                // the cadence changed once it escalates past the first tier.
                backoff_streak: backoff.streak,
                backoff_window_ms: backoff.windowMs,
            });
        }

        return alerts;
    }

    /**
     * Save alert to database
     */
    saveAlert(alert) {
        const insert = this.alertsDb.prepare(`
            INSERT INTO alerts (
                created_at, charger_id, severity, title, description,
                ocpp_log_ids, vercel_log_ids, evidence_json, sent, sent_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `);

        try {
            const result = insert.run(
                alert.timestamp,
                alert.charger_id || null,
                alert.severity,
                alert.title,
                alert.description,
                alert.ocpp_log_ids || null,
                alert.vercel_log_ids || null,
                alert.evidence_json || null
            );

            console.log(`💾 Alert saved to DB: ${alert.title} (ID: ${result.lastInsertRowid})`);
            return result.lastInsertRowid;
        } catch (e) {
            console.error('❌ Error saving alert to DB:', e.message);
            return null;
        }
    }

    /**
     * Format alert message for WhatsApp
     */
    formatAlertMessage(alert) {
        // Prefer the event timestamp (what actually happened). Fallback to created_at.
        const ts = (typeof alert.event_ts === 'number' && Number.isFinite(alert.event_ts))
            ? alert.event_ts
            : (typeof alert.timestamp === 'number' && Number.isFinite(alert.timestamp))
                ? alert.timestamp
                : Date.now();

        const dt = new Date(ts);

        const timeUtc = dt.toLocaleString('pt-BR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'UTC'
        });

        const timeBrt = dt.toLocaleString('pt-BR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'America/Sao_Paulo'
        });

        let emoji = '🟡';
        switch (alert.severity) {
            case 'critical':
                emoji = '🔴';
                break;
            case 'warning':
                emoji = '🟠';
                break;
            case 'info':
                emoji = 'ℹ️';
                break;
        }

        let msg = `${emoji} *${alert.title}*\\n\\n`;

        // Add charger info if available
        if (alert.charger_id) {
            const station = lookupStation(alert.charger_id);
            if (station) {
                msg += `🏢 *${station.name}*\\n`;
                msg += `📍 ${station.location}\\n`;
                msg += `🆔 ${alert.charger_id}\\n\\n`;
            } else {
                msg += `🔌 *Carregador: ${alert.charger_id}*\\n\\n`;
                // Surface unknown chargers so we can backfill station-lookup.
                console.warn(`⚠️ Charger sem cadastro no station-lookup: ${alert.charger_id}`);
            }
        }

        // Add description
        msg += `📋 ${alert.description}\\n`;

        // If evidence snapshot exists, include key OCPP fields inline.
        if (alert.evidence_json) {
            try {
                const ev = JSON.parse(alert.evidence_json);
                const ocppMeta = ev && ev.ocpp && ev.ocpp.meta ? ev.ocpp.meta : null;
                // Collector stores fault detail as free-text `message` (meta=null),
                // so fall back to parsing the StatusNotification line.
                const parsedMsg = parseStatusNotif(ev && ev.ocpp && ev.ocpp.event ? ev.ocpp.event.message : '');

                const connectorId = ocppMeta?.connectorId ?? ocppMeta?.connector_id ?? parsedMsg.connectorId;
                const status = ocppMeta?.status ?? parsedMsg.status;
                const errorCode = ocppMeta?.errorCode ?? ocppMeta?.error_code ?? parsedMsg.error;
                const info = ocppMeta?.info ?? parsedMsg.info;
                const vendorErrorCode = ocppMeta?.vendorErrorCode ?? ocppMeta?.vendor_error_code ?? parsedMsg.vendorError;

                const hasAny = connectorId != null || status || errorCode || info || vendorErrorCode;
                if (hasAny) {
                    msg += `\\n🔎 *OCPP (detalhes)*\\n`;
                    if (connectorId != null) msg += `- connectorId: ${connectorId}\\n`;
                    if (status) msg += `- status: ${status}\\n`;
                    if (errorCode) msg += `- errorCode: ${errorCode}\\n`;
                    if (vendorErrorCode) msg += `- vendorErrorCode: ${vendorErrorCode}\\n`;
                    if (info) msg += `- info: ${String(info).slice(0, 160)}\\n`;
                }
                // For correlation alerts, surface WHICH backend endpoints failed.
                // The evidence carries the full Vercel rows but they were never rendered.
                const vercelRows = ev && Array.isArray(ev.vercel) ? ev.vercel : [];
                if (vercelRows.length > 0) {
                    // Group by "METHOD endpoint → status" so repeats collapse into a count.
                    const groups = new Map();
                    for (const v of vercelRows) {
                        if (!v) continue;
                        const method = v.method ? `${String(v.method).toUpperCase()} ` : '';
                        const endpoint = v.endpoint || '(endpoint desconhecido)';
                        const status = v.status_code != null ? ` → ${v.status_code}` : '';
                        const key = `${method}${endpoint}${status}`;
                        const g = groups.get(key) || { key, count: 0, maxDur: 0 };
                        g.count += 1;
                        if (typeof v.duration_ms === 'number') g.maxDur = Math.max(g.maxDur, v.duration_ms);
                        groups.set(key, g);
                    }

                    msg += `\\n🌐 *Backend afetado*\\n`;
                    for (const g of groups.values()) {
                        const times = g.count > 1 ? ` (${g.count}x)` : '';
                        const slow = g.maxDur >= 1000 ? ` ⏱️${Math.round(g.maxDur)}ms` : '';
                        msg += `- ${g.key}${times}${slow}\\n`;
                    }
                }
            } catch (_) {
                // ignore parse errors
            }
        }

        // Add specific details
        if (alert.endpoint) {
            msg += `🌐 Endpoint: \`${alert.endpoint}\`\\n`;
        }

        if (alert.status_code) {
            msg += `❌ Status: ${alert.status_code}\\n`;
        }

        if (alert.count && alert.count > 1) {
            msg += `🔢 Ocorrências: ${alert.count}\\n`;
        }

        if (alert.avg_latency_ms) {
            msg += `⏱️ Latência média: ${alert.avg_latency_ms}ms\\n`;
        }

        msg += `🕐 UTC: ${timeUtc}\\n`;
        msg += `🕐 UTC-3: ${timeBrt}\\n`;

        // Add action recommendations
        switch (alert.type) {
            case 'vercel_5xx':
                msg += `\\n⚡ Ação: Verificar logs Vercel e backend`;
                break;
            case 'vercel_timeout':
                msg += `\\n⚡ Ação: Investigar função Vercel (cold start ou loop?)`;
                break;
            case 'vercel_latency':
                msg += `\\n⚡ Ação: Verificar queries DB ou chamadas externas lentas`;
                break;
            case 'ocpp_vercel_correlation':
                msg += `\\n⚡ Ação: Problema no backend afetou carregador - prioridade!`;
                break;
            case 'charger_fault':
                if (alert.urgent) {
                    msg += `\\n⚡ Ação: Possível roubo de cabo (assinatura de temperatura) - verificar câmeras/local AGORA. Aviso enviado ao grupo URGENTE.`;
                } else {
                    msg += `\\n⚡ Ação: Verificar carregador (pode ter limpado sozinho - confira o status atual)`;
                }
                // Once the backoff has escalated past the first tier, say so —
                // otherwise a 6h/24h-spaced alert reads like a brand new incident.
                if (alert.backoff_streak > 3) {
                    const hours = Math.round(alert.backoff_window_ms / (60 * 60 * 1000));
                    msg += `\\n🔁 Falha persistente (alerta #${alert.backoff_streak} para este erro; próximos a cada ${hours}h enquanto não resolver)`;
                }
                break;
        }

        return msg;
    }

    /**
     * Send alert to Telegram group (temporary until alerts are polished)
     */
    async sendTelegramAlert(message) {
        // Soft-disable: if no group is configured, do nothing.
        if (!TELEGRAM_GROUP) return false;

        return new Promise((resolve, reject) => {
            const escapedMsg = message.replace(/'/g, "'\\''");
            const cmd = `openclaw message send --channel telegram --target '${TELEGRAM_GROUP}' --message '${escapedMsg}'`;

            exec(cmd, (error) => {
                if (error) {
                    console.error(`❌ Error sending Telegram: ${error.message}`);
                    reject(error);
                    return;
                }
                console.log('✅ Alert sent to Telegram');
                resolve(true);
            });
        });
    }

    /**
     * Send alert to the WhatsApp alerts group ("Notificações Turbo Station").
     * Uses the same `openclaw message send` transport as alert-processor.
     */
    async sendWhatsappAlert(message, conversationId = WHATSAPP_CONV) {
        if (!conversationId || !SUPPORT_API_SECRET) return false;
        // formatAlertMessage emits literal "\n" (for the Telegram CLI); convert to
        // real newlines for the JSON/Evolution path.
        const text = message.replace(/\\n/g, '\n');
        try {
            const url = `${SUPPORT_API_BASE}/api/support/conversations/${encodeURIComponent(conversationId)}/messages?brandId=${encodeURIComponent(WHATSAPP_BRAND)}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-secret': SUPPORT_API_SECRET,
                    'x-brand-id': WHATSAPP_BRAND,
                },
                body: JSON.stringify({ body: text, source: 'system' }),
            });
            if (!res.ok) {
                console.error(`❌ Error sending WhatsApp: support API ${res.status}`);
                return false;
            }
            console.log('✅ Alert sent to WhatsApp');
            return true;
        } catch (e) {
            console.error(`❌ Error sending WhatsApp: ${e && e.message}`);
            return false;
        }
    }

    /**
     * Dispatch an alert message to every configured channel. Returns true if at
     * least one channel accepted it (so the alert is marked sent).
     */
    async dispatchAlert(message) {
        const results = await Promise.allSettled([
            this.sendTelegramAlert(message),
            this.sendWhatsappAlert(message),
        ]);
        return results.some((r) => r.status === 'fulfilled' && r.value === true);
    }

    /**
     * Copy an urgent alert (cable-theft suspect) to the "Turbo Station +
     * URGENTE" WhatsApp group. Best-effort: failure here never blocks the
     * normal alert path, and the alert is marked sent based on the regular
     * channels only.
     */
    async sendUrgentWhatsappAlert(message) {
        if (!URGENT_WHATSAPP_CONV) return false;
        return this.sendWhatsappAlert(message, URGENT_WHATSAPP_CONV);
    }

    /**
     * Message for the urgent group: short, explicit about the suspicion, and
     * self-contained (that group doesn't follow the technical alert stream).
     */
    formatUrgentCableTheftMessage(alert) {
        const parsed = alert.parsed_fault || {};
        const station = alert.charger_id ? lookupStation(alert.charger_id) : null;

        const dt = new Date(typeof alert.event_ts === 'number' ? alert.event_ts : Date.now());
        const timeBrt = dt.toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
            hour12: false, timeZone: 'America/Sao_Paulo',
        });

        let msg = `🚨 *URGENTE — possível roubo de cabo* 🚨\\n\\n`;
        if (station) {
            msg += `🏢 *${station.name}*\\n`;
            if (station.location) msg += `📍 ${station.location}\\n`;
            msg += `🆔 ${alert.charger_id}\\n`;
        } else if (alert.charger_id) {
            msg += `🔌 *Carregador ${alert.charger_id}*\\n`;
        }
        if (parsed.connectorId != null) msg += `🔌 Conector ${parsed.connectorId}\\n`;
        msg += `\\n📋 O carregador reportou falha de temperatura`;
        const errBits = [parsed.error, parsed.info].filter(Boolean).join(' / ');
        if (errBits) msg += ` (${errBits})`;
        msg += ` — mesma assinatura de quando o cabo do Metrópole 1 foi roubado.\\n`;
        msg += `🕐 ${timeBrt} (horário de Brasília)\\n`;
        msg += `\\n⚡ Verificar câmeras e acionar alguém no local AGORA.`;
        return msg;
    }

    /**
     * Send the last 5 recent alerts (fresh only) to the alerts group.
     * This is intended to repopulate context after restarts.
     */
    async sendRecentAlertsOnStartup() {
        try {
            const now = Date.now();
            const cutoff = now - MAX_ALERT_AGE_MS;

            const rows = this.alertsDb
                .prepare(
                    `SELECT id, created_at, charger_id, severity, title, description, ocpp_log_ids, vercel_log_ids, evidence_json
                     FROM alerts
                     WHERE created_at >= ?
                       AND (sent = 0 OR sent IS NULL)
                     ORDER BY created_at DESC
                     LIMIT 5`
                )
                .all(cutoff);

            if (!rows.length) return;

            // Send oldest -> newest to read naturally
            for (const row of rows.slice().reverse()) {
                const alert = {
                    type: 'db_recent',
                    // Use created_at as the event time for these replays
                    event_ts: row.created_at,
                    timestamp: row.created_at,
                    charger_id: row.charger_id,
                    severity: row.severity,
                    title: row.title,
                    description: row.description,
                    ocpp_log_ids: row.ocpp_log_ids,
                    vercel_log_ids: row.vercel_log_ids,
                    evidence_json: row.evidence_json,
                };

                const msg = this.formatAlertMessage(alert);
                const sent = await this.sendTelegramAlert(msg);
                if (sent) {
                    this.markAlertSent(row.id);
                }

                // small spacing
                await new Promise((r) => setTimeout(r, 500));
            }
        } catch (e) {
            console.error('⚠️ Error in sendRecentAlertsOnStartup:', e.message);
        }
    }

    /**
     * Mark alert as sent in database
     */
    markAlertSent(alertId) {
        const update = this.alertsDb.prepare(`
            UPDATE alerts
            SET sent = 1, sent_at = ?
            WHERE id = ?
        `);

        try {
            update.run(Date.now(), alertId);
            console.log(`✅ Alert ${alertId} marked as sent`);
        } catch (e) {
            console.error(`❌ Error marking alert ${alertId} as sent:`, e.message);
        }
    }

    /**
     * Main detection loop
     */
    async runDetection() {
        console.log(`\n🔍 Running alert detection at ${new Date().toISOString()}`);

        const runDetector = (name, fn) => {
            try {
                const res = fn();
                if (!Array.isArray(res)) {
                    console.error(`⚠️ Detector ${name} returned non-array; ignoring`);
                    // self-health: detector contract violation
                    if (this.shouldSendAlert('engine_detector_error', name)) {
                        return [{
                            type: 'engine_detector_error',
                            severity: 'warning',
                            title: `Alert-engine detector inválido: ${name}`,
                            description: `Detector retornou um valor não-array (contrato quebrado).`,
                            detector: name,
                            event_ts: Date.now(),
                            timestamp: Date.now()
                        }];
                    }
                    return [];
                }
                return res;
            } catch (e) {
                const msg = e && e.stack ? e.stack : (e && e.message ? e.message : String(e));
                console.error(`❌ Detector failed: ${name}:`, msg);

                // self-health: detector runtime failure
                if (this.shouldSendAlert('engine_detector_error', name)) {
                    return [{
                        type: 'engine_detector_error',
                        severity: 'critical',
                        title: `Alert-engine detector falhou: ${name}`,
                        description: msg.substring(0, 800),
                        detector: name,
                        event_ts: Date.now(),
                        timestamp: Date.now()
                    }];
                }

                return [];
            }
        };

        const allAlerts = [
            ...runDetector('detectIngestStalls', () => this.detectIngestStalls()),
            ...runDetector('detectVercel5xxErrors', () => this.detectVercel5xxErrors()),
            ...runDetector('detectVercelTimeouts', () => this.detectVercelTimeouts()),
            ...runDetector('detectHighLatency', () => this.detectHighLatency()),
            ...runDetector('detectChargerFaults', () => this.detectChargerFaults()),
            ...runDetector('detectOcppVercelCorrelation', () => this.detectOcppVercelCorrelation())
        ];

        console.log(`📊 Found ${allAlerts.length} new alerts`);

        if (allAlerts.length === 0) {
            console.log('✅ No issues detected');
            return;
        }

        // Save and send alerts
        for (const alert of allAlerts) {
            try {
                // Freshness guard (never send stale alerts)
                const eventTs = typeof alert.event_ts === 'number' ? alert.event_ts : null;
                if (eventTs && (Date.now() - eventTs) > MAX_ALERT_AGE_MS) {
                    console.log(`🧹 Dropped stale alert (${alert.type}) age=${Math.round((Date.now()-eventTs)/60000)}m`);
                    continue;
                }

                // Save to database first
                const alertId = this.saveAlert(alert);

                if (!alertId) {
                    console.error('⚠️ Failed to save alert, skipping send');
                    continue;
                }

                // Format and send to every configured channel (Telegram + WhatsApp)
                const message = this.formatAlertMessage(alert);
                const sent = await this.dispatchAlert(message);

                // Mark as sent only if actually sent
                if (sent) {
                    this.markAlertSent(alertId);
                }

                // Cable-theft suspects also go to the URGENTE group with a
                // dedicated message. Best-effort — never blocks the loop.
                if (alert.urgent) {
                    try {
                        await this.sendUrgentWhatsappAlert(this.formatUrgentCableTheftMessage(alert));
                    } catch (e) {
                        console.error('❌ Error sending urgent alert:', e && e.message);
                    }
                }

                // Partner-facing notification for charger faults (fire-and-forget;
                // failure here never blocks the internal alert path above).
                if (alert.type === 'charger_fault') {
                    notifyPartnerFault(alert).catch(e =>
                        console.error('[partner-alert] error:', e && e.message)
                    );
                }

                // Rate limit: 2 seconds between messages
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (e) {
                console.error('❌ Error processing alert:', e.message);
            }
        }

        console.log('✅ Alert detection complete');
    }

    /**
     * Cleanup old debounce cache entries (>24h)
     */
    cleanupDebounceCache() {
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        let cleaned = 0;

        Object.keys(this.debounceCache).forEach(key => {
            if (now - this.debounceCache[key] > dayMs) {
                delete this.debounceCache[key];
                cleaned++;
            }
        });

        if (cleaned > 0) {
            this.saveDebounceCache();
            console.log(`🧹 Cleaned ${cleaned} old debounce entries`);
        }
    }

    close() {
        this.ocppDb.close();
        this.vercelDb.close();
        this.mobileDb.close();
        this.alertsDb.close();
    }
}

// Main execution (long-running)
async function main() {
    const engine = new AlertEngine();

    const tick = async () => {
        try {
            await engine.runDetection();
            engine.cleanupDebounceCache();
            engine.cleanupChargerFaultBackoff();
        } catch (e) {
            console.error('❌ Fatal error in tick:', e && e.stack ? e.stack : e);
        }
    };

    // Run immediately, then every 2 minutes.
    await tick();
    const interval = setInterval(tick, 2 * 60 * 1000);

    const shutdown = (signal) => {
        console.log(`\n🛑 Shutting down alert-engine (${signal})`);
        clearInterval(interval);
        try { engine.close(); } catch (_) {}
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error('❌ Unhandled error:', err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

module.exports = AlertEngine;
// Pure helpers exported for unit tests (causal-correlation gate + fault parsing).
// parseStatusNotif / isEmergencyStopFault now live in ocpp-utils.js; re-exported
// here for backwards compatibility with any existing test imports.
module.exports.isCausalBackendError = isCausalBackendError;
module.exports.endpointReferencesCharger = endpointReferencesCharger;
module.exports.CHARGE_ACTION_ROUTE = CHARGE_ACTION_ROUTE;
module.exports.parseStatusNotif = parseStatusNotif;
module.exports.isEmergencyStopFault = isEmergencyStopFault;
module.exports.isCableTheftSuspectFault = isCableTheftSuspectFault;
module.exports.windowForStreak = windowForStreak;
module.exports.CHARGER_FAULT_BACKOFF_TIERS = CHARGER_FAULT_BACKOFF_TIERS;
