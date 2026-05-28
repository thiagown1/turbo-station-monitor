/**
 * Route: Events Query
 *
 * Returns normalised telemetry events from mobile_events filtered by a time
 * window and event types. Powers the Next.js dashboard deploy-monitor,
 * hourly-funnel, and event-health endpoints.
 *
 * @route   GET /api/telemetry/events
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @query   start_ms     epoch ms, inclusive lower bound (required)
 * @query   end_ms       epoch ms, exclusive upper bound (required, must be > start_ms)
 * @query   event_types  CSV of event_type values (required, at least 1)
 * @query   brand_id     optional tenant filter; when present, matches both the
 *                       envelope-level brand_id (column) and the per-event
 *                       data.brand_id (for legacy rows). Omit for cross-brand.
 * @query   limit        cap on rows returned (default 5000, max 20000)
 *
 * @returns {{ events: Event[], truncated: boolean }}
 *
 * @typedef {Object} Event
 * @property {number}      timestamp    — event_timestamp (epoch ms)
 * @property {string}      event_type
 * @property {string|null} user_id
 * @property {string|null} device_id
 * @property {string|null} app_version
 * @property {string|null} station_id
 * @property {string|null} brand_id
 * @property {Object}      data         — parsed data_json (empty object on parse failure)
 */

const { Router } = require('express');
const { db } = require('../lib/db');
const { LOG_TAG } = require('../lib/constants');

const router = Router();

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;

// Cache prepared statements keyed by (eventTypeCount, hasBrandFilter) — SQLite
// needs a fresh prepare per placeholder count. Capped to avoid unbounded growth.
const STMT_CACHE_LIMIT = 32;
const stmtCache = new Map();
function cacheStmt(key, build) {
    let stmt = stmtCache.get(key);
    if (stmt) return stmt;
    stmt = build();
    if (stmtCache.size >= STMT_CACHE_LIMIT) {
        const oldest = stmtCache.keys().next().value;
        stmtCache.delete(oldest);
    }
    stmtCache.set(key, stmt);
    return stmt;
}

function parseDataJson(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

router.get('/', (req, res) => {
    try {
        const startMs = Number(req.query.start_ms);
        const endMs = Number(req.query.end_ms);
        const eventTypesRaw = typeof req.query.event_types === 'string' ? req.query.event_types : '';
        const brandId = typeof req.query.brand_id === 'string' && req.query.brand_id.trim().length > 0
            ? req.query.brand_id.trim()
            : null;
        const limitRaw = Number(req.query.limit);

        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return res.status(400).json({ error: 'start_ms and end_ms are required (end_ms > start_ms)' });
        }

        const eventTypes = eventTypesRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (eventTypes.length === 0) {
            return res.status(400).json({ error: 'event_types is required (CSV of at least 1 type)' });
        }

        const limit = Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.min(MAX_LIMIT, Math.floor(limitRaw))
            : DEFAULT_LIMIT;

        // Build SQL with dynamic placeholders for IN clause.
        const placeholders = eventTypes.map(() => '?').join(',');
        // Brand filter — transition semantics:
        //   - Row's brand_id column matches → included
        //   - Row's data_json carries brand_id → included
        //   - Row has NEITHER (brand_id IS NULL and data_json lacks the key) →
        //     treated as legacy/unknown and ALSO included for any brand
        //     filter. This is intentional during the mobile-rollout window:
        //     until enough sessions ship with brand_id in the envelope
        //     (turbo-station PR #B), strict matching would zero out the
        //     dashboard. Once rollout completes, tighten to strict match.
        const brandClause = brandId
            ? "AND (brand_id IS NULL OR brand_id = ? OR json_extract(data_json, '$.brand_id') = ?)"
            : '';
        const cacheKey = `${eventTypes.length}:${brandId ? 1 : 0}`;
        const stmt = cacheStmt(cacheKey, () => db.prepare(`
            SELECT
                event_timestamp AS timestamp,
                event_type,
                user_id,
                device_id,
                app_version,
                station_id,
                brand_id,
                data_json
            FROM mobile_events
            WHERE event_timestamp >= ?
              AND event_timestamp < ?
              AND event_type IN (${placeholders})
              ${brandClause}
            ORDER BY event_timestamp DESC
            LIMIT ?
        `));

        const params = brandId
            ? [startMs, endMs, ...eventTypes, brandId, brandId, limit + 1]
            : [startMs, endMs, ...eventTypes, limit + 1];

        const rows = stmt.all(...params);
        const truncated = rows.length > limit;
        const trimmed = truncated ? rows.slice(0, limit) : rows;

        // The Next.js consumer (RawMobileFunnelEvent in hourly-funnel.ts) reads
        // app_version / station_id / brand_id / start_flow_id from inside `data`.
        // Our schema stores app_version / station_id / brand_id as top-level
        // columns (extracted at ingest from the envelope), so hoist them into
        // `data` here — column wins over data_json's copy since the column came
        // from the session envelope (one source of truth per session).
        const events = trimmed.map((row) => {
            const data = parseDataJson(row.data_json);
            if (row.app_version != null) data.app_version = row.app_version;
            if (row.station_id != null && data.station_id == null && data.stationId == null) {
                data.station_id = row.station_id;
            }
            if (row.brand_id != null && data.brand_id == null && data.brandId == null) {
                data.brand_id = row.brand_id;
            }
            return {
                timestamp: row.timestamp,
                event_type: row.event_type,
                user_id: row.user_id,
                device_id: row.device_id,
                // Keep top-level copies for callers that don't dig into data.
                app_version: row.app_version,
                station_id: row.station_id,
                brand_id: row.brand_id,
                data,
            };
        });

        res
            .set('Cache-Control', 'no-store')
            .json({ events, truncated });
    } catch (err) {
        console.error(`${LOG_TAG} Error fetching events:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
