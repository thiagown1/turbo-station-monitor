/**
 * Route: Online Users (Presence)
 *
 * Returns the list of mobile app users who sent a presence heartbeat
 * within the last PRESENCE_WINDOW_MS. Used by the dashboard to show
 * live user dots on the map.
 *
 * @route   GET /api/telemetry/online-users
 * @access  Requires X-Monitor-Secret header (applied via middleware)
 *
 * @returns {{ count: number, users: OnlineUser[] }}
 *
 * @typedef {Object} OnlineUser
 * @property {string}      device_id  — unique device identifier
 * @property {string|null}  user_id    — Firebase UID (if logged in)
 * @property {number}       last_seen  — epoch ms of last heartbeat
 * @property {number|null}  lat        — GPS latitude
 * @property {number|null}  lng        — GPS longitude
 */

const { Router } = require('express');
const { stmts } = require('../lib/db');
const { parseLocation } = require('../lib/utils');
const { PRESENCE_WINDOW_MS, LOG_TAG } = require('../lib/constants');

const router = Router();

router.get('/', (req, res) => {
    try {
        const cutoff = Date.now() - PRESENCE_WINDOW_MS;

        // TODO: Filter by brandId once mobile app sends it in telemetry payload.
        const rows = stmts.onlineUsers.all(cutoff);

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
        console.error(`${LOG_TAG} Error fetching online users:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
