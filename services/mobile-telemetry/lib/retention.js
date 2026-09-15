/**
 * Bounded TTL sweeps for mobile telemetry. Events are deleted before their raw
 * parent rows because mobile_events.raw_id references mobile_raw(id).
 */
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const {
    DB_PATH,
    LOG_TAG,
    MOBILE_TTL_DAYS,
    RETENTION_SWEEP_INTERVAL_MS,
} = require('./constants');
const { assertRetentionIndexes } = require('./retention-index');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 5000;

function defaultDatabase() {
    return require('./db').db;
}

async function deleteOlderThan(table, cutoff, database = defaultDatabase()) {
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

async function sweep({
    database = defaultDatabase(),
    now = Date.now(),
    log = console,
    validate = assertRetentionIndexes,
} = {}) {
    const cutoff = now - MOBILE_TTL_DAYS * MS_PER_DAY;
    try {
        validate(database);
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

class RetentionWorkerRunner {
    constructor({
        workerPath = path.join(__dirname, 'retention-worker.js'),
        workerData = {},
        dbPath = DB_PATH,
        timeoutMs = 30 * 60 * 1000,
    } = {}) {
        this.workerPath = workerPath;
        this.workerData = workerData;
        this.dbPath = dbPath;
        this.timeoutMs = timeoutMs;
        this.active = null;
    }

    run({ now = Date.now() } = {}) {
        if (this.active) return this.active.promise;
        const worker = new Worker(this.workerPath, {
            workerData: { ...this.workerData, dbPath: this.dbPath, now },
        });
        let timeout;
        const promise = new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                clearTimeout(timeout);
                this.active = null;
                callback(value);
            };
            worker.once('message', (message) => {
                if (message?.ok) finish(resolve, message.result);
                else {
                    const error = new Error(message?.error?.message || 'retention worker failed');
                    error.code = message?.error?.code || 'ERETENTIONWORKER';
                    finish(reject, error);
                }
            });
            worker.once('error', (error) => finish(reject, error));
            worker.once('exit', (code) => {
                if (this.active) finish(reject, new Error(`retention worker exited before returning a result (code ${code})`));
            });
            timeout = setTimeout(() => {
                worker.terminate();
                const error = new Error(`retention worker timed out after ${this.timeoutMs}ms`);
                error.code = 'ERETENTIONTIMEOUT';
                finish(reject, error);
            }, this.timeoutMs);
            timeout.unref?.();
        });
        this.active = { worker, promise };
        return promise;
    }

    close() {
        if (this.active) this.active.worker.terminate();
        this.active = null;
    }
}

const retentionStatus = {
    state: 'idle',
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
};

function getRetentionStatus() {
    return { ...retentionStatus };
}

function startRetentionSweeps({
    runner = new RetentionWorkerRunner(),
    initialDelayMs = 30_000,
    intervalMs = RETENTION_SWEEP_INTERVAL_MS,
    log = console,
} = {}) {
    console.log(`${LOG_TAG} Retention: mobile_events + mobile_raw kept ${MOBILE_TTL_DAYS}d`);
    let closed = false;
    let timer = null;

    const schedule = (delay) => {
        timer = setTimeout(run, delay);
        timer.unref?.();
    };
    const run = async () => {
        if (closed) return;
        retentionStatus.state = 'running';
        retentionStatus.lastStartedAt = new Date().toISOString();
        retentionStatus.lastError = null;
        try {
            const result = await runner.run();
            retentionStatus.state = 'ok';
            retentionStatus.lastCompletedAt = new Date().toISOString();
            log.log(`${LOG_TAG} TTL worker completed: ${result.events} mobile_events + ${result.raw} mobile_raw deleted`);
        } catch (error) {
            retentionStatus.state = error.code === 'ERETENTIONINDEX' ? 'blocked-index' : 'error';
            retentionStatus.lastCompletedAt = new Date().toISOString();
            retentionStatus.lastError = error.message;
            log.error(`${LOG_TAG} TTL worker ${retentionStatus.state}: ${error.message}`);
        } finally {
            if (!closed) schedule(intervalMs);
        }
    };

    schedule(initialDelayMs);
    return {
        runNow: run,
        close() {
            closed = true;
            clearTimeout(timer);
            runner.close();
        },
    };
}

module.exports = {
    startRetentionSweeps,
    getRetentionStatus,
    RetentionWorkerRunner,
    sweep,
    deleteOlderThan,
    CHUNK_SIZE,
};
