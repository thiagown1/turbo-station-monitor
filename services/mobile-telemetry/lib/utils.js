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

/**
 * Tenant that owns rows written before brand stamping existed.
 *
 * Shipped mobile builds <= 4.16.0 and the older server-side emitters never set
 * `brand_id`, so a large legacy slice of `mobile_events` has it NULL. All of
 * those rows belong to turbo_station in practice: no other brand had users
 * before the ZIV launch.
 */
const DEFAULT_BRAND_ID = 'turbo_station';

/**
 * Build the brand filter for a `mobile_events` query.
 *
 * Semantics:
 *  - No brand requested        -> no filter (cross-brand view, super admin).
 *  - Default brand requested   -> matching rows PLUS legacy rows with no tenant.
 *  - Any other brand requested -> matching rows ONLY; legacy rows stay out.
 *
 * The previous behaviour included tenant-less rows for *every* brand, a
 * deliberate stopgap from when no build stamped `brand_id`. Now that writers do
 * stamp it, keeping that would pollute a ZEV/PluGreen slice with turbo_station's
 * legacy traffic (~470k events) and make per-brand adoption unreadable.
 *
 * Returns the SQL fragment plus a cache discriminator: the two shapes produce
 * different SQL, so a prepared-statement cache keyed only on "has a brand"
 * would hand the default-brand statement to another brand and silently leak
 * the legacy rows back in.
 *
 * @param {string|null|undefined} brandId
 * @returns {{ clause: string, cacheKeyPart: string, usesBrandParams: boolean }}
 */
function buildBrandFilter(brandId) {
    if (!brandId) {
        return { clause: '', cacheKeyPart: 'all', usesBrandParams: false };
    }
    if (brandId === DEFAULT_BRAND_ID) {
        return {
            clause: "AND (brand_id IS NULL OR brand_id = ? OR json_extract(data_json, '$.brand_id') = ?)",
            cacheKeyPart: 'default',
            usesBrandParams: true,
        };
    }
    return {
        clause: "AND (brand_id = ? OR json_extract(data_json, '$.brand_id') = ?)",
        cacheKeyPart: 'scoped',
        usesBrandParams: true,
    };
}

module.exports = { parseLocation, deriveSeverity, buildBrandFilter, DEFAULT_BRAND_ID };
