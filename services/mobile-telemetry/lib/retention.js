/**
 * Bounded TTL sweeps for mobile telemetry. Events are deleted before their raw
 * parent rows because mobile_events.raw_id references mobile_raw(id).
 */
'use strict';

const { db } = require('./db');
const { LOG_TAG, MOBILE_TTL_DAYS, RETENTION_SWEEP_INTERVAL_MS } = require('./constants');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 5000;

async function deleteOlderThan(table, cutoff, database = db) {
    if (!['mobile_events', 'mobile_raw'].includes(table)) throw new Error(`unsupported retention table: ${table}`);
    const stmt = database.prepare(
        `DELETE FROM ${table} WHERE rowid IN ` +
        `(SELECT rowid FROM ${table} WHERE received_at < ? LIMIT ${CHUNK_SIZE})`
    );
    let total = 0;
    for (;;) {
        const { changes } = stmt.run(cutoff);
        total += changes;
        if (changes < CHUNK_SIZE) break;
        await new Promise((resolve) => setImmediate(resolve));
    }
    return total;
}

async function sweep({ database = db, now = Date.now(), log = console } = {}) {
    const cutoff = now - MOBILE_TTL_DAYS * MS_PER_DAY;
    try {
        const events = await deleteOlderThan('mobile_events', cutoff, database);
        const raw = await deleteOlderThan('mobile_raw', cutoff, database);
        if (events > 0 || raw > 0) {
            log.log(`${LOG_TAG} TTL: deleted ${events} mobile_events + ${raw} mobile_raw rows older than ${MOBILE_TTL_DAYS}d`);
        }
        return { events, raw };
    } catch (error) {
        log.error(`${LOG_TAG} TTL sweep error:`, error.message);
        return { events: 0, raw: 0, error };
    }
}

function startRetentionSweeps() {
    console.log(`${LOG_TAG} Retention: mobile_events + mobile_raw kept ${MOBILE_TTL_DAYS}d`);
    const timer = setInterval(() => { sweep().catch(() => {}); }, RETENTION_SWEEP_INTERVAL_MS);
    timer.unref?.();
    sweep().catch(() => {});
    return timer;
}

module.exports = { startRetentionSweeps, sweep, deleteOlderThan, CHUNK_SIZE };
