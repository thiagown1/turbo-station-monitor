'use strict';

const { parentPort, workerData } = require('worker_threads');

parentPort.on('message', ({ id }) => {
    const until = Date.now() + workerData.delayMs;
    while (Date.now() < until) {
        // Deliberately block this worker to prove the HTTP/main thread stays free.
    }
    parentPort.postMessage({ id, ok: true, result: { finished: true } });
});
