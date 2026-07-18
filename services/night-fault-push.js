#!/usr/bin/env node
/**
 * night-fault-push.js
 *
 * Fires the Next.js internal /api/internal/partner-fault-alert route for
 * overnight first-faults (see the night-watch escalation in alert-engine.js).
 * With `nightWatch: true` in the body, the Next side fans out a critical FCM
 * push to the station's owners + brand/super admins (notifyStationOwners),
 * gated there by feature_flags/night_fault_push (default OFF) — so this
 * caller can ship and run before the push is ever enabled.
 *
 * Fire-and-forget: any failure here is logged and never blocks the internal
 * WhatsApp/Telegram alert path. Until the Next deploy that adds `nightWatch`
 * to the route's strict schema, this POST answers 400 invalid_body — logged,
 * harmless, self-heals on deploy.
 */

'use strict';

// Prod Next.js app (Vercel). The apex domain 308-redirects to www, so target
// www directly. Set NEXT_API_URL='' to disable the caller entirely.
const NEXT_API_BASE = (process.env.NEXT_API_URL !== undefined
    ? process.env.NEXT_API_URL
    : 'https://www.turbostation.com.br').replace(/\/+$/, '');

// Same shared secret the Next route checks (x-monitor-secret). MONITOR_API_SECRET
// is the canonical name on both sides; SUPPORT_API_SECRET kept as fallback to
// match how alert-engine resolves it for support-copilot calls.
const MONITOR_SECRET = process.env.MONITOR_API_SECRET || process.env.SUPPORT_API_SECRET || '';

/**
 * @param {object} alert - charger_fault alert from detectChargerFaults()
 *                         (charger_id, description, ocpp_log_ids, event_ts,
 *                         parsed_fault).
 * @returns {Promise<boolean>} true when the route accepted the call.
 */
async function notifyNightFaultPush(alert) {
    if (!NEXT_API_BASE) return false;
    if (!MONITOR_SECRET) {
        console.warn('[night-push] MONITOR_API_SECRET not set — cannot call Next route');
        return false;
    }

    const parsed = alert.parsed_fault || {};

    // The OCPP event id keeps the Next-side idempotency key stable across an
    // engine restart (same seed the partner-WhatsApp leg uses).
    let eventId = null;
    try {
        const ids = JSON.parse(alert.ocpp_log_ids || '[]');
        if (Array.isArray(ids) && ids.length) eventId = ids[0];
    } catch (_) { /* fall through to event_ts */ }

    const body = {
        chargerId: String(alert.charger_id || '').slice(0, 64),
        eventId: eventId != null ? eventId : String(alert.event_ts || Date.now()).slice(0, 64),
        description: String(alert.description || '').slice(0, 500),
        nightWatch: true,
    };
    if (parsed.error) body.faultCode = String(parsed.error).slice(0, 64);
    if (parsed.info) body.faultInfo = String(parsed.info).slice(0, 200);
    if (typeof parsed.connectorId === 'number') body.connectorId = parsed.connectorId;

    try {
        const res = await fetch(`${NEXT_API_BASE}/api/internal/partner-fault-alert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-monitor-secret': MONITOR_SECRET,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error(`[night-push] Next route answered ${res.status} for ${body.chargerId}`);
            return false;
        }
        const data = await res.json().catch(() => null);
        const leg = data && data.nightPush
            ? `${data.nightPush.status}${data.nightPush.reason ? `/${data.nightPush.reason}` : ''}`
            : 'n/a';
        console.log(`[night-push] charger=${body.chargerId} nightPush=${leg}`);
        return true;
    } catch (e) {
        console.error('[night-push] fetch error:', e && e.message);
        return false;
    }
}

module.exports = { notifyNightFaultPush };
