'use strict';
/**
 * Pure helpers for the partner-fault leg that goes through the Next route
 * POST /api/internal/partner-fault-alert (which owns the partner_fault_alerts
 * flag, the alert-policy duration gate, partner/group resolution and the
 * WhatsappOutbox audit). No I/O here so it is unit-testable.
 */

const OPERATIONAL = new Set([
    'available', 'preparing', 'charging', 'suspendedev', 'suspendedevse', 'finishing', 'reserved',
]);

/**
 * Start of the fault streak the connector is in right now.
 *
 * `rows` are `{ timestamp, status, connectorId }` newest first (already parsed
 * from StatusNotifications). Walks back until the last operational status of
 * the same connector; the oldest `Faulted` row seen on the way is the start.
 * Rows of other connectors are ignored when `connectorId` is known. Falls back
 * to `fallbackTs` when no faulted row is found.
 */
function findFaultStreakStart(rows, connectorId, fallbackTs) {
    let start = fallbackTs;
    for (const r of rows || []) {
        if (!r || !r.status) continue;
        if (connectorId != null && r.connectorId != null && r.connectorId !== connectorId) continue;
        const st = String(r.status).trim().toLowerCase();
        if (OPERATIONAL.has(st)) break;
        if (st === 'faulted' && Number.isFinite(r.timestamp)) start = r.timestamp;
    }
    return start;
}

/** Whole minutes between start and now; null when the start is unknown. */
function faultDurationMin(startTs, nowTs) {
    if (!Number.isFinite(startTs) || !Number.isFinite(nowTs)) return null;
    return Math.max(0, Math.floor((nowTs - startTs) / 60000));
}

/**
 * Body for the route (its schema is .strict(): no extra keys). The route wraps
 * the description with its own title and charger id, so the first line of the
 * notifier message (its title) is dropped to avoid a duplicated header.
 */
function buildRoutePayload({ fault, parsed, message, startTs, nowTs }) {
    const eventId = Number.isInteger(fault.event_ts) ? fault.event_ts : Math.trunc(nowTs);
    const body = String(message || '').split('\n').slice(1).join('\n').trim();
    const payload = {
        chargerId: String(fault.charger_id).slice(0, 64),
        eventId,
        description: (body || String(fault.description || 'Falha no carregador')).slice(0, 500),
    };
    const code = [parsed && parsed.error, parsed && parsed.vendorError && `vendor_error=${parsed.vendorError}`]
        .filter(Boolean).join(' ');
    if (code) payload.faultCode = code.slice(0, 64);
    if (parsed && parsed.info) payload.faultInfo = String(parsed.info).slice(0, 200);
    if (parsed && Number.isInteger(parsed.connectorId)) payload.connectorId = parsed.connectorId;
    const dur = faultDurationMin(startTs, nowTs);
    if (dur != null) payload.faultDurationMin = Math.min(dur, 100000);
    return payload;
}

module.exports = { findFaultStreakStart, faultDurationMin, buildRoutePayload };
