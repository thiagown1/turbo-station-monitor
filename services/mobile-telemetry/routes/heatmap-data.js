/**
 * Route: Heatmap Data
 *
 * Returns aggregated user presence locations for visualising demand density
 * on the dashboard map. Points are deduplicated per (device, 5-minute bucket)
 * to prevent inflation from continuous heartbeats at the same spot.
 *
 * @route   GET /api/telemetry/heatmap-data?period=7d&brandId=turbo_station&excludeUserIds=uid1,uid2
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @query   {string} period — time window: '24h' | '7d' | '30d' | 'all'
 * @query   {string} brandId — required tenant scope injected by the Next proxy
 * @query   {string} excludeUserIds — comma-separated list of user_ids whose
 *          events should be filtered out (e.g. admins/internal users whose
 *          home/office activity would skew demand suggestions). Optional.
 * @returns {{ count: number, period: string, points: { lat: number, lng: number }[] }}
 */

const { Router } = require('express');
const { PERIOD_MS, LOG_TAG } = require('../lib/constants');
const {
    HEATMAP_QUERY_TIMEOUT_CODE,
    heatmapQueryRunner,
} = require('../lib/heatmap-query-runner');

const router = Router();

// Cap to keep SQL size + prepared-statement cache bounded. Brands with more
// admins than this fall back to truncated exclusion — acceptable since this
// is heatmap noise reduction, not a security boundary.
const MAX_EXCLUDE_USER_IDS = 200;

router.get('/', async (req, res) => {
    try {
        const period = req.query.period || '7d';
        if (period !== 'all' && !Object.hasOwn(PERIOD_MS, period)) {
            return res.status(400).json({ error: 'period must be one of: 24h, 7d, 30d, all' });
        }

        const rawBrandId = typeof req.query.brandId === 'string'
            ? req.query.brandId
            : req.query.brand_id;
        const brandId = typeof rawBrandId === 'string' ? rawBrandId.trim() : '';
        if (!brandId) {
            return res.status(400).json({ error: 'brandId is required' });
        }
        if (brandId.length > 128) {
            return res.status(400).json({ error: 'brandId is too long' });
        }

        const periodMs = period === 'all' ? null : PERIOD_MS[period];

        const rawExclude = typeof req.query.excludeUserIds === 'string' ? req.query.excludeUserIds : '';
        const excludeUserIds = rawExclude
            ? rawExclude
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0 && s.length <= 128)
                  .slice(0, MAX_EXCLUDE_USER_IDS)
            : [];

        const result = await heatmapQueryRunner.run({ periodMs, brandId, excludeUserIds });

        res.set('Cache-Control', 'max-age=60').json({ period, ...result });
    } catch (err) {
        console.error(`${LOG_TAG} Error fetching heatmap data:`, err.message);
        if (err && err.code === HEATMAP_QUERY_TIMEOUT_CODE) {
            return res
                .set('Retry-After', '5')
                .status(504)
                .json({ error: 'Heatmap query timed out' });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
