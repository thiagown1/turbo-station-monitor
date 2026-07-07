/**
 * Auth Middleware — Support Copilot
 */
const { SUPPORT_API_SECRET, LOG_TAG } = require('../lib/constants');

function requireSecret(req, res, next) {
  if (!SUPPORT_API_SECRET) return next(); // no secret configured = open (dev)

  const header = req.headers['x-api-secret']
    || req.headers['x-monitor-secret']
    || req.headers['x-webhook-secret']
    || req.headers['authorization']?.replace('Bearer ', '');
  if (header === SUPPORT_API_SECRET) return next();

  console.warn(`${LOG_TAG} Auth failed from ${req.ip}`);
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireSecret };
