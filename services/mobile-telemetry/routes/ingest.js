/**
 * Route: Event Ingestion
 *
 * Receives batches of telemetry events from the mobile app.
 * Supports gzip and deflate compressed bodies. Events are stored in a
 * transactional batch — raw payload in mobile_raw, normalised rows in
 * mobile_events.
 *
 * @route   POST /api/telemetry/mobile
 * @access  Public (auth temporarily disabled — see TODO below)
 *
 * @body    {{ session_id, device_id, app_version, platform, user_id?, events: Event[] }}
 * @returns {{ success: boolean, received: number, session_id: string }}
 */

const { Router } = require('express');
const zlib = require('zlib');
const { db, stmts } = require('../lib/db');
const { deriveSeverity } = require('../lib/utils');
const { MAX_PAYLOAD_BYTES, LOG_TAG } = require('../lib/constants');

const router = Router();

/**
 * Transactional batch-insert: raw payload + individual events.
 * Using a named transaction keeps the DB consistent and fast.
 */
const ingestBatch = db.transaction((payload, receivedAt) => {
    const {
        session_id: sessionId,
        device_id: deviceId,
        app_version: appVersion,
        platform,
        user_id: userId,
        events,
    } = payload;

    const rawId = stmts.insertRaw.run({
        received_at: receivedAt,
        session_id: sessionId,
        device_id: deviceId,
        app_version: appVersion,
        platform,
        user_id: userId || null,
        payload_json: JSON.stringify(payload),
    }).lastInsertRowid;

    for (const event of events) {
        const eventType = event.event_type || 'unknown';
        const data = event.data || {};

        stmts.insertEvent.run({
            raw_id: rawId,
            received_at: receivedAt,
            event_timestamp: event.timestamp || receivedAt,
            session_id: sessionId,
            device_id: deviceId,
            app_version: appVersion,
            platform,
            user_id: userId || null,
            event_type: eventType,
            station_id: data.station_id || data.stationId || null,
            severity: deriveSeverity(eventType),
            message: (data.message || JSON.stringify(data)).substring(0, 500),
            data_json: JSON.stringify(data),
        });
    }

    return events.length;
});

/**
 * Custom body reader that handles gzip/deflate and enforces size limits.
 * Express's built-in json() middleware doesn't support gzip from mobile.
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const encoding = (req.headers['content-encoding'] || '').toLowerCase();

        let stream = req;
        if (encoding === 'gzip' || encoding === 'x-gzip') {
            stream = req.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
            stream = req.pipe(zlib.createInflate());
        }

        const chunks = [];
        let size = 0;

        stream.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_PAYLOAD_BYTES) {
                req.destroy();
                reject(new Error('PAYLOAD_TOO_LARGE'));
                return;
            }
            chunks.push(chunk);
        });

        stream.on('error', (err) => reject(err));

        stream.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            // Strip UTF-8 BOM if present
            resolve(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        });
    });
}

router.post('/', async (req, res) => {
    // TODO: Re-enable auth once the next mobile build ships with
    //       TELEMETRY_API_KEY baked in via --dart-define.

    try {
        const body = await readBody(req);

        let payload;
        try {
            payload = JSON.parse(body);
        } catch (parseErr) {
            console.error(`${LOG_TAG} JSON parse failed: ${parseErr.message}`);
            console.error(`${LOG_TAG}   Content-Encoding: ${req.headers['content-encoding'] || '(none)'}`);
            console.error(`${LOG_TAG}   Body length: ${body.length}`);
            console.error(`${LOG_TAG}   Preview: ${JSON.stringify(body.substring(0, 200))}`);
            return res.status(400).json({ error: 'Invalid JSON body', detail: parseErr.message });
        }

        if (!Array.isArray(payload.events)) {
            return res.status(400).json({ error: 'Invalid payload: events array required' });
        }

        const receivedAt = Date.now();
        const count = ingestBatch(payload, receivedAt);

        console.log(`${LOG_TAG} Saved ${count} events from session ${payload.session_id}`);
        res.status(202).json({ success: true, received: count, session_id: payload.session_id });
    } catch (err) {
        if (err.message === 'PAYLOAD_TOO_LARGE') {
            return res.status(413).json({ error: 'Payload too large' });
        }
        console.error(`${LOG_TAG} Error processing request:`, err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
