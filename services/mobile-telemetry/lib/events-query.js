/** Build bounded event queries without letting SQLite scan every matching type. */
'use strict';

const { buildBrandFilter } = require('./utils');

const EVENTS_TIME_INDEX = 'idx_mobile_events_event_timestamp';

function buildEventsQuery({ eventTypeCount, brandId }) {
    if (!Number.isInteger(eventTypeCount) || eventTypeCount < 1) {
        throw new Error('eventTypeCount must be a positive integer');
    }

    const placeholders = Array.from({ length: eventTypeCount }, () => '?').join(',');
    const { clause: brandClause, cacheKeyPart } = buildBrandFilter(brandId);
    return {
        sql: `
            SELECT
                event_timestamp AS timestamp,
                event_type,
                user_id,
                device_id,
                app_version,
                station_id,
                brand_id,
                data_json
            FROM mobile_events INDEXED BY ${EVENTS_TIME_INDEX}
            WHERE event_timestamp >= ?
              AND event_timestamp < ?
              AND event_type IN (${placeholders})
              ${brandClause}
            ORDER BY event_timestamp DESC
            LIMIT ?
        `,
        cacheKey: `${eventTypeCount}:${cacheKeyPart}`,
    };
}

module.exports = { EVENTS_TIME_INDEX, buildEventsQuery };
