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

// Freshness guard
const MAX_ALERT_AGE_MS = 10 * 60 * 1000; // never send alerts older than 10 minutes


// Debounce settings
const DEBOUNCE_FILE = path.join(__dirname, '..', 'history', 'alert_engine_debounce.json');
const DEBOUNCE_WINDOW = 60 * 60 * 1000; // 1 hour

// Time windows for queries (in milliseconds)
const QUERY_WINDOW = 5 * 60 * 1000; // Last 5 minutes
const CORRELATION_WINDOW = 30 * 1000; // ±30 seconds for correlation

// Ingest watchdog (if no new rows, alert)
const INGEST_STALL_OCPP_MS = 10 * 60 * 1000;
const INGEST_STALL_VERCEL_MS = 10 * 60 * 1000;
const INGEST_STALL_MOBILE_MS = 2 * 60 * 60 * 1000;

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

        // Alerts DB (write)
        this.alertsDb = new Database(ALERTS_DB_PATH);
        this.alertsDb.pragma('journal_mode = WAL'); // Better concurrent performance
        this.initAlertsSchema();

        this.debounceCache = this.loadDebounceCache();

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
        
        const query = `
            SELECT id, timestamp, endpoint, status_code, duration_ms, meta
            FROM vercel_logs
            WHERE status_code >= 500
              AND status_code < 600
              AND endpoint LIKE '%/api/ocpp%'
              AND timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 10
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
                title: `Erro ${firstError.status_code} no backend OCPP`,
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
            SELECT id, timestamp, charger_id, event_type, meta
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
            // Look for Vercel errors within ±30s
            // NOTE: we exclude 405 by default from correlation (low-signal/method mismatch noise).
            const vercelErrorsQuery = `
                SELECT id, timestamp, endpoint, status_code, duration_ms
                FROM vercel_logs
                WHERE status_code >= 400
                  AND status_code != 405
                  AND timestamp BETWEEN ? AND ?
                ORDER BY timestamp
                LIMIT 10
            `;

            const vercelErrors = this.vercelDb.prepare(vercelErrorsQuery).all(
                ocppError.timestamp - CORRELATION_WINDOW,
                ocppError.timestamp + CORRELATION_WINDOW
            );

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
                    description: `Erro OCPP (${ocppError.event_type}) correlacionado com ${vercelErrors.length} erro(s) backend`,
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
            }
        }

        // Add description
        msg += `📋 ${alert.description}\\n`;

        // If evidence snapshot exists, include key OCPP fields inline.
        if (alert.evidence_json) {
            try {
                const ev = JSON.parse(alert.evidence_json);
                const ocppMeta = ev && ev.ocpp && ev.ocpp.meta ? ev.ocpp.meta : null;

                const connectorId = ocppMeta?.connectorId ?? ocppMeta?.connector_id;
                const status = ocppMeta?.status;
                const errorCode = ocppMeta?.errorCode ?? ocppMeta?.error_code;
                const info = ocppMeta?.info;
                const vendorErrorCode = ocppMeta?.vendorErrorCode ?? ocppMeta?.vendor_error_code;

                const hasAny = connectorId != null || status || errorCode || info || vendorErrorCode;
                if (hasAny) {
                    msg += `\\n🔎 *OCPP (detalhes)*\\n`;
                    if (connectorId != null) msg += `- connectorId: ${connectorId}\\n`;
                    if (status) msg += `- status: ${status}\\n`;
                    if (errorCode) msg += `- errorCode: ${errorCode}\\n`;
                    if (vendorErrorCode) msg += `- vendorErrorCode: ${vendorErrorCode}\\n`;
                    if (info) msg += `- info: ${String(info).slice(0, 160)}\\n`;
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

                // Format and send via Telegram
                const message = this.formatAlertMessage(alert);
                const sent = await this.sendTelegramAlert(message);

                // Mark as sent only if actually sent
                if (sent) {
                    this.markAlertSent(alertId);
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
