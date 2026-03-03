/**
 * Authentication Middleware
 *
 * Validates the `X-Monitor-Secret` header for read-only dashboard endpoints.
 * Apply to any route that should only be accessible from the dashboard proxy.
 *
 * @module middleware/auth
 */

const { MONITOR_API_SECRET } = require('../lib/constants');

/**
 * Express middleware — rejects the request with 401 if the shared secret
 * is missing or does not match.
 */
function requireSecret(req, res, next) {
    if (!MONITOR_API_SECRET || req.headers['x-monitor-secret'] !== MONITOR_API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = { requireSecret };
