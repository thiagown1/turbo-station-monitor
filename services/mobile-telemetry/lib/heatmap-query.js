/**
 * Tenant-scoped heatmap query executed inside a worker thread.
 *
 * The production mobile_events table is large. SQLite previously chose the
 * event_type index, scanned the full presence history, and blocked the main
 * better-sqlite3 event loop for more than a minute. Force the existing time
 * index so bounded periods only visit recent rows.
 */
'use strict';

const { buildBrandFilter } = require('./utils');

const HEATMAP_TIME_INDEX = 'idx_mobile_events_event_timestamp';
const preparedByDatabase = new WeakMap();

function normaliseExcludedUsers(excludeUserIds) {
    if (!Array.isArray(excludeUserIds)) return [];
    return excludeUserIds.filter((userId) => typeof userId === 'string' && userId.length > 0);
}

function buildHeatmapQuery({ periodMs, brandId, excludeUserIds = [], now = Date.now() }) {
    if (typeof brandId !== 'string' || brandId.length === 0) {
        throw new Error('brandId is required');
    }

    const hasTime = Number.isFinite(periodMs) && periodMs > 0;
    const excluded = normaliseExcludedUsers(excludeUserIds);
    const { clause: brandClause, cacheKeyPart } = buildBrandFilter(brandId);
    const excludeClause = excluded.length > 0
        ? `AND (user_id IS NULL OR user_id NOT IN (${excluded.map(() => '?').join(',')}))`
        : '';
    const sql = `
        SELECT data_json, 1 AS weight
        FROM mobile_events INDEXED BY ${HEATMAP_TIME_INDEX}
        WHERE event_type IN ('app_presence_start', 'app_presence_heartbeat')
          AND data_json IS NOT NULL
          ${hasTime ? 'AND event_timestamp > ?' : ''}
          ${brandClause}
          ${excludeClause}
        GROUP BY device_id, (event_timestamp / 300000)
        ORDER BY (event_timestamp / 300000) DESC
    `;
    const params = [];
    if (hasTime) params.push(now - periodMs);
    params.push(brandId, brandId, ...excluded);

    return {
        sql,
        params,
        cacheKey: `${hasTime ? 'bounded' : 'all'}:${cacheKeyPart}:${excluded.length}`,
    };
}

function getPreparedStatement(database, query) {
    let cache = preparedByDatabase.get(database);
    if (!cache) {
        cache = new Map();
        preparedByDatabase.set(database, cache);
    }
    let statement = cache.get(query.cacheKey);
    if (!statement) {
        statement = database.prepare(query.sql);
        cache.set(query.cacheKey, statement);
    }
    return statement;
}

function executeHeatmapQuery(database, input) {
    const query = buildHeatmapQuery(input);
    const rows = getPreparedStatement(database, query).all(...query.params);
    const points = [];
    let totalEvents = 0;

    for (const row of rows) {
        let data;
        try {
            data = JSON.parse(row.data_json || '{}');
        } catch {
            continue;
        }
        const lat = data.lat;
        const lng = data.lng;
        if (lat == null || lng == null) continue;

        const weight = row.weight || 1;
        points.push({ lat, lng, weight });
        totalEvents += weight;
    }

    return { count: points.length, totalEvents, points };
}

module.exports = {
    HEATMAP_TIME_INDEX,
    buildHeatmapQuery,
    executeHeatmapQuery,
};
