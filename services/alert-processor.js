const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { lookupStation } = require('./station-lookup');

const ALERTS_FILE = path.join(__dirname, '..', 'history/pending_alerts.json');
const SENT_CACHE = path.join(__dirname, '..', 'history/sent_alerts.json');
const WHATSAPP_GROUP = '120363423472541295@g.us';
const DB_PATH = path.join(__dirname, '..', 'db/logs.db');

// WhatsApp anti-spam / freshness guards
const MAX_ALERT_AGE_MS = 10 * 60 * 1000; // never send per-event alerts older than 10 minutes
const RATE_LIMIT_FILE = path.join(__dirname, '..', 'history/whatsapp_rate_limit.json');
// Hard limits to reduce ban risk (keep conservative)
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_MSGS_PER_WINDOW = 4;     // max 4 messages / 10 min
const RATE_LIMIT_MAX_MSGS_PER_HOUR = 12;      // max 12 messages / hour

function loadRateLimit() {
    try {
        if (fs.existsSync(RATE_LIMIT_FILE)) {
            return JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf8'));
        }
    } catch (e) {}
    return { sentAt: [] };
}

function saveRateLimit(state) {
    try {
        fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
}

function canSendWhatsAppNow() {
    // Rate limit should apply ONLY for automatic messages to WhatsApp GROUPS
    // (DMs in our conversation are fine; they are not sent by these scripts anyway.)
    if (!WHATSAPP_GROUP || !WHATSAPP_GROUP.endsWith('@g.us')) return true;

    const now = Date.now();
    const state = loadRateLimit();
    const arr = Array.isArray(state.sentAt) ? state.sentAt : [];

    const hourMs = 60 * 60 * 1000;
    const windowCutoff = now - RATE_LIMIT_WINDOW_MS;
    const hourCutoff = now - hourMs;

    const inWindow = arr.filter(ts => ts > windowCutoff);
    const inHour = arr.filter(ts => ts > hourCutoff);

    if (inWindow.length >= RATE_LIMIT_MAX_MSGS_PER_WINDOW) return false;
    if (inHour.length >= RATE_LIMIT_MAX_MSGS_PER_HOUR) return false;

    return true;
}

function markWhatsAppSent() {
    const now = Date.now();
    const state = loadRateLimit();
    const arr = Array.isArray(state.sentAt) ? state.sentAt : [];
    // keep last 24h only
    const dayCutoff = now - 24 * 60 * 60 * 1000;
    state.sentAt = [...arr.filter(ts => ts > dayCutoff), now];
    saveRateLimit(state);
}

// SQLite (read-only usage here)
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Debounce cache
let sentAlerts = loadSentCache();

function loadSentCache() {
    try {
        if (fs.existsSync(SENT_CACHE)) {
            return JSON.parse(fs.readFileSync(SENT_CACHE));
        }
    } catch (e) {}
    return {};
}

function saveSentCache() {
    fs.writeFileSync(SENT_CACHE, JSON.stringify(sentAlerts, null, 2));
}

function loadPendingAlerts() {
    try {
        if (fs.existsSync(ALERTS_FILE)) {
            return JSON.parse(fs.readFileSync(ALERTS_FILE));
        }
    } catch (e) {}
    return [];
}

function clearPendingAlerts() {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify([], null, 2));
}

function analyzeAlert(alert) {
    const { type, severity, chargerId, message, timestamp } = alert;

    // Rule-based instant classification
    let emoji = '🟡';
    let title = 'Alerta OCPP';
    let action = '';

    switch (severity) {
        case 'critical':
            emoji = '🔴';
            break;
        case 'error':
            emoji = '🟠';
            break;
        case 'warning':
            emoji = '🟡';
            break;
        default:
            emoji = 'ℹ️';
    }

    switch (type) {
        case 'charger_faulted':
            title = 'Carregador em FALHA';
            action = '⚡ Ação: Reiniciar remotamente via plataforma';
            break;

        case 'charger_recovered':
            emoji = '✅';
            title = 'Carregador RECUPERADO';
            action = '👍 Estação voltou ao normal';
            break;

        case 'transaction_failed_start':
            title = 'Usuário não conseguiu iniciar carga';
            action = '👤 Ação: Verificar logs do app/autorização';
            break;

        case 'charger_boot_failed':
            title = 'Carregador offline (BootNotification falhou)';
            action = '🔌 Ação: Verificar conexão/energia';
            break;

        case 'remote_start_failed':
            title = 'Falha no RemoteStart (App/Plataforma)';
            action = '📱 Ação: Verificar integração app ↔ servidor';
            break;

        case 'auth_failed':
            title = 'Autorização rejeitada';
            action = '🔑 Ação: Verificar cadastro do usuário';
            break;

        case 'charger_needs_restart':
            title = 'Carregador precisa de restart';
            action = '♻️ Ação: Reiniciar via plataforma ou fisicamente';
            break;

        default:
            title = 'Erro OCPP';
            action = '';
    }

    return { emoji, title, action };
}

