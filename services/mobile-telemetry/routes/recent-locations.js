/**
 * Route: Recent Locations
 *
 * Returns each device's most recent presence location within a bounded
 * lookback window — the caller (Next.js geographic push-notification
 * targeting) decides the recency direction (recently active vs. lapsed)
 * itself over the returned `last_seen`, the same way it already does for
 * the Firestore-backed `lastLoginAt` narrowing on the charging-history
 * audience. Distinct from `online-users`, which is hard-bounded to
 * PRESENCE_WINDOW_MS ("online right now") and must keep that contract for
 * its live-map consumer.
 *
 * The window is ALWAYS capped at RECENT_LOCATIONS_MAX_WINDOW_MS (90 days),
 * regardless of what the caller requests — this endpoint returns raw
 * per-user lat/lng behind a single shared secret (no per-caller auth), so
 * the cap bounds what a leaked secret could expose to "recent activity"
 * rather than a permanent location history.
 *
 * @route   GET /api/telemetry/recent-locations?maxAgeMs=2592000000
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @query   {number} maxAgeMs — lookback window in ms. Optional; defaults to
 *          and is clamped at RECENT_LOCATIONS_MAX_WINDOW_MS.
 * @returns {{ count: number, windowMs: number, users: RecentLocation[] }}
 *
 * @typedef {Object} RecentLocation
 * @property {string}       device_id  — unique device identifier
 * @property {string|null}  user_id    — Firebase UID (if logged in)
 * @property {number}       last_seen  — epoch ms of the device's latest presence event
 * @property {number|null}  lat        — GPS latitude
 * @property {number|null}  lng        — GPS longitude
 */

const { Router } = require('express');
const { stmts } = require('../lib/db');
const { parseLocation } = require('../lib/utils');
const { RECENT_LOCATIONS_MAX_WINDOW_MS, LOG_TAG } = require('../lib/constants');

const router = Router();

router.get('/', (req, res) => {
    try {
        const requested = Number(req.query.maxAgeMs);
        const windowMs = Number.isFinite(requested) && requested > 0
            ? Math.min(requested, RECENT_LOCATIONS_MAX_WINDOW_MS)
            : RECENT_LOCATIONS_MAX_WINDOW_MS;

        const cutoff = Date.now() - windowMs;
        const rows = stmts.recentLocations.all(cutoff);

        const users = rows.map((row) => {
            const { lat, lng } = parseLocation(row.data_json);
            return {
                device_id: row.device_id,
                user_id: row.user_id,
                last_seen: row.last_seen,
                lat,
                lng,
            };
        });

        res.set('Cache-Control', 'no-store').json({ count: users.length, windowMs, users });
    } catch (err) {
        console.error(`${LOG_TAG} Error fetching recent locations:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
