/**
 * Route: Heatmap Data
 *
 * Returns aggregated user presence locations for visualising demand density
 * on the dashboard map. Points are deduplicated per (device, 5-minute bucket)
 * to prevent inflation from continuous heartbeats at the same spot.
 *
 * @route   GET /api/telemetry/heatmap-data?period=7d
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @query   {string} period — time window: '24h' | '7d' | '30d' | 'all'
 * @returns {{ count: number, period: string, points: { lat: number, lng: number }[] }}
 */

const { Router } = require('express');
const { stmts } = require('../lib/db');
const { parseLocation } = require('../lib/utils');
const { PERIOD_MS, LOG_TAG } = require('../lib/constants');

const router = Router();

router.get('/', (req, res) => {
    try {
        const period = req.query.period || '7d';
        const periodMs = PERIOD_MS[period];

        // Use the pre-built filtered or unfiltered query
        const rows = periodMs
            ? stmts.heatmapWithTime.all(Date.now() - periodMs)
            : stmts.heatmapAll.all();

        const points = [];
        let totalEvents = 0;
        for (const row of rows) {
            const { lat, lng } = parseLocation(row.data_json);
            if (lat != null && lng != null) {
                const w = row.weight || 1;
                points.push({ lat, lng, weight: w });
                totalEvents += w;
            }
        }

        res.set('Cache-Control', 'max-age=60').json({ count: points.length, totalEvents, period, points });
    } catch (err) {
        console.error(`${LOG_TAG} Error fetching heatmap data:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