function formatAlertMessage(alert) {
    const { emoji, title, action } = analyzeAlert(alert);
    const { chargerId, message, timestamp, rawLog, faultReason } = alert;

    const dt = new Date(timestamp);

    // Always show both: UTC (server-friendly) + BRT (operator-friendly)
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

    let msg = `${emoji} *${title}*\\n\\n`;
    
    // Lookup station info
    const station = chargerId ? lookupStation(chargerId) : null;
    
    if (station) {
        // Rich format with station name and location
        msg += `🏢 *${station.name}*\\n`;
        msg += `📍 ${station.location}\\n`;
        msg += `🆔 ${chargerId}\\n\\n`;
    } else if (chargerId) {
        // Fallback: just charger ID
        msg += `🔌 *Carregador: ${chargerId}*\\n\\n`;
    } else {
        msg += `⚠️ Carregador desconhecido\\n\\n`;
    }


    // For recovery alerts: show what it recovered FROM
    if (alert.type === 'charger_recovered' && faultReason) {
        msg += `📋 Problema anterior: ${faultReason}\\n\\n`;
    }
    // Extract detailed error info from message
    const errorDetails = extractErrorDetails(message, rawLog);
    
    if (errorDetails.errorCode) {
        msg += `❌ Erro: \`${errorDetails.errorCode}\`\\\\n`;
    }
    
    if (errorDetails.vendorError) {
        msg += `🔧 Vendor: \`${errorDetails.vendorError}\`\\\\n`;
    }

    if (errorDetails.connector) {
        msg += `🔌 Conector: ${errorDetails.connector}\\n`;
    }

    // Show relevant part of message (cleaned up)
    const cleanMsg = cleanMessage(message);
    if (cleanMsg) {
        msg += `\\n📝 ${cleanMsg}\\n`;
    }

    msg += `🕐 UTC: ${timeUtc}\\n`;
    msg += `🕐 UTC-3: ${timeBrt}\\n`;

    if (action) {
        msg += `\\n${action}`;
    }

    return msg;
}

