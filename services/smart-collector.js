const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const StateTracker = require('./state-tracker');

// Config
const WS_URL = 'wss://logs.ocpp.turbostation.com.br/dashboard/ws/logs';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXNoYm9hcmRfaWQiOiJvcGVuY2xhdy1tb25pdG9yIiwicm9sZSI6Im1vbml0b3IiLCJwZXJtaXNzaW9ucyI6WyJsb2dzLnJlYWQiLCJsb2dzLmZpbHRlciJdLCJpYXQiOjE3NzA4MTcxOTAsImlzcyI6Im9jcHAtc2VydmVyIiwic3ViIjoib3BlbmNsYXctbW9uaXRvciJ9.toiKVkIbGcmeVx-RRQh7Zt8lXLCbfFDGqyC9qbYoAPM';

// REST fallback polling (WS can be silent depending on server/file watcher)
const REST_BASE_URL = 'https://logs.ocpp.turbostation.com.br';
const REST_POLL_INTERVAL_MS = 5000;
const REST_POLL_LIMIT = 500;

// Raw retention (TTL)
// NOTE: ocpp_raw grows fast; keep it short and rely on ocpp_events for long-term.
const OCPP_RAW_TTL_HOURS = parseInt(process.env.OCPP_RAW_TTL_HOURS || '48', 10);
const OCPP_RAW_TTL_CLEAN_INTERVAL_MS = 10 * 60 * 1000; // every 10 min

const EVENTS_FILE = path.join(__dirname, '..', 'history/events_buffer.json');
const ALERTS_FILE = path.join(__dirname, '..', 'history/pending_alerts.json');

// NOTE: OCPP now has its own SQLite DB (split from shared logs.db)
const DB_DIR = path.join(__dirname, '..', 'db');
const DB_PATH = path.join(DB_DIR, 'ocpp.db');

// SQLite setup
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure tables exist (auto-recovery)
// - ocpp_raw: full websocket log entry JSON (unfiltered)
// - ocpp_events: normalized/filtered rows (equivalent to prior `logs` rows for OCPP)
db.exec(`
  CREATE TABLE IF NOT EXISTS ocpp_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER,
    charger_id TEXT,
    severity TEXT,
    logger TEXT,
    message TEXT,
    raw TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ocpp_raw_timestamp ON ocpp_raw(timestamp);
  CREATE INDEX IF NOT EXISTS idx_ocpp_raw_charger_id ON ocpp_raw(charger_id);

  CREATE TABLE IF NOT EXISTS ocpp_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER,
    charger_id TEXT,
    event_type TEXT,
    category TEXT,
    severity TEXT,
    logger TEXT,
    message TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ocpp_events_timestamp ON ocpp_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_ocpp_events_charger_id ON ocpp_events(charger_id);
`);

