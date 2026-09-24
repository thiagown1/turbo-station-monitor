'use strict';

const { parentPort, workerData } = require('worker_threads');

const until = Date.now() + workerData.delayMs;
while (Date.now() < until) {
    // Deliberately occupy this worker's JS thread. The service thread must stay responsive.
}

parentPort.postMessage({ ok: true, result: { events: 2, raw: 1 } });
