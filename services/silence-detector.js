#!/usr/bin/env node
/**
 * silence-detector.js
 *
 * Minutes-level "charger went silent" detection (2026-07-18 cable-theft
 * incident at Metropole Shopping 3 / 314030001957: charger was mid-session,
 * thieves cut power/comms at 00:24 BRT and NOTHING alerted; the 48h
 * station-offline cron is days too slow and the alert-engine was purely
 * event-driven, so a source that stops emitting events was invisible).
 *
 * A charger whose last ocpp_events row is older than SILENCE_THRESHOLD_MS,
 * while it WAS alive in the preceding ALIVE_WINDOW_MS, alerts:
 *   - critical when a transaction was active at the moment of silence
 *     (wording: "possivel corte de energia/furto de cabo")
 *   - warning otherwise (likely power/internet drop at the site)
 *
 * Anti-spam properties:
 *   - per-charger debounce via the injected shouldAlert callback (alert-engine
 *     passes its 1h shouldSendAlert); the ALIVE_WINDOW_MS bound additionally
 *     caps each silence episode at exactly ONE alert, because once the last
 *     event ages past the window the charger stops being a candidate.
 *   - if the WHOLE feed is stale the detector stays quiet: that is an ingest
 *     stall / OCPP-server outage and detectIngestStalls owns it.
 *   - >= AGGREGATE_THRESHOLD chargers going silent together collapse into a
 *     single "mass silence" alert (site power cut / backhaul outage), instead
 *     of one message per charger.
 *
 * The collector throttles heartbeats and MeterValues to 1 row per charger per
 * 5 minutes, so the 10-minute threshold means "missed two consecutive
 * keep-alive cycles", not "one late packet".
 *
 * Transaction-active is derived from the EVENT STREAM itself (primary): a
 * charging session shows ENERGY/DEDUCTED rows every ~30s (dashboard-logger
 * chargers) or throttled meter_values rows (<=5 min apart), so session rows
 * shortly before the last event, with no STOP_TX/StopTransaction after them,
 * mean a session was active when the charger went mute. A power cut
 * mid-session never logs a stop, which is exactly the signal we want.
 * The state-tracker's history/transactions.json `active` map is only a
 * SECONDARY corroborator: validated against prod on 2026-07-18, it showed 0
 * active entries while a session was demonstrably live (ENERGY/DEDUCTED
 * flowing), so it must never be the only source.
 *
 * Pure module: everything (db handle, clock, debounce, tx source) is
 * injectable so the whole decision table is unit-testable. alert-engine.js
 * wires it with one runDetector line.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TX_FILE = path.join(__dirname, '..', 'history', 'transactions.json');

const SILENCE_THRESHOLD_MS = 10 * 60 * 1000;  // silent = no event for 10 min
const ALIVE_WINDOW_MS = 60 * 60 * 1000;       // "was alive" = had events in the last hour
const ACTIVE_TX_RECENT_MS = 15 * 60 * 1000;   // tx-file entry counts as active if updated near the silence moment
const SESSION_LOOKBACK_MS = 10 * 60 * 1000;   // session rows this close to the last event = charging at silence
const MIN_EVENTS_ALIVE = 2;                   // one lone row is a blip, not an alive charger
const AGGREGATE_THRESHOLD = 4;                // >= this many silent at once -> one mass alert

// FCM push leg: POST to the Next.js internal route, which fans out to the
// station owners + brand/super admins via notifyStationOwners (critical:true
// when a session was active). Same secret the Next route gates on.
const NEXT_API_URL = (process.env.NEXT_API_URL || 'https://app.turbostation.com.br').replace(/\/+$/, '');
const MONITOR_API_SECRET = process.env.MONITOR_API_SECRET || process.env.SUPPORT_API_SECRET || '';

function timeBRT(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
    });
}

/**
 * Default tx source: the state-tracker's transactions.json `active` map.
 * Read-only; returns [] on any problem (missing file, parse error).
 */
function readActiveTransactionsFromDisk() {
    try {
        const data = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
        return Object.values((data && data.active) || {});
    } catch (_) {
        return [];
    }
}

/**
 * SECONDARY signal: a transactions.json `active` entry for this charger whose
 * lastUpdate is close to the moment of silence. Never trusted alone (prod
 * showed the file empty during a live session), but when present it carries
 * the tx id for the alert text.
 */
