/**
 * ocpp-utils.js
 *
 * Shared OCPP message parsing helpers used by alert-engine and
 * partner-fault-notifier. Extracted here to avoid circular imports.
 */

'use strict';

/**
 * Parse free-text StatusNotification fault detail back into structured fields.
 * The collector stores the detail as a `message` string like:
 *   "STATUS_NOTIF charger=X connector=1 status=Faulted error=OtherError, info=SECC CAN Offline"
 */
function parseStatusNotif(message) {
    const out = { connectorId: null, status: null, error: null, info: null, vendorError: null };
    if (!message) return out;
    const conn = message.match(/connector[=:]?\s*(\d+)/i);
    const status = message.match(/status[=:]?\s*([A-Za-z]+)/i);
    const err = message.match(/(?:^|\s)error[=:]?\s*([^,]+?)(?:,|\s+info|\s+vendor_error|$)/i);
    const info = message.match(/info[=:]?\s*([^,]+?)(?:,|\s+vendor_error|$)/i);
    const vendor = message.match(/vendor_error[=:]?\s*(.+?)\s*$/i);
    if (conn) out.connectorId = Number(conn[1]);
    if (status) out.status = status[1];
    if (err) out.error = err[1].trim();
    if (info) out.info = info[1].trim();
    if (vendor) out.vendorError = vendor[1].trim();
    return out;
}

/**
 * True when a "fault" is really an operator pressing the physical e-stop button.
 * These have their own dedicated WhatsApp alert and must not escalate further.
 */
function isEmergencyStopFault(parsed, rawMessage) {
    const hay = [(parsed && parsed.info) || '', (parsed && parsed.vendorError) || '', rawMessage || ''].join(' ');
    return /emergency/i.test(hay);
}

/**
 * True when the fault matches the cable-theft signature: a temperature error
 * with the cable disconnected/cut. When the Metrópole Shopping 1 cable was
 * stolen (2026-05-05), the charger reported
 *   status=Faulted error=HighTemperature, info=DC OverTemp Connector, vendor_error=29
 * every 5 minutes — the severed thermistor line reads as over-temperature.
 * A genuine thermal event matches too; both deserve the urgent group.
 *
 * ⚠️ SIGNATURE DRIFT: this owns the URGENTE *WhatsApp* leg. The *FCM push* twin
 * is `isHighTempFault` in the turbo_station repo
 * (`next/lib/services/high-temp-critical-push.ts`). The two paths detect the
 * SAME signal via independent data pipelines on purpose (this reads ocpp.db,
 * Next.js reads the live webhook) so neither is a single point of failure — but
 * a change to what counts as a theft-signature fault (e.g. another vendor's
 * overtemp code) MUST be made in BOTH or the channels disagree. Keep in sync.
 */
function isCableTheftSuspectFault(parsed, rawMessage) {
    const error = (parsed && parsed.error) || '';
    const info = (parsed && parsed.info) || '';
    if (/hightemperature/i.test(error)) return true;
    if (/overtemp/i.test(info)) return true;
    // Fallback for raw lines the parser couldn't split into fields.
    return /error=HighTemperature/i.test(rawMessage || '');
}

module.exports = { parseStatusNotif, isEmergencyStopFault, isCableTheftSuspectFault };
