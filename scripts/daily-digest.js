#!/usr/bin/env node
/**
 * Daily digest: charger faults still open vs resolved in the last 24h.
 *
 * Runs once a day (pm2 cron_restart, see ecosystem.config.js) so the group
 * gets one useful "ainda com problema / resolvido" summary instead of
 * reading real-time alert noise all day (see the escalating backoff added
 * alongside this — most of that noise was one charger stuck on the same
 * fault, re-alerting hourly for days).
 *
 * Reuses the escalating-backoff state from alert-engine.js
 * (history/charger_fault_backoff.json) to decide whether a charger+error is
 * still the SAME ongoing incident or has gone quiet long enough to count as
 * resolved — the same "gap > 2x last window" rule the live engine uses to
 * reset its own streak (see shouldSendChargerFaultAlert in alert-engine.js).
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { lookupStation } = require('../services/station-lookup');

const DB_DIR = path.join(__dirname, '..', 'db');
const ALERTS_DB_PATH = path.join(DB_DIR, 'logs.db');
const BACKOFF_FILE = path.join(__dirname, '..', 'history', 'charger_fault_backoff.json');

const WHATSAPP_CONV = process.env.ALERT_WHATSAPP_CONV || 'conv_jiuijxjtmnet23i9';
const WHATSAPP_BRAND = process.env.ALERT_WHATSAPP_BRAND || 'turbo_station';
const SUPPORT_API_BASE = (process.env.SUPPORT_API_URL || 'https://logs.turbostation.com.br').replace(/\/+$/, '');
const SUPPORT_API_SECRET = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '';

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

function loadBackoffState() {
    try {
        if (fs.existsSync(BACKOFF_FILE)) {
            return JSON.parse(fs.readFileSync(BACKOFF_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('⚠️ Error loading charger fault backoff state:', e.message);
    }
    return {};
}

/** "Carregador reportou falha (status=Faulted, erro=OtherError, info=...)" -> "OtherError" */
function extractErrorCode(description) {
    const m = description && description.match(/erro=([^,)]+)/);
    return m ? m[1].trim() : 'fault';
}

/** Group raw `alerts` rows (title='Carregador em falha') by charger+error. */
function groupChargerFaultRows(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!row.charger_id) continue;
        const errKey = extractErrorCode(row.description);
        const key = `${row.charger_id}::${errKey}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                chargerId: row.charger_id,
                errKey,
                description: row.description,
                count: 0,
                firstSeen: row.created_at,
                lastSeen: row.created_at,
            });
        }
        const g = groups.get(key);
        g.count += 1;
        g.firstSeen = Math.min(g.firstSeen, row.created_at);
        g.lastSeen = Math.max(g.lastSeen, row.created_at);
    }
    return [...groups.values()];
}

/**
 * Split charger+error groups into still-broken vs resolved using the live
 * backoff state. A group with no backoff entry (state pruned, or the engine
 * restarted and lost it) is treated as resolved — we only call something
 * "still broken" when we have positive evidence it is.
 */
function classifyGroups(groups, backoffState, now) {
    const stillBroken = [];
    const resolved = [];

    for (const g of groups) {
        const state = backoffState[g.key];
        const isActive = !!state && (now - state.lastSent) <= 2 * state.lastWindow;
        (isActive ? stillBroken : resolved).push(g);
    }

    stillBroken.sort((a, b) => b.count - a.count);
    resolved.sort((a, b) => b.lastSeen - a.lastSeen);

    return { stillBroken, resolved };
}

function attachStationNames(groups) {
    for (const g of groups) {
        const station = lookupStation(g.chargerId);
        g.name = station ? station.name : g.chargerId;
    }
    return groups;
}

function hoursAgo(ts, now) {
    return Math.round(((now - ts) / 3600000) * 10) / 10;
}

function minsAgo(ts, now) {
    return Math.round((now - ts) / 60000);
}

function formatStillBrokenLine(g, now) {
    return `🏢 ${g.name} (\`${g.chargerId}\`)\n`
        + `   ${g.errKey} — ${g.count}x nas últimas 24h, ativo há ${hoursAgo(g.firstSeen, now)}h (última há ${minsAgo(g.lastSeen, now)}min)`;
}

function formatResolvedLine(g, now) {
    return `- ${g.name} (\`${g.chargerId}\`): ${g.errKey}, ${g.count}x, sem repetir há ${hoursAgo(g.lastSeen, now)}h`;
}