function findActiveTxAtSilence(activeTxs, chargerId, lastTs) {
    for (const tx of activeTxs || []) {
        if (!tx || tx.chargerId !== chargerId) continue;
        const updated = Date.parse(tx.lastUpdate || tx.startTime || '');
        if (!Number.isFinite(updated)) continue;
        if (updated >= lastTs - ACTIVE_TX_RECENT_MS) return tx;
    }
    return null;
}

// Rows that only exist while a session is delivering energy. Real prod shapes
// (2026-07-18 validation against ocpp.db): "ENERGY | consumed=..." and
// "DEDUCTED | amount=..." every ~30s (event_type='other'), plus the throttled
// meter_values path and transaction_start for other charger models.
const SESSION_ROW_SQL = `
    (
        (
            message LIKE 'ENERGY %' OR message LIKE 'ENERGY|%'
            OR message LIKE 'DEDUCTED %' OR message LIKE 'DEDUCTED|%'
            OR message LIKE '%MeterValues%'
            OR message LIKE 'START_TX%'
            OR event_type LIKE '%transaction_start%'
        )
        -- failure rows are not proof of charging: prod carries e.g.
        -- "MeterValues processing failed for transaction None" on IDLE
        -- chargers (found in the 2026-07-18 live validation, VTLZ2605210001).
        -- Same exclusion list the collector uses for its meter_values path.
        AND message NOT LIKE '%fail%'
        AND message NOT LIKE '%error%'
        AND message NOT LIKE '%timeout%'
    )
`;
const STOP_ROW_SQL = `
    (
        message LIKE 'STOP_TX%'
        OR message LIKE '%StopTransaction%'
        OR event_type LIKE '%transaction_stop%'
    )
`;

/**
 * PRIMARY signal: was a session delivering energy right up to the charger's
 * last event? True when the newest session row sits within
 * SESSION_LOOKBACK_MS of the last event AND no stop row follows it (a clean
 * session end logs STOP_TX/StopTransaction; a power cut never does).
 */
function sessionActiveAtSilence(ocppDb, chargerId, lastTs) {
    const lastSession = ocppDb.prepare(`
        SELECT MAX(timestamp) AS ts FROM ocpp_events
        WHERE charger_id = ? AND timestamp BETWEEN ? AND ? AND ${SESSION_ROW_SQL}
    `).get(chargerId, lastTs - ALIVE_WINDOW_MS, lastTs);
    const sessionTs = lastSession && Number(lastSession.ts);
    if (!Number.isFinite(sessionTs) || sessionTs < lastTs - SESSION_LOOKBACK_MS) return false;

    const lastStop = ocppDb.prepare(`
        SELECT MAX(timestamp) AS ts FROM ocpp_events
        WHERE charger_id = ? AND timestamp BETWEEN ? AND ? AND ${STOP_ROW_SQL}
    `).get(chargerId, sessionTs, lastTs);
    const stopTs = lastStop && Number(lastStop.ts);
    return !(Number.isFinite(stopTs) && stopTs > sessionTs);
}

function buildEvidence(kind, candidate) {
    // Shaped like the other detectors' evidence so formatAlertMessage can walk
    // it, and so partner-fault-notifier's classifyFault sees "disconnected" in
    // the raw message and picks the STATION_OFFLINE partner template
    // (breaker/router checklist).
    return {
        kind,
        ocpp: {
            event: {
                id: candidate.last_event_id ?? null,
                timestamp: candidate.last_ts,
                charger_id: candidate.charger_id,
                event_type: candidate.last_event_type || null,
                message: `Carregador sem comunicacao (disconnected) desde ${new Date(candidate.last_ts).toISOString()}; ultimo evento: ${candidate.last_event_type || '?'}`,
            },
            meta: null,
            raw: null,
        },
    };
}

