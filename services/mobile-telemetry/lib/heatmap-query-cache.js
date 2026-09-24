/** Private in-process cache and single-flight gate for expensive heatmap reads. */
'use strict';

const DEFAULT_HEATMAP_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HEATMAP_CACHE_MAX_ENTRIES = 64;

function normaliseInput(input) {
    const excludeUserIds = Array.isArray(input.excludeUserIds)
        ? Array.from(new Set(input.excludeUserIds.filter((value) => typeof value === 'string' && value.length > 0))).sort()
        : [];
    return { ...input, excludeUserIds };
}

function buildHeatmapCacheKey(input) {
    const normalised = normaliseInput(input);
    return JSON.stringify([
        normalised.brandId,
        Number.isFinite(normalised.periodMs) ? normalised.periodMs : 'all',
        normalised.excludeUserIds,
    ]);
}

class HeatmapQueryCache {
    constructor({
        runner,
        ttlMs = DEFAULT_HEATMAP_CACHE_TTL_MS,
        maxEntries = DEFAULT_HEATMAP_CACHE_MAX_ENTRIES,
        now = Date.now,
    }) {
        if (!runner || typeof runner.run !== 'function') {
            throw new Error('runner with run() is required');
        }
        this.runner = runner;
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.now = now;
        this.cache = new Map();
        this.inflight = new Map();
    }

    pruneExpired(now) {
        for (const [key, entry] of this.cache) {
            if (entry.expiresAt <= now) this.cache.delete(key);
        }
    }

    store(key, result, now) {
        this.pruneExpired(now);
        while (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey === undefined) break;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, { result, expiresAt: now + this.ttlMs });
    }

    async run(input) {
        const normalised = normaliseInput(input);
        const key = buildHeatmapCacheKey(normalised);
        const now = this.now();
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > now) {
            return { result: cached.result, cacheStatus: 'HIT' };
        }
        if (cached) this.cache.delete(key);

        const active = this.inflight.get(key);
        if (active) {
            return { result: await active, cacheStatus: 'COALESCED' };
        }

        const work = Promise.resolve()
            .then(() => this.runner.run(normalised))
            .then((result) => {
                this.store(key, result, this.now());
                return result;
            })
            .finally(() => {
                this.inflight.delete(key);
            });
        this.inflight.set(key, work);
        return { result: await work, cacheStatus: 'MISS' };
    }

    clear() {
        this.cache.clear();
        this.inflight.clear();
    }
}

module.exports = {
    DEFAULT_HEATMAP_CACHE_TTL_MS,
    DEFAULT_HEATMAP_CACHE_MAX_ENTRIES,
    buildHeatmapCacheKey,
    HeatmapQueryCache,
};