function extractErrorDetails(message, rawLog) {
    const details = {
        errorCode: null,
        vendorError: null,
        connector: null,
        status: null
    };

    // Extract error_code
    const errorMatch = message.match(/error_code[=:]?\\s*([A-Za-z]+)/);
    if (errorMatch) {
        details.errorCode = errorMatch[1];
    }

    // Extract vendor_error_code
    // Can appear as: vendor_error_code': '10000'
    const vendorMatch = message.match(/vendor_error_code'?\\s*[:=]\\s*['\"]([^'\"]+)['\"]/);
    if (vendorMatch) {
        details.vendorError = vendorMatch[1];
    } else if (rawLog?.message) {
        const vendorMatch2 = rawLog.message.match(/vendor_error_code'?\\s*[:=]\\s*['\"]([^'\"]+)['\"]/);
        if (vendorMatch2) details.vendorError = vendorMatch2[1];
    }

    // Extract connector
    const connectorMatch = message.match(/connector_id[=:]?\\s*(\\d+)/);
    if (connectorMatch) {
        details.connector = connectorMatch[1];
    }

    // Extract status
    const statusMatch = message.match(/status[=:]?\\s*([A-Za-z]+)/);
    if (statusMatch) {
        details.status = statusMatch[1];
    }

    return details;
}

function cleanMessage(message) {
    // Remove redundant technical details already shown
    let clean = message
        .replace(/error_code[=:]?\\s*[A-Za-z]+,?\\s*/gi, '')
        .replace(/vendor_error_code[=:]?\\s*['\"][^'\"]+['\"],?\\s*/gi, '')
        .replace(/connector_id[=:]?\\s*\\d+,?\\s*/gi, '')
        .replace(/kwargs:\\s*\\{[^}]+\\}/gi, '')
        .replace(/timestamp[=:]?\\s*['\"][^'\"]+['\"],?\\s*/gi, '');

    // Limit length
    if (clean.length > 150) {
        clean = clean.substring(0, 150) + '...';
    }

    return clean.trim();
}

function wasChargingWithinWindow(chargerId, startTsMs, windowMs) {
    if (!chargerId) return false;
    const endTsMs = startTsMs + windowMs;

    // Look for any StatusNotification → Charging shortly after the incident.
    const row = db.prepare(
        `SELECT id, timestamp, message
         FROM logs
         WHERE source='ocpp'
           AND charger_id=?
           AND timestamp BETWEEN ? AND ?
           AND message LIKE '%StatusNotification%'
           AND message LIKE '%Charging%'
         ORDER BY timestamp ASC
         LIMIT 1`
    ).get(chargerId, startTsMs, endTsMs);

    return !!row;
}

function hadPositiveActivePowerWithinWindow(chargerId, startTsMs, windowMs) {
    if (!chargerId) return false;
    const endTsMs = startTsMs + windowMs;

    const rows = db.prepare(
        `SELECT timestamp, message
         FROM logs
         WHERE source='ocpp'
           AND charger_id=?
           AND timestamp BETWEEN ? AND ?
           AND message LIKE '%Active power:%'
         ORDER BY timestamp ASC
         LIMIT 20`
    ).all(chargerId, startTsMs, endTsMs);

    for (const r of rows) {
        const m = r.message.match(/Active power:\s*([\d.]+)/i);
        if (!m) continue;
        const w = parseFloat(m[1]);
        if (Number.isFinite(w) && w > 0) return true;
    }

    return false;
}

function shouldSendAlert(alert) {
    const key = `${alert.chargerId || 'global'}_${alert.type}`;
    const now = Date.now();

    // RemoteStart rejected: validate before bothering humans.
    // If the charger transitions to Charging within 60s, treat as self-healed noise.
    if (alert.type === 'remote_start_failed') {
        const tsMs = new Date(alert.timestamp).getTime();
        if (Number.isFinite(tsMs) && wasChargingWithinWindow(alert.chargerId, tsMs, 60 * 1000)) {
            console.log(`🟢 Suppressed remote_start_failed (self-healed): ${alert.chargerId}`);
            return false;
        }
    }

    // "User failed to start" can be false-positive when the transaction actually starts.
    // If we see real power draw shortly after, suppress.
    if (alert.type === 'transaction_failed_start') {
        const tsMs = new Date(alert.timestamp).getTime();
        if (Number.isFinite(tsMs) && hadPositiveActivePowerWithinWindow(alert.chargerId, tsMs, 90 * 1000)) {
            console.log(`🟢 Suppressed transaction_failed_start (power detected): ${alert.chargerId}`);
            return false;
        }
    }

    // Recovery alerts: short debounce (5 minutes to avoid duplicates)
    if (alert.type === 'charger_recovered') {
        if (sentAlerts[key]) {
            const timeSince = now - sentAlerts[key];
            if (timeSince < 5 * 60 * 1000) {
                console.log(`🔇 Recovery debounced: ${key} (sent ${Math.round(timeSince / 1000 / 60)}m ago)`);
                return false;
            }
        }
        sentAlerts[key] = now;
        saveSentCache();
        console.log(`✅ Recovery alert approved: ${alert.chargerId}`);
        return true;
    }

    // Problem alerts: 1 hour debounce
    if (sentAlerts[key]) {
        const timeSince = now - sentAlerts[key];
        if (timeSince < 60 * 60 * 1000) {
            console.log(`🔇 Debounced: ${key} (sent ${Math.round(timeSince / 1000 / 60)}m ago)`);
            return false;
        }
    }

    // Mark as sent
    sentAlerts[key] = now;
    saveSentCache();
    
    console.log(`✅ Alert approved: ${alert.type} for ${alert.chargerId || 'unknown'}`);
    return true;
}

function sendWhatsAppAlert(message) {
    return new Promise((resolve, reject) => {
        if (!canSendWhatsAppNow()) {
            console.log('🛑 WhatsApp rate limit hit — skipping send to avoid ban');
            resolve(false);
            return;
        }

        // Escape message for shell (use single quotes to avoid most escaping issues)
        const escapedMsg = message.replace(/'/g, "'\\\\''");

        const cmd = `openclaw message send --channel whatsapp --target '${WHATSAPP_GROUP}' --message '${escapedMsg}'`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Erro ao enviar WhatsApp: ${error.message}`);
                console.error(`stderr: ${stderr}`);
                reject(error);
                return;
            }
            markWhatsAppSent();
            console.log('✅ Alerta enviado para WhatsApp');
            resolve(true);
        });
    });
}

async function processPendingAlerts() {
    const pending = loadPendingAlerts();

    if (pending.length === 0) {
        console.log('✅ Nenhum alerta pendente');
        return;
    }

    // Never send old/backlog alerts (ban-risk + low value)
    const fresh = pending.filter(a => {
        const ts = new Date(a.timestamp).getTime();
        if (!Number.isFinite(ts)) return false;
        return (Date.now() - ts) <= MAX_ALERT_AGE_MS;
    });

    if (fresh.length !== pending.length) {
        console.log(`🧹 Dropped ${pending.length - fresh.length} old alerts (> ${Math.round(MAX_ALERT_AGE_MS/60000)}m)`);
    }

    if (fresh.length === 0) {
        clearPendingAlerts();
        return;
    }

    console.log(`📬 ${fresh.length} alertas pendentes (fresh)`);

    const toSend = fresh.filter(shouldSendAlert);

    if (toSend.length === 0) {
        console.log('🔇 Todos os alertas foram debounced');
        clearPendingAlerts();
        return;
    }

    // Send alerts
    for (const alert of toSend) {
        try {
            const message = formatAlertMessage(alert);
            await sendWhatsAppAlert(message);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limit
        } catch (e) {
            console.error('Erro ao processar alerta:', e.message);
        }
    }

    // Clear pending
    clearPendingAlerts();
}

// Clean old cache entries (older than 24h)
function cleanCache() {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    Object.keys(sentAlerts).forEach(key => {
        if (now - sentAlerts[key] > dayMs) {
            delete sentAlerts[key];
        }
    });

    saveSentCache();
}

// Check for chargers needing restart
function isValidChargerIdLocal(id) {
    if (!id || id.length < 3) return false;
    if (/^\d{12,}$/.test(id)) return true;
    const hasLetter = /[A-Za-z]/.test(id);
    const hasDigit = /\d/.test(id);
    return hasLetter && hasDigit;
}

const PENDING_CACHE = path.join(__dirname, '..', 'history/manual_pending_cache.json');
function loadPendingCache() {
    try {
        if (fs.existsSync(PENDING_CACHE)) return JSON.parse(fs.readFileSync(PENDING_CACHE));
    } catch (e) {}
    return { lastHash: null, lastSentAt: 0 };
}
function savePendingCache(cache) {
    try { fs.writeFileSync(PENDING_CACHE, JSON.stringify(cache, null, 2)); } catch (e) {}
}
function hashString(s) {
    // tiny non-crypto hash (avoid deps)
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

function stablePendingKey(manualList) {
    // Hash should NOT depend on "age" (which changes every minute).
    // Only on which chargers + which problem class.
    const key = manualList
        .map(x => `${x.id}:${x.reason}`)
        .sort()
        .join('|');
    return hashString(key);
}

function formatAge(iso) {
    if (!iso) return 'desconhecido';
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}m`; 
    const h = Math.floor(min / 60);
    const r = min % 60;
    return `${h}h${r.toString().padStart(2,'0')}m`;
}

function buildManualPendencies(tracker) {
    const needsRestart = tracker.getChargersNeedingRestart().filter(c => isValidChargerIdLocal(c.id));

    // "Atenção manual" candidates:
    // 1) Offline signals
    const manualOffline = needsRestart
        .filter(c => /Heartbeat timeout|BootNotification|offline/i.test(c.restartReason || ''))
        .map(c => {
            const hbAge = formatAge(c.lastHeartbeat);
            const mvAge = formatAge(c.lastMeterValue);
            const offlineSignal = `sem heartbeat há ${hbAge}`;
            const mvSignal = c.lastMeterValue ? `último MeterValues há ${mvAge}` : 'sem MeterValues';
            return {
                id: c.id,
                reason: c.restartReason,
                detail: `${offlineSignal}, ${mvSignal}`
            };
        });

    // 2) Stuck transaction (0W >10min)
    const manualStuck = needsRestart
        .filter(c => /0W >10min/i.test(c.restartReason || ''))
        .map(c => ({
            id: c.id,
            reason: c.restartReason,
            detail: 'verificar travamento (pode exigir reset/disjuntor se remoto não resolver)'
        }));

    // 3) Unexpected stops (recent)
    const unexpectedStops = tracker.getRecentUnexpectedStops(120);
    const manualStops = unexpectedStops
        .filter(tx => tx.chargerId && isValidChargerIdLocal(tx.chargerId))
        // If we saw "No available credits" shortly before, StopTransaction(reason=Remote) is expected.
        .filter(tx => {
            if (tx.endReason !== 'Remote') return true;
            const ch = tracker.chargers[tx.chargerId];
            if (!ch?.lastNoCreditsAt) return true;
            const dt = Math.abs(new Date(tx.endTime).getTime() - new Date(ch.lastNoCreditsAt).getTime());
            return dt > 2 * 60 * 1000;
        })
        .slice(-10)
        .map(tx => {
            const ch = tracker.chargers[tx.chargerId];
            const noCredits = ch?.lastNoCreditsAt
                ? ` | no_credits_at=${ch.lastNoCreditsAt}`
                : '';
            return {
                id: tx.chargerId,
                reason: `Recarga parou (reason=${tx.endReason})`,
                detail: `tx=${tx.id} | fim=${tx.endTime}${noCredits}`
            };
        });

    // Merge + de-dup by charger id keeping first occurrence
    const merged = [...manualOffline, ...manualStuck, ...manualStops];
    const seen = new Set();
    const manual = merged.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });

    return { manual, needsRestart };
}

function sendManualPendenciesIfNeeded(tracker) {
    const { manual } = buildManualPendencies(tracker);

    const lines = manual.map(c => `- ${c.id}: ${c.reason}${c.detail ? ` (${c.detail})` : ''}`);
    const body = lines.length ? lines.join('\n') : 'Nenhuma pendência.';

    const nowIsoUtc = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const payload = `📌 *Pendências (atenção manual)*\n(${nowIsoUtc})\n${body}`;

    const cache = loadPendingCache();
    const newHash = stablePendingKey(manual);
    const now = Date.now();

    // Only send when the list changes, with a minimum cooldown of 1 hour to prevent spam.
    // Additionally: never send more than once per 10 minutes even if the list flaps.
    const unchanged = cache.lastHash === newHash;
    const withinCooldown = (now - (cache.lastSentAt || 0)) < 60 * 60 * 1000;
    const withinHardMinGap = (now - (cache.lastSentAt || 0)) < 10 * 60 * 1000;

    if (withinHardMinGap) return;
    if (unchanged && withinCooldown) return;

    cache.lastHash = newHash;
    cache.lastSentAt = now;
    savePendingCache(cache);

    // Send to WhatsApp group directly (not as per-charger alert)
    sendWhatsAppAlert(payload);
}

function checkChargerHealth() {
    const StateTracker = require('./state-tracker');
    const tracker = new StateTracker();

    // Instead of spamming "precisa de restart" per charger, we keep a single
    // concise pending list for manual attention.
    sendManualPendenciesIfNeeded(tracker);
}

// Run check every 15 seconds
setInterval(() => {
    processPendingAlerts();
    checkChargerHealth();
}, 15000);

// Clean cache every hour
setInterval(cleanCache, 60 * 60 * 1000);

console.log('🚨 Alert Processor Started');
console.log(`📱 Target: WhatsApp Group ${WHATSAPP_GROUP}`);
console.log('⏱️  Checking every 15s');

// Initial run
processPendingAlerts();
checkChargerHealth();