/** Group backend ("... no backend") alert rows by endpoint, split repeated vs singleton. */
function summarizeBackendAlerts(rows) {
    const byEndpoint = new Map();
    for (const row of rows) {
        const m = row.description && row.description.match(/em (\S+)/);
        const endpoint = m ? m[1] : row.description;
        byEndpoint.set(endpoint, (byEndpoint.get(endpoint) || 0) + 1);
    }
    const repeated = [...byEndpoint.entries()].filter(([, c]) => c > 1);
    const singleton = [...byEndpoint.entries()].filter(([, c]) => c === 1);
    return { total: rows.length, repeated, singleton };
}

function buildMessage({ stillBroken, resolved, backendRows, now }) {
    const dateStr = new Date(now).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    let msg = `📊 *Resumo diário — carregadores* (${dateStr})\n`;

    if (stillBroken.length === 0 && resolved.length === 0) {
        msg += `\n✅ Nenhuma falha de carregador nas últimas 24h.`;
    } else {
        msg += `\n🔴 *Ainda com problema* (${stillBroken.length})\n`;
        msg += stillBroken.length
            ? stillBroken.map(g => formatStillBrokenLine(g, now)).join('\n')
            : '(nenhum)';

        msg += `\n\n✅ *Resolvido* (${resolved.length}, sem repetição recente)\n`;
        msg += resolved.length
            ? resolved.map(g => formatResolvedLine(g, now)).join('\n')
            : '(nenhum)';
    }

    if (backendRows.length > 0) {
        const { total, repeated, singleton } = summarizeBackendAlerts(backendRows);
        msg += `\n\n🌐 Backend: ${total} alerta(s) nas últimas 24h`;
        if (repeated.length) {
            msg += ` — repetiu em: ${repeated.map(([e, c]) => `${e} (${c}x)`).join(', ')}`;
        }
        if (singleton.length) {
            msg += `${repeated.length ? '; ' : ' — '}${singleton.length} isolado(s), sem repetição`;
        }
    }

    return msg;
}

async function sendWhatsapp(message) {
    if (!WHATSAPP_CONV || !SUPPORT_API_SECRET) {
        console.error('⚠️ Missing ALERT_WHATSAPP_CONV or SUPPORT_API_SECRET — digest not sent.');
        return false;
    }
    try {
        const url = `${SUPPORT_API_BASE}/api/support/conversations/${encodeURIComponent(WHATSAPP_CONV)}/messages?brandId=${encodeURIComponent(WHATSAPP_BRAND)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-secret': SUPPORT_API_SECRET,
                'x-brand-id': WHATSAPP_BRAND,
            },
            body: JSON.stringify({ body: message, source: 'system' }),
        });
        if (!res.ok) {
            console.error(`❌ Error sending WhatsApp digest: support API ${res.status}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error(`❌ Error sending WhatsApp digest: ${e && e.message}`);
        return false;
    }
}

async function main() {
    const now = Date.now();
    const cutoff = now - DIGEST_WINDOW_MS;

    const db = new Database(ALERTS_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');

    const faultRows = db.prepare(
        `SELECT charger_id, description, created_at FROM alerts WHERE title = 'Carregador em falha' AND created_at > ? ORDER BY created_at ASC`
    ).all(cutoff);
    const backendRows = db.prepare(
        `SELECT title, description, created_at FROM alerts WHERE title LIKE '%no backend' AND created_at > ? ORDER BY created_at DESC`
    ).all(cutoff);

    db.close();

    const backoffState = loadBackoffState();
    const groups = groupChargerFaultRows(faultRows);
    const { stillBroken, resolved } = classifyGroups(groups, backoffState, now);
    attachStationNames(stillBroken);
    attachStationNames(resolved);

    const message = buildMessage({ stillBroken, resolved, backendRows, now });
    console.log(message);

    const sent = await sendWhatsapp(message);
    console.log(sent ? '✅ Digest sent' : '❌ Digest not sent');
    process.exit(sent ? 0 : 1);
}

if (require.main === module) {
    main().catch(err => {
        console.error('❌ Fatal error in daily-digest:', err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

module.exports = {
    extractErrorCode,
    groupChargerFaultRows,
    classifyGroups,
    summarizeBackendAlerts,
    buildMessage,
};