function buildSilenceAlert(candidate, now) {
    const silentMin = Math.round((now - candidate.last_ts) / 60000);
    const lastSeen = timeBRT(candidate.last_ts);
    const tx = candidate.tx;

    if (candidate.tx_active) {
        const txLabel = tx && tx.id != null ? ` (tx ${tx.id})` : '';
        return {
            type: 'charger_silent',
            severity: 'critical',
            title: 'Carregador mudo com sessao ativa',
            description:
                `Sem comunicacao ha ${silentMin} min e havia transacao ativa${txLabel} no momento do silencio: ` +
                `possivel corte de energia/furto de cabo. Ultima mensagem: ${lastSeen} (BRT). ` +
                `Acao: verificar local/cameras imediatamente.`,
            charger_id: candidate.charger_id,
            silent_since_ts: candidate.last_ts,
            silent_minutes: silentMin,
            tx_active: true,
            ...(tx && tx.id != null ? { tx_id: tx.id } : {}),
            ocpp_log_ids: candidate.last_event_id != null ? JSON.stringify([candidate.last_event_id]) : null,
            evidence_json: JSON.stringify(buildEvidence('charger_silent', candidate)),
            // Empty parsed_fault forces partner-fault-notifier's classifyFault
            // down the raw-message path (which contains "disconnected").
            parsed_fault: {},
            // Health-style alert about the CURRENT state: the silence started
            // >10 min ago by definition, so using last_ts here would trip the
            // engine's MAX_ALERT_AGE_MS freshness guard and drop every alert.
            event_ts: now,
            timestamp: now,
        };
    }

    return {
        type: 'charger_silent',
        severity: 'warning',
        title: 'Carregador sem comunicacao',
        description:
            `Sem comunicacao ha ${silentMin} min (ativo ate ${lastSeen} BRT, sem sessao em andamento). ` +
            `Possivel queda de energia ou internet no local.`,
        charger_id: candidate.charger_id,
        silent_since_ts: candidate.last_ts,
        silent_minutes: silentMin,
        tx_active: false,
        ocpp_log_ids: candidate.last_event_id != null ? JSON.stringify([candidate.last_event_id]) : null,
        evidence_json: JSON.stringify(buildEvidence('charger_silent', candidate)),
        parsed_fault: {},
        event_ts: now,
        timestamp: now,
    };
}

function buildMassAlert(candidates, now) {
    const withTx = candidates.filter(c => c.tx_active);
    const anyTx = withTx.length > 0;
    const listed = candidates.slice(0, 10)
        .map(c => `${c.charger_id} (${Math.round((now - c.last_ts) / 60000)} min)`)
        .join(', ');
    const more = candidates.length > 10 ? ` e mais ${candidates.length - 10}` : '';

    let description =
        `${candidates.length} carregadores ficaram sem comunicacao quase ao mesmo tempo: ${listed}${more}. ` +
        `Provavel queda de energia/rede no local ou no caminho OCPP.`;
    if (anyTx) {
        description +=
            ` Havia sessao ativa em: ${withTx.map(c => c.charger_id).join(', ')} ` +
            `(possivel corte de energia/furto).`;
    }

    return {
        type: 'charger_silent_mass',
        severity: anyTx ? 'critical' : 'warning',
        title: anyTx ? 'Varios carregadores mudos (havia sessao ativa)' : 'Varios carregadores sem comunicacao',
        description,
        charger_id: null,
        evidence_json: JSON.stringify({
            kind: 'charger_silent_mass',
            chargers: candidates.map(c => ({
                charger_id: c.charger_id,
                last_ts: c.last_ts,
                tx_active: !!c.tx_active,
                tx_id: c.tx ? c.tx.id : null,
            })),
        }),
        event_ts: now,
        timestamp: now,
    };
}

/**
 * Detect chargers that went silent while previously alive.
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.ocppDb - handle on ocpp.db
 * @param {(key: string) => boolean} deps.shouldAlert - debounce gate; called
 *        with the charger id (or 'mass'); returning true also stamps the key.
 * @param {() => Array<object>} [deps.getActiveTransactions] - active-tx source
 *        (defaults to reading the state-tracker's transactions.json)
 * @param {number} [deps.now]
 * @param {Set<string>} [deps.ignoredChargers] - ids never alerted on (sites
 *        known to power down deliberately); defaults to SILENCE_IGNORE_CHARGERS env.
 * @returns {Array<object>} alert objects for alert-engine's save/dispatch loop
 */
