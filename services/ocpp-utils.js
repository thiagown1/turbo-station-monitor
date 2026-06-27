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

module.exports = { parseStatusNotif, isEmergencyStopFault };
