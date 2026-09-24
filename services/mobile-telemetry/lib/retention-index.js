'use strict';

const RAW_ID_INDEX = 'idx_mobile_events_raw_id';

function rawIdIndexes(database) {
    return database.prepare("PRAGMA index_list('mobile_events')").all()
        .filter((index) => {
            const columns = database.prepare(`PRAGMA index_info('${String(index.name).replace(/'/g, "''")}')`).all();
            return columns[0]?.name === 'raw_id';
        });
}

function hasRawIdIndex(database) {
    return rawIdIndexes(database).length > 0;
}

function assertRetentionIndexes(database) {
    if (hasRawIdIndex(database)) return;
    const error = new Error(
        `retention blocked: mobile_events.raw_id needs an index; run scripts/migrate-mobile-raw-id-index.js before enabling TTL deletes`
    );
    error.code = 'ERETENTIONINDEX';
    throw error;
}

module.exports = { RAW_ID_INDEX, hasRawIdIndex, assertRetentionIndexes };
