/** Run blocking better-sqlite3 heatmap work away from the HTTP event loop. */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { executeHeatmapQuery } = require('./heatmap-query');

const database = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
database.pragma('busy_timeout = 5000');

parentPort.on('message', ({ id, input }) => {
    try {
        const result = executeHeatmapQuery(database, input);
        parentPort.postMessage({ id, ok: true, result });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

process.once('exit', () => {
    try { database.close(); } catch { /* process is already exiting */ }
});