const insertOcppRawStmt = db.prepare(`
  INSERT INTO ocpp_raw (timestamp, charger_id, severity, logger, message, raw)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertOcppEventStmt = db.prepare(`
  INSERT INTO ocpp_events (timestamp, charger_id, event_type, category, severity, logger, message, meta)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertOcppRawBatch = db.transaction((rows) => {
    for (const r of rows) {
        insertOcppRawStmt.run(
            r.timestamp,
            r.chargerId || null,
            r.severity || null,
            r.logger || null,
            r.message || null,
            r.raw
        );
    }
});

const insertOcppEventBatch = db.transaction((events) => {
    for (const evt of events) {
        insertOcppEventStmt.run(
            evt.timestamp,
            evt.chargerId || null,
            evt.category || null,
            evt.category || null,
            evt.severity || null,
            evt.logger || null,
            evt.message || null,
            evt.meta ? JSON.stringify(evt.meta) : null
        );
    }
});

let dbBuffer = []; // normalized events buffer
let rawDbBuffer = []; // raw websocket entries buffer

console.log(`💾 SQLite connected (OCPP): ${DB_PATH}`);

const tracker = new StateTracker();
let eventBuffer = [];
let pendingAlerts = [];

// Track Transaction -1 errors per charger (for smart filtering)
const transaction1ErrorCount = new Map(); // key: chargerId, value: count

// Track last heartbeat saved to DB per charger (throttle: 1 per 5 min)
const lastHeartbeatDbSave = new Map(); // key: chargerId, value: timestamp (ms)
const lastMeterValueDbSave = new Map(); // key: chargerId, value: timestamp (ms)
const HEARTBEAT_DB_INTERVAL = 5 * 60 * 1000; // Save 1 heartbeat per charger every 5 min
const METER_VALUE_DB_INTERVAL = 5 * 60 * 1000; // Save 1 meter value per charger every 5 min

let restPollStarted = false;
let restPollInterval = null; // interval handle for REST polling
let lastRestCursorIso = null; // ISO timestamp of last ingested REST entry

// === WS HEALTH TRACKING ===
let lastWsMessageAt = 0; // timestamp (ms) of last WS message received
const WS_SILENCE_THRESHOLD_MS = 30_000; // activate REST fallback after 30s of WS silence
let wsHealthCheckInterval = null;

// === DEDUP ===
// Sliding-window set to prevent double-processing entries from WS + REST
// Key: `${timestamp}|${message_prefix}` — auto-expires after 60s
const recentEntryKeys = new Map(); // key -> expiry timestamp (ms)
const DEDUP_WINDOW_MS = 60_000; // 60s dedup window
const DEDUP_CLEAN_INTERVAL_MS = 30_000; // purge expired keys every 30s

// === DEDUP HELPERS ===
function makeDedupeKey(timestamp, message) {
    // Use first 80 chars of message to avoid memory bloat but still be unique enough
    const ts = new Date(timestamp).getTime() || 0;
    const msgPrefix = (message || '').substring(0, 80);
    return `${ts}|${msgPrefix}`;
}

function isDuplicate(timestamp, message) {
    const key = makeDedupeKey(timestamp, message);
    if (recentEntryKeys.has(key)) return true;
    // Register this entry
    recentEntryKeys.set(key, Date.now() + DEDUP_WINDOW_MS);
    return false;
}

function cleanExpiredDedupeKeys() {
    const now = Date.now();
    for (const [key, expiry] of recentEntryKeys) {
        if (expiry < now) recentEntryKeys.delete(key);
    }
}

// === REST FALLBACK (only when WS is silent) ===
async function pollOcppLogsRestOnce() {
    try {
        const params = new URLSearchParams();
        params.set('limit', String(REST_POLL_LIMIT));
        // Use cursor if we have one; else grab a small recent window
        if (lastRestCursorIso) {
            params.set('start_time', lastRestCursorIso);
        } else {
            // last 2 minutes (bootstrap)
            params.set('start_time', new Date(Date.now() - 2 * 60 * 1000).toISOString());
        }

        const url = `${REST_BASE_URL}/api/logs/history?${params.toString()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`REST ${res.status}`);
        const body = await res.json();
        const entries = body?.data?.entries || [];
        if (!Array.isArray(entries) || entries.length === 0) return;

        // Ensure chronological order so cursor moves forward
        entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

        let ingested = 0;
        for (const e of entries) {
            // Dedup: skip if already processed via WS
            if (isDuplicate(e.timestamp, e.message)) continue;

            processEntry({
                timestamp: e.timestamp,
                level: e.level,
                logger: e.logger,
                message: e.message
            });
            ingested++;
        }

        if (ingested > 0) {
            console.log(`🌐 [rest-poll] ingested ${ingested} entries (${entries.length - ingested} deduped)`);
        }

        // Advance cursor to last entry timestamp (plus 1ms to avoid duplicates)
        const lastTs = entries[entries.length - 1]?.timestamp;
        if (lastTs) {
            const t = new Date(lastTs).getTime();
            if (!Number.isNaN(t)) lastRestCursorIso = new Date(t + 1).toISOString();
        }
    } catch (e) {
        console.error('[rest-poll] error:', e.message);
    }
}

function startRestPolling() {
    if (restPollStarted) return;
    restPollStarted = true;

    console.log(`🌐 REST fallback ACTIVATED (WS silent for ${WS_SILENCE_THRESHOLD_MS / 1000}s)`);
    pollOcppLogsRestOnce();
    restPollInterval = setInterval(pollOcppLogsRestOnce, REST_POLL_INTERVAL_MS);
}

function stopRestPolling() {
    if (!restPollStarted) return;
    restPollStarted = false;

    if (restPollInterval) {
        clearInterval(restPollInterval);
        restPollInterval = null;
    }
    console.log('🌐 REST fallback PAUSED (WS recovered)');
}

// Periodically check if WS went silent and toggle REST polling
function startWsHealthCheck() {
    if (wsHealthCheckInterval) return;
    wsHealthCheckInterval = setInterval(() => {
        const silenceMs = Date.now() - lastWsMessageAt;
        if (silenceMs >= WS_SILENCE_THRESHOLD_MS && !restPollStarted) {
            console.warn(`⚠️ WS silent for ${Math.round(silenceMs / 1000)}s — activating REST fallback`);
            startRestPolling();
        }
    }, 10_000); // check every 10s
}

function connect() {
    const ws = new WebSocket(WS_URL, `dashboard-logs.${TOKEN}`);

    ws.on('open', () => {
        console.log('✅ Smart Collector Connected (Enhanced)');
        lastWsMessageAt = Date.now();

        // Start health check — REST polling will activate only if WS goes silent
        startWsHealthCheck();

        // If REST was running (e.g. reconnect), pause it now that WS is back
        stopRestPolling();

        ws.send(JSON.stringify({
            type: 'filter_update',
            data: { levels: ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] }
        }));

        // Ask for status (helps debug server-side stream stats)
        ws.send(JSON.stringify({ type: 'get_status' }));
    });

    ws.on('message', (data) => {
        lastWsMessageAt = Date.now();

        // WS is alive — if REST fallback was active, pause it
        if (restPollStarted) stopRestPolling();

        try {
            const msg = JSON.parse(data);

            if (msg.type === 'log_entry' && msg.data) {
                // Register in dedup set so REST won't re-process
                isDuplicate(msg.data.timestamp, msg.data.message);
                processEntry(msg.data);
                return;
            }

            if (msg.type === 'log_batch' && msg.data?.entries) {
                for (const e of msg.data.entries) {
                    isDuplicate(e.timestamp, e.message);
                    processEntry(e);
                }
                return;
            }

            // Persist WS status as raw so we have proof-of-life in db
            if (msg.type === 'status') {
                rawDbBuffer.push({
                    timestamp: Date.now(),
                    chargerId: null,
                    severity: 'info',
                    logger: 'ws_status',
                    message: `ws_status:${msg.data?.status || 'unknown'}`.substring(0, 2000),
                    raw: JSON.stringify(msg)
                });
                return;
            }
        } catch (e) {
            console.error('Parse error:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('⚠️ Disconnected. Reconnecting in 5s...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
}

function classifyOcppEventType(msg = '') {
    if (!msg) return 'other';

    if (msg.includes('unknown unique id')) {
        return 'trigger_message_timeout';
    }

    if (msg.includes('TriggerMessage')) {
        if (msg.includes('timed out') || msg.includes('timeout')) {
            return 'trigger_message_timeout';
        }
        if (msg.includes("status='Accepted'") || msg.includes('Accepted')) {
            return 'trigger_message_accepted';
        }
        return 'trigger_message';
    }

    if (msg.includes('StatusNotification')) {
        if (msg.includes('Faulted')) return 'status_notification_faulted';
        if (msg.includes('Charging')) return 'status_notification_charging';
        if (msg.includes('Available')) return 'status_notification_available';
        return 'status_notification';
    }

    if (msg.includes('Heartbeat')) return 'heartbeat';
    if (msg.includes('MeterValues') || msg.includes('Meter value') || msg.includes('Active power:') || msg.includes('Energy consumed')) return 'meter_values';

    if (msg.includes('StartTransaction')) return msg.includes('Accepted') ? 'transaction_start_accepted' : 'transaction_start';
    if (msg.includes('StopTransaction')) return 'transaction_stop';
    if (msg.includes('BootNotification')) return msg.includes('Accepted') ? 'boot_notification_accepted' : 'boot_notification';
    if (msg.includes('Authorize') || msg.includes('Authorization')) return 'authorize';
    if (msg.includes('RemoteStart')) return msg.includes('rejected') ? 'remote_start_rejected' : 'remote_start';
    if (msg.includes('RemoteStop')) return 'remote_stop';
    if (msg.includes('Faulted')) return 'charger_faulted';

    return 'other';
}

function normalizeLogger(rawLogger, chargerId) {
    if (rawLogger && rawLogger !== 'unknown') return rawLogger;
    if (chargerId) return 'charger_' + chargerId;
    return rawLogger || 'ocpp';
}

function processEntry(log) {
    const chargerId = extractChargerId(log);
    const msg = log.message || '';
    const ts = new Date(log.timestamp).getTime() || Date.now();

    // === PERSIST TO SQLITE ===
    // Always store full raw websocket entry (unfiltered)
    try {
        rawDbBuffer.push({
            timestamp: ts,
            chargerId,
            severity: log.level?.toLowerCase() || null,
            logger: normalizeLogger(log.logger, chargerId),
            message: msg.substring(0, 2000),
            raw: JSON.stringify(log)
        });
    } catch (e) {
        // If JSON stringify fails for any reason, still keep a minimal record
        rawDbBuffer.push({
            timestamp: ts,
            chargerId,
            severity: log.level?.toLowerCase() || null,
            logger: normalizeLogger(log.logger, chargerId),
            message: msg.substring(0, 2000),
            raw: '{"error":"raw_stringify_failed"}'
        });
    }

    // Strategy: skip ONLY known noise, throttle high-frequency, save everything else as-is
    
    // 1. SKIP: Raw protocol frames (send [...] / receive message [...]) — pure noise
    if (msg.includes('send [') || msg.includes('receive message [')) {
        // Don't save to DB, but still process below for alerts
    }
    // SKIP: Internal server processing logs — no analytical value
    else if (msg.includes('Fetched data for user') || 
             msg.includes('Atomically deducted') ||
             msg.includes('on_meter_values: Cached') ||
             msg.includes('Current battery percentage') ||
             msg.includes('Battery percentage changed')) {
        // Cache ops, battery deltas — redundant with meter_values
        // NOTE: Credit deductions (Deducted X credits for user) are KEPT — they contain userData
    }
    // 2. THROTTLE: Heartbeats — 1 per charger every 5 min (uptime proof)
    else if (msg.includes('Heartbeat') && chargerId) {
        const lastSave = lastHeartbeatDbSave.get(chargerId) || 0;
        const now = Date.now();
        if (now - lastSave >= HEARTBEAT_DB_INTERVAL) {
            lastHeartbeatDbSave.set(chargerId, now);
            dbBuffer.push({
                timestamp: ts,
                chargerId,
                category: 'heartbeat',
                severity: 'info',
                logger: normalizeLogger(log.logger, chargerId),
                message: 'Heartbeat',
                meta: null
            });
        }
    }
    // 3. THROTTLE: MeterValues — 1 per charger every 5 min (save original message, no parsing)
    else if ((msg.includes('MeterValues') || msg.includes('Meter value') || msg.includes('Active power:') || msg.includes('battery percentage') || msg.includes('Energy consumed')) && chargerId) {
        const lastSave = lastMeterValueDbSave.get(chargerId) || 0;
        const now = Date.now();
        if (now - lastSave >= METER_VALUE_DB_INTERVAL) {
            lastMeterValueDbSave.set(chargerId, now);
            dbBuffer.push({
                timestamp: ts,
                chargerId,
                category: 'meter_values',
                severity: 'info',
                logger: normalizeLogger(log.logger, chargerId),
                message: msg.substring(0, 500), // Cap length but don't parse
                meta: null
            });
        }
    }
    // 4. SAVE EVERYTHING ELSE — original message, no parsing, simple category
    else {
        dbBuffer.push({
            timestamp: ts,
            chargerId,
            category: classifyOcppEventType(msg),
            severity: log.level?.toLowerCase() || 'info',
            logger: normalizeLogger(log.logger, chargerId),
            message: msg.substring(0, 1000), // Cap at 1KB but keep original
            meta: null
        });
    }

    // === NOISE FILTERS (for eventBuffer/alerts only, DB gets everything) ===
    
    // Skip heartbeat (we track absence, not presence)
    if (log.message.includes('Heartbeat')) {
        // But extract charger ID and update last heartbeat
        if (chargerId) {
            tracker.updateCharger(chargerId, { 
                lastHeartbeat: log.timestamp,
                consecutiveErrors: 0  // Reset error count on successful heartbeat
            });
            tracker.saveState();
        }
        return;
    }

    // Track MeterValues as sign of life (charger is active and communicating)
    if (log.message.includes('MeterValues')) {
        if (chargerId) {
            tracker.updateCharger(chargerId, { 
                lastMeterValue: log.timestamp,
                consecutiveErrors: 0  // Reset error count on activity
            });
            tracker.saveState();
        }
        // Continue processing (don't return) in case there are errors
    }

    // Skip raw protocol details
    if (log.message.includes('send [') || log.message.includes('receive message [')) return;

    // Skip verbose meter values ONLY if not problematic
    if (log.message.includes('MeterValues') && !log.message.includes('timeout') && !log.message.includes('error') && !log.message.includes('failed')) return;

    // Skip ALL TriggerMessage logs (very noisy, rarely actionable)
    if (log.message.includes('TriggerMessage')) return;

    // === SMART PATTERN DETECTION ===

    const analysis = analyzeMessage(log);

    // If important, keep the event
    if (analysis.important) {
        const event = {
            ts: log.timestamp,
            level: log.level,
            logger: normalizeLogger(log.logger, chargerId),
            msg: log.message,
            chargerId,
            category: analysis.category,
            severity: analysis.severity
        };

        eventBuffer.push(event);

        // Update state tracker
        if (chargerId) {
            updateTrackerState(chargerId, log, analysis);
        }

        // Generate alert if needed
        if (analysis.alert) {
            queueAlert({
                type: analysis.category,
                severity: analysis.severity,
                chargerId,
                message: analysis.alertMessage || log.message,
                timestamp: log.timestamp,
                rawLog: log
            });
        }
    }
}

function analyzeMessage(log) {
    const msg = log.message;
    const level = log.level;

    // Filter noise patterns (not real problems)
    
    // Transaction -1 errors (first MeterValue with placeholder ID)
    // Only ignore if it happens <=3 times, alert if it repeats more
    if (msg.includes('Transaction -1 not found')) {
        const chargerId = extractChargerId(log);
        if (chargerId) {
            const count = (transaction1ErrorCount.get(chargerId) || 0) + 1;
            transaction1ErrorCount.set(chargerId, count);
            
            if (count <= 3) {
                // First few times: probably timing quirk, ignore
                console.log(`📊 Transaction -1 error for ${chargerId} (count: ${count}/3)`);
                return { important: false };
            } else {
                // Repeated too many times: real problem!
                console.log(`🚨 Transaction -1 error threshold exceeded for ${chargerId} (count: ${count})`);
                return {
                    important: true,
                    category: 'transaction_id_error',
                    severity: 'error',
                    alert: true,
                    alertMessage: `Carregador repetidamente falhando em processar transaction_id (${count} erros)`
                };
            }
        }
        // No charger ID found, ignore
        return { important: false };
    }

    // Transaction patterns
    if (msg.includes('StartTransaction')) {
        if (msg.includes('conf') && msg.includes('Accepted')) {
            return { important: true, category: 'transaction_start', severity: 'info' };
        }
        if (msg.includes('rejected') || msg.includes('Invalid')) {
            // Extract details for better diagnosis
            const idTagMatch = msg.match(/id_tag[=:]?\s*['"]([^'"]+)['"]/);
            const statusMatch = msg.match(/status[=:]?\s*['"]?([A-Za-z]+)['"]?/);
            const connectorMatch = msg.match(/connector[_]?id[=:]?\s*(\d+)/);
            
            let alertMsg = 'Usuário falhou ao iniciar transação';
            if (statusMatch) {
                alertMsg += `: ${statusMatch[1]}`;
            }
            
            return { 
                important: true, 
                category: 'transaction_failed_start', 
                severity: 'warning',
                alert: true,
                alertMessage: alertMsg,
                metadata: {
                    idTag: idTagMatch ? idTagMatch[1] : null,
                    status: statusMatch ? statusMatch[1] : null,
                    connectorId: connectorMatch ? connectorMatch[1] : null,
                    requiresCodeAnalysis: true,
                    investigationHints: [
                        'Check Vercel logs for API errors',
                        'Check user authorization status',
                        'Check charger availability at timestamp'
                    ]
                }
            };
        }
    }

    if (msg.includes('StopTransaction')) {
        return { important: true, category: 'transaction_stop', severity: 'info' };
    }

    // Charger health
    if (msg.includes('StatusNotification')) {
        if (msg.includes('Faulted')) {
            // Extract error details
            const errorCodeMatch = msg.match(/error_code[=:]?\s*([A-Za-z]+)/);
            const infoMatch = msg.match(/['"]info['"]:\s*['"]([^'"]+)['"]/);
            const vendorErrorMatch = msg.match(/vendor_error_code[=:]?\s*['\"]([^'\"]+)['\"]/);
            
            let alertMsg = 'Carregador entrou em estado FAULTED';
            // Priority: info field (most specific) > error_code (generic)
            if (infoMatch) {
                alertMsg += `: ${infoMatch[1]}`;
            }
            if (errorCodeMatch) {
                alertMsg += ` (${errorCodeMatch[1]})`;
            }
            if (vendorErrorMatch) {
                alertMsg += ` [vendor: ${vendorErrorMatch[1]}]`;
            }
            
            return { 
                important: true, 
                category: 'charger_faulted', 
                severity: 'critical',
                alert: true,
                alertMessage: alertMsg,
                metadata: {
                    errorCode: errorCodeMatch ? errorCodeMatch[1] : null,
                    info: infoMatch ? infoMatch[1] : null,
                    vendorErrorCode: vendorErrorMatch ? vendorErrorMatch[1] : null
                }
            };
        }
        if (msg.includes('Available') || msg.includes('Charging')) {
            return { important: true, category: 'charger_status', severity: 'info' };
        }
    }

    if (msg.includes('BootNotification')) {
        if (msg.includes('Accepted')) {
            return { important: true, category: 'charger_boot', severity: 'info' };
        }
        if (msg.includes('rejected')) {
            return { 
                important: true, 
                category: 'charger_boot_failed', 
                severity: 'error',
                alert: true,
                alertMessage: 'Carregador falhou ao conectar (BootNotification rejected)'
            };
        }
    }

    // Power issues
    if (msg.includes('Active power: 0.0') || msg.includes('Active power: 0')) {
        return { 
            important: true, 
            category: 'power_zero', 
            severity: 'warning',
            // Don't alert immediately, state tracker will handle stuck transactions
        };
    }

    // Authorization issues
    if (msg.includes('Authorization') || msg.includes('Authorize')) {
        if (msg.includes('rejected') || msg.includes('Invalid')) {
            return { 
                important: true, 
                category: 'auth_failed', 
                severity: 'warning',
                alert: true,
                alertMessage: 'Autorização de usuário rejeitada'
            };
        }
    }

    // Remote operations failures
    if (msg.includes('RemoteStart') && msg.includes('rejected')) {
        return { 
            important: true, 
            category: 'remote_start_failed', 
            severity: 'error',
            alert: true,
            alertMessage: 'RemoteStart falhou (problema de app/plataforma)'
        };
    }

    // Errors and Critical
    if (level === 'ERROR' || level === 'CRITICAL') {
        return { 
            important: true, 
            category: 'error', 
            severity: level.toLowerCase(),
            alert: true,
            alertMessage: msg
        };
    }

    // Default: not important enough to keep
    return { important: false };
}

function updateTrackerState(chargerId, log, analysis) {
    const msg = log.message;

    // Update charger status
    if (msg.includes('StatusNotification')) {
        const statusMatch = msg.match(/(Available|Charging|Faulted|Unavailable|Reserved)/);
        if (statusMatch) {
            const newStatus = statusMatch[1];
            const oldStatus = tracker.chargers[chargerId]?.status;

            // FAULTED DETECTION - Capture error details
            if (newStatus === 'Faulted') {
                const errorCodeMatch = msg.match(/error_code[=:]?\s*([A-Za-z]+)/);
                // vendor_error_code may appear as: vendor_error_code': '10000'
                const vendorErrorMatch = msg.match(/vendor_error_code'?\s*[:=]\s*['\"]([^'\"]+)['\"]/);
                
                let faultDetails = 'Status: Faulted';
                if (errorCodeMatch) {
                    faultDetails += ` (error: ${errorCodeMatch[1]})`;
                }
                if (vendorErrorMatch) {
                    faultDetails += ` [vendor: ${vendorErrorMatch[1]}]`;
                }
                
                tracker.updateCharger(chargerId, { 
                    status: newStatus,
                    lastFaultReason: faultDetails
                });
                
                console.log(`🔴 Charger ${chargerId} FAULTED: ${faultDetails}`);
            } else {
                tracker.updateCharger(chargerId, { status: newStatus });
            }

            // RECOVERY DETECTION
            if (oldStatus === 'Faulted' && (newStatus === 'Available' || newStatus === 'Charging')) {
                const faultReason = tracker.chargers[chargerId]?.lastFaultReason || 'Unknown fault';
                
                console.log(`✅ Charger ${chargerId} RECOVERED: ${oldStatus} → ${newStatus}`);
                
                queueAlert({
                    type: 'charger_recovered',
                    severity: 'info',
                    chargerId,
                    message: `Carregador recuperado: ${oldStatus} → ${newStatus}`,
                    faultReason,
                    timestamp: log.timestamp,
                    rawLog: log
                });
            }
        }
    }

    // Track errors
    if (log.level === 'ERROR' || log.level === 'CRITICAL') {
        const charger = tracker.chargers[chargerId];
        const errorCount = (charger?.consecutiveErrors || 0) + 1;
        tracker.updateCharger(chargerId, { consecutiveErrors: errorCount });
    }

    // Reset error count on successful operations
    if (msg.includes('Accepted') || (log.level === 'INFO' && !msg.includes('error'))) {
        tracker.updateCharger(chargerId, { consecutiveErrors: 0 });
    }

    // Transaction tracking
    if (msg.includes('StartTransaction')) {
        const txIdMatch = msg.match(/transaction[_ ]?id[:\s]+(\d+)/i);
        if (txIdMatch && msg.includes('Accepted')) {
            console.log(`🔋 Transaction started: ${txIdMatch[1]} on ${chargerId}`);
            tracker.startTransaction(txIdMatch[1], chargerId);
            // Reset -1 error counter on successful transaction
            if (transaction1ErrorCount.has(chargerId)) {
                transaction1ErrorCount.delete(chargerId);
            }
        }
        if (msg.includes('rejected')) {
            // Log failed start attempt
            tracker.transactions.failed.push({
                chargerId,
                reason: 'StartTransaction rejected',
                timestamp: log.timestamp
            });
        }
    }

    if (msg.includes('StopTransaction')) {
        const txIdMatch = msg.match(/transaction[_ ]?id[:\s]+(\d+)/i);
        // OCPP StopTransaction reason can appear as reason=EVDisconnected / 'reason': 'PowerLoss', etc.
        const reasonMatch = msg.match(/reason['"]?\s*[:=]\s*['"]?([A-Za-z]+)/i);
        const stopReason = reasonMatch ? reasonMatch[1] : null;

        if (txIdMatch) {
            console.log(`⏹️ Transaction stopped: ${txIdMatch[1]} on ${chargerId}${stopReason ? ` (reason=${stopReason})` : ''}`);
            tracker.endTransaction(txIdMatch[1], stopReason || 'completed');
        }
    }

    // Credits exhausted marker (used to suppress "unexpected stop" pendency)
    if (msg.includes('No available credits for user')) {
        if (chargerId) {
            tracker.updateCharger(chargerId, { lastNoCreditsAt: new Date().toISOString() });
        }
    }

    // Power tracking
    if (msg.includes('Active power:')) {
        const powerMatch = msg.match(/Active power:\s*([\d.]+)/);
        if (powerMatch) {
            const power = parseFloat(powerMatch[1]);
            // Find active transaction for this charger
            const activeTx = Object.values(tracker.transactions.active).find(
                tx => tx.chargerId === chargerId
            );
            if (activeTx) {
                tracker.updateTransaction(activeTx.id, { power });
            }
        }
    }

    tracker.saveState();
}

function queueAlert(alert) {
    // Check for duplicates in pending
    const duplicate = pendingAlerts.find(a => 
        a.chargerId === alert.chargerId && 
        a.type === alert.type &&
        (Date.now() - new Date(a.timestamp).getTime()) < 60 * 60 * 1000 // 1 hour
    );

    if (!duplicate) {
        pendingAlerts.push(alert);
        savePendingAlerts();
        console.log(`🔔 Alert queued: ${alert.type} (${alert.chargerId})`);
    }
}

function extractChargerId(log) {
    // Try logger name first (most reliable)
    // Logger format: "charger_AR2510070008" or "charger_TACW2242922G8951"
    if (log.logger && log.logger.includes('charger_')) {
        const match = log.logger.match(/charger_([A-Z0-9]+)/i);
        if (match && isValidChargerId(match[1])) return match[1];
    }

    // Try multiple patterns in message
    const patterns = [
        /charger[_ ]?id[:\s]+([A-Z0-9]+)/i,
        /charge[_ ]?point[:\s]+([A-Z0-9]+)/i,
        /station[:\s]+([A-Z0-9]+)/i
    ];

    for (const pattern of patterns) {
        const match = log.message.match(pattern);
        if (match && isValidChargerId(match[1])) return match[1];
    }

    return null;
}

// Valid charger IDs:
// - Alphanumeric IDs MUST contain at least one letter AND one digit (filters out 'root', 'main', etc.)
//   Examples: AR2510070008, LZ2510150001, TACW2242922G8951, SN2208101656, DF260112002
// - Numeric IDs must be long (12+ digits) (Metrópole style): 124030001957, 814030001959
// Invalid: 0, 1, 2 (connector IDs — short numeric)
function isValidChargerId(id) {
    if (!id || id.length < 3) return false;
    // Pure numeric but long (12+ digits) → valid charger ID
    if (/^\d{12,}$/.test(id)) return true;

    // Alphanumeric: must contain at least one letter AND one digit
    const hasLetter = /[A-Za-z]/.test(id);
    const hasDigit = /\d/.test(id);
    if (hasLetter && hasDigit) return true;
    // Short numeric → connector ID, not a charger
    return false;
}

function flushBuffer() {
    if (eventBuffer.length === 0) return;

    let currentData = [];
    try {
        if (fs.existsSync(EVENTS_FILE)) {
            currentData = JSON.parse(fs.readFileSync(EVENTS_FILE));
        }
    } catch (e) {}

    // Keep last 500 events
    const newData = [...currentData, ...eventBuffer].slice(-10000);
    
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(newData, null, 2));
    eventBuffer = [];
}

function savePendingAlerts() {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(pendingAlerts, null, 2));
}

function startPeriodicTasks() {
    // Periodic flush
    setInterval(flushBuffer, 10000);
    setInterval(flushDbBuffer, 10000); // Flush DB buffer every 10s
    setInterval(() => tracker.saveState(), 30000);

    // Dedup key cleanup
    setInterval(cleanExpiredDedupeKeys, DEDUP_CLEAN_INTERVAL_MS);

    // TTL cleanup for ocpp_raw
    // Keep it cheap: delete old rows and let SQLite reuse pages; VACUUM can be done manually/off-peak.
    setInterval(() => {
        try {
            const ttlMs = OCPP_RAW_TTL_HOURS * 60 * 60 * 1000;
            const cutoff = Date.now() - ttlMs;
            const res = db.prepare('DELETE FROM ocpp_raw WHERE timestamp < ?').run(cutoff);
            if (res.changes > 0) {
                console.log(`🧹 TTL: deleted ${res.changes} ocpp_raw rows older than ${OCPP_RAW_TTL_HOURS}h`);
            }
        } catch (e) {
            console.error('TTL cleanup error:', e.message);
        }
    }, OCPP_RAW_TTL_CLEAN_INTERVAL_MS);

    // Clean transaction -1 error counters every hour
    setInterval(() => {
        const previousSize = transaction1ErrorCount.size;
        transaction1ErrorCount.clear();

        if (previousSize > 0) {
            console.log(`🧹 Cleaned ${previousSize} transaction -1 error counters`);
        }
    }, 60 * 60 * 1000); // 1 hour
}

// Flush DB buffers to SQLite
function flushDbBuffer() {
    if (dbBuffer.length === 0 && rawDbBuffer.length === 0) return;

    try {
        if (rawDbBuffer.length > 0) {
            insertOcppRawBatch(rawDbBuffer);
            rawDbBuffer = [];
        }

        if (dbBuffer.length > 0) {
            insertOcppEventBatch(dbBuffer);
            const count = dbBuffer.length;
            dbBuffer = [];
            // Log periodically (not every flush to avoid spam)
            if (count >= 10) {
                console.log(`💾 Persisted ${count} OCPP events to SQLite`);
            }
        }
    } catch (e) {
        console.error('DB write error:', e.message);
    }
}

// Simple category for DB — best-effort, doesn't try to parse unknown patterns
function simpleCategoryForDb(msg) {
    return classifyOcppEventType(msg);
}


module.exports = {
    classifyOcppEventType,
    normalizeLogger,
    extractChargerId,
    isValidChargerId,
    simpleCategoryForDb
};

if (require.main === module) {
    // Start
    connect();
    startPeriodicTasks();
    console.log('🧠 Smart Collector Enhanced v2.0');
    console.log('📊 Tracking: Transactions, Charger Health, Failures');
    console.log('💾 Persisting ALL events to SQLite');

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('Shutting down...');
        flushBuffer();
        flushDbBuffer();
        db.close();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        flushBuffer();
        flushDbBuffer();
        db.close();
        process.exit(0);
    });
}
