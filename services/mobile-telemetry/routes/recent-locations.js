/**
 * Route: Recent Locations
 *
 * Returns each device's most recent presence location, with no time
 * window applied — the caller (Next.js geographic push-notification
 * targeting) decides the recency cutoff and direction (recently active
 * vs. lapsed) itself, the same way it already does for the Firestore-backed
 * `lastLoginAt` narrowing on the charging-history audience. Distinct from
 * `online-users`, which is hard-bounded to PRESENCE_WINDOW_MS ("online
 * right now") and must keep that contract for its live-map consumer.
 *
 * @route   GET /api/telemetry/recent-locations
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @returns {{ count: number, users: RecentLocation[] }}
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
const { LOG_TAG } = require('../lib/constants');

const router = Router();

router.get('/', (req, res) => {
    try {
        const rows = stmts.recentLocations.all();

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

        res.set('Cache-Control', 'no-store').json({ count: users.length, users });
    } catch (err) {
        console.error(`${LOG_TAG} Error fetching recent locations:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