function detectSilentChargers({
    ocppDb,
    shouldAlert,
    getActiveTransactions = readActiveTransactionsFromDisk,
    now = Date.now(),
    ignoredChargers = new Set(
        (process.env.SILENCE_IGNORE_CHARGERS || '').split(',').map(s => s.trim()).filter(Boolean)
    ),
} = {}) {
    const rows = ocppDb.prepare(`
        SELECT charger_id, MAX(timestamp) AS last_ts, COUNT(*) AS event_count
        FROM ocpp_events
        WHERE charger_id IS NOT NULL
          AND timestamp > ?
        GROUP BY charger_id
    `).all(now - ALIVE_WINDOW_MS);

    if (rows.length === 0) return [];

    // Whole-feed staleness is an ingest stall (collector or OCPP server down),
    // not N simultaneous cable thefts. detectIngestStalls owns that alert;
    // firing per-charger silences on top of it would be pure spam.
    const globalMax = Math.max(...rows.map(r => Number(r.last_ts) || 0));
    if (now - globalMax > SILENCE_THRESHOLD_MS) return [];

    let activeTxs = [];
    try {
        activeTxs = getActiveTransactions() || [];
    } catch (e) {
        console.error('[silence] failed reading active transactions:', e && e.message);
    }

    const lastEventStmt = ocppDb.prepare(`
        SELECT id, event_type
        FROM ocpp_events
        WHERE charger_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
    `);

    const candidates = [];
    for (const row of rows) {
        const chargerId = row.charger_id;
        const lastTs = Number(row.last_ts);
        if (!chargerId || !Number.isFinite(lastTs)) continue;
        if (ignoredChargers.has(chargerId)) continue;
        if (now - lastTs <= SILENCE_THRESHOLD_MS) continue;      // still talking
        if (row.event_count < MIN_EVENTS_ALIVE) continue;         // lone blip, not "was alive"

        const lastEvent = lastEventStmt.get(chargerId) || {};
        const fileTx = findActiveTxAtSilence(activeTxs, chargerId, lastTs);
        // Event-stream signal is PRIMARY (prod's transactions.json proved
        // unreliable: empty during a live session, 2026-07-18 validation).
        let sessionActive = false;
        try {
            sessionActive = sessionActiveAtSilence(ocppDb, chargerId, lastTs);
        } catch (e) {
            console.error(`[silence] session-activity query failed for ${chargerId}:`, e && e.message);
        }
        candidates.push({
            charger_id: chargerId,
            last_ts: lastTs,
            last_event_id: lastEvent.id ?? null,
            last_event_type: lastEvent.event_type || null,
            tx: fileTx,
            tx_active: sessionActive || !!fileTx,
        });
    }

    if (candidates.length === 0) return [];

    // Mass silence: one aggregate message. Stamp each charger's debounce key
    // too, so chargers still silent when the count drops below the threshold
    // don't re-fire as individual alerts right after.
    if (candidates.length >= AGGREGATE_THRESHOLD) {
        if (!shouldAlert('mass')) return [];
        for (const c of candidates) shouldAlert(c.charger_id);
        return [buildMassAlert(candidates, now)];
    }

    const alerts = [];
    for (const c of candidates) {
        if (!shouldAlert(c.charger_id)) continue;
        alerts.push(buildSilenceAlert(c, now));
    }
    return alerts;
}

/**
 * FCM push leg for a single-charger silence alert: POST to the Next.js
 * internal route, which resolves the station's owners + brand/super admins
 * and pushes via notifyStationOwners (critical channel when txActive).
 * Fire-and-forget from alert-engine's dispatch loop; never throws.
 */
async function notifySilencePush(alert) {
    if (!alert || alert.type !== 'charger_silent' || !alert.charger_id) return false;
    if (!MONITOR_API_SECRET) {
        console.warn('[silence-push] MONITOR_API_SECRET not set, skipping FCM push');
        return false;
    }
    try {
        const res = await fetch(`${NEXT_API_URL}/api/internal/charger-silent-alert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-monitor-secret': MONITOR_API_SECRET,
            },
            body: JSON.stringify({
                chargerId: alert.charger_id,
                silentSinceTs: alert.silent_since_ts,
                silentMinutes: alert.silent_minutes,
                txActive: !!alert.tx_active,
                ...(alert.tx_id != null ? { txId: String(alert.tx_id) } : {}),
            }),
        });
        if (!res.ok) {
            console.error(`[silence-push] Next API ${res.status} for ${alert.charger_id}`);
            return false;
        }
        const data = await res.json().catch(() => null);
        console.log(`[silence-push] sent charger=${alert.charger_id} status=${data && data.status}`);
        return true;
    } catch (e) {
        console.error('[silence-push] error:', e && e.message);
        return false;
    }
}

module.exports = {
    detectSilentChargers,
    notifySilencePush,
    readActiveTransactionsFromDisk,
    findActiveTxAtSilence,
    sessionActiveAtSilence,
    buildSilenceAlert,
    buildMassAlert,
    SILENCE_THRESHOLD_MS,
    ALIVE_WINDOW_MS,
    ACTIVE_TX_RECENT_MS,
    SESSION_LOOKBACK_MS,
    MIN_EVENTS_ALIVE,
    AGGREGATE_THRESHOLD,
};
