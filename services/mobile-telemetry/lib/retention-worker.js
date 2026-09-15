'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { sweep } = require('./retention');

async function main() {
    const database = new Database(workerData.dbPath);
    try {
        database.pragma('journal_mode = WAL');
        database.pragma('busy_timeout = 5000');
        database.pragma('foreign_keys = ON');
        const result = await sweep({ database, now: workerData.now });
        if (result.error) {
            parentPort.postMessage({
                ok: false,
                error: { message: result.error.message, code: result.error.code || 'ERETENTION' },
            });
            return;
        }
        parentPort.postMessage({ ok: true, result });
    } finally {
        database.close();
    }
}

main().catch((error) => {
    parentPort.postMessage({
        ok: false,
        error: { message: error.message, code: error.code || 'ERETENTIONWORKER' },
    });
});
