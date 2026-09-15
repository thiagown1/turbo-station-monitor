/**
 * Tenant-scoped, time-bounded presence queries.
 *
 * SQLite otherwise prefers the low-cardinality event_type index and scans the
 * entire retained presence history. Online presence only needs the last 90s,
 * so force the existing timestamp index and filter the tiny recent slice.
 */
'use strict';

const { buildBrandFilter } = require('./utils');

const ONLINE_USERS_TIME_INDEX = 'idx_mobile_events_event_timestamp';
const preparedByDatabase = new WeakMap();

function buildOnlineUsersQuery({ cutoff, brandId }) {
    if (!Number.isFinite(cutoff)) {
        throw new Error('cutoff is required');
    }
    if (typeof brandId !== 'string' || brandId.length === 0) {
        throw new Error('brandId is required');
    }

    const { clause: brandClause, cacheKeyPart } = buildBrandFilter(brandId);
    return {
        sql: `
            SELECT device_id, user_id, data_json, MAX(event_timestamp) AS last_seen
            FROM mobile_events INDEXED BY ${ONLINE_USERS_TIME_INDEX}
            WHERE event_timestamp > ?
              AND event_type IN ('app_presence_start', 'app_presence_heartbeat')
              ${brandClause}
            GROUP BY device_id
            ORDER BY last_seen DESC
        `,
        params: [cutoff, brandId, brandId],
        cacheKey: cacheKeyPart,
    };
}

function executeOnlineUsersQuery(database, input) {
    const query = buildOnlineUsersQuery(input);
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
    return statement.all(...query.params);
}

module.exports = {
    ONLINE_USERS_TIME_INDEX,
    buildOnlineUsersQuery,
    executeOnlineUsersQuery,
};
