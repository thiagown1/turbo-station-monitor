/**
 * Authentication Middleware
 *
 * Validates the `X-Monitor-Secret` header for read-only dashboard endpoints.
 * Apply to any route that should only be accessible from the dashboard proxy.
 *
 * @module middleware/auth
 */

const crypto = require('crypto');
const { MONITOR_API_SECRET, TELEMETRY_API_KEY } = require('../lib/constants');

function safeEqual(provided, expected) {
    if (!provided || !expected) return false;
    const left = Buffer.from(String(provided));
    const right = Buffer.from(String(expected));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Express middleware — rejects the request with 401 if the shared secret
 * is missing or does not match.
 */
function requireSecret(req, res, next) {
    if (!safeEqual(req.headers['x-monitor-secret'], MONITOR_API_SECRET)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requireTelemetryKey(req, res, next) {
    if (!TELEMETRY_API_KEY && !MONITOR_API_SECRET) {
        return res.status(503).json({ error: 'Telemetry unavailable' });
    }
    const provided = req.headers['x-telemetry-key'];
    if (!safeEqual(provided, TELEMETRY_API_KEY) && !safeEqual(provided, MONITOR_API_SECRET)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = { requireSecret, requireTelemetryKey, safeEqual };
