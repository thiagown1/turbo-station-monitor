/**
 * Lifecycle and deadline management for the heatmap SQLite worker.
 */
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { DB_PATH } = require('./constants');

const DEFAULT_TIMEOUT_MS = 25_000;
const HEATMAP_QUERY_TIMEOUT_CODE = 'HEATMAP_QUERY_TIMEOUT';

class HeatmapQueryRunner {
    constructor({
        workerPath = path.join(__dirname, 'heatmap-query-worker.js'),
        workerData = { dbPath: DB_PATH },
        timeoutMs = DEFAULT_TIMEOUT_MS,
        WorkerClass = Worker,
    } = {}) {
        this.workerPath = workerPath;
        this.workerData = workerData;
        this.timeoutMs = timeoutMs;
        this.WorkerClass = WorkerClass;
        this.worker = null;
        this.pending = new Map();
        this.nextId = 1;
    }

    ensureWorker() {
        if (this.worker) return this.worker;

        const worker = new this.WorkerClass(this.workerPath, { workerData: this.workerData });
        this.worker = worker;
        worker.unref?.();
        worker.on('message', (message) => this.handleMessage(worker, message));
        worker.on('error', (error) => this.failWorker(worker, error));
        worker.on('exit', (code) => {
            if (this.worker !== worker) return;
            const error = new Error(`Heatmap worker exited with code ${code}`);
            error.code = 'HEATMAP_WORKER_EXIT';
            this.failWorker(worker, error);
        });
        return worker;
    }

    handleMessage(worker, message) {
        if (this.worker !== worker) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);

        if (message.ok) {
            pending.resolve(message.result);
            return;
        }
        const error = new Error(message.error || 'Heatmap query failed');
        error.code = 'HEATMAP_QUERY_FAILED';
        pending.reject(error);
    }

    failWorker(worker, error) {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        const termination = worker.terminate?.();
        if (termination && typeof termination.catch === 'function') {
            termination.catch(() => {});
        }
    }

    run(input) {
        const worker = this.ensureWorker();
        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error(`Heatmap query exceeded ${this.timeoutMs}ms`);
                error.code = HEATMAP_QUERY_TIMEOUT_CODE;
                this.failWorker(worker, error);
            }, this.timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            try {
                worker.postMessage({ id, input });
            } catch (error) {
                this.failWorker(worker, error);
            }
        });
    }

    close() {
        if (!this.worker) return;
        const error = new Error('Heatmap query runner closed');
        error.code = 'HEATMAP_RUNNER_CLOSED';
        this.failWorker(this.worker, error);
    }
}

const heatmapQueryRunner = new HeatmapQueryRunner();

module.exports = {
    DEFAULT_TIMEOUT_MS,
    HEATMAP_QUERY_TIMEOUT_CODE,
    HeatmapQueryRunner,
    heatmapQueryRunner,
};
