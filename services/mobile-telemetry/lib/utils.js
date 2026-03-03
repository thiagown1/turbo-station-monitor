/**
 * Utility Helpers
 *
 * Shared functions used across route handlers for parsing, deriving
 * values, and other common operations.
 *
 * @module lib/utils
 */

/**
 * Safely parse lat/lng from a data_json string.
 *
 * @param {string|null} dataJson — raw JSON string from mobile_events.data_json
 * @returns {{ lat: number|null, lng: number|null }}
 */
function parseLocation(dataJson) {
    try {
        const data = JSON.parse(dataJson || '{}');
        return { lat: data.lat ?? null, lng: data.lng ?? null };
    } catch {
        return { lat: null, lng: null };
    }
}

/**
 * Derive event severity from its type.
 *
 * @param {string} eventType
 * @returns {'error'|'warning'|'info'}
 */
function deriveSeverity(eventType) {
    if (eventType === 'error' || eventType === 'transaction_error') return 'error';
    if (eventType === 'user_cancelled') return 'warning';
    return 'info';
}

module.exports = { parseLocation, deriveSeverity };
