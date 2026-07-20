/**
 * Route: Health Check
 *
 * Simple liveness probe used by uptime monitors and PM2 health checks.
 *
 * @route GET /health
 * @route GET /ping
 */

const { Router } = require('express');

const router = Router();

// X-Service lets scripts/check-ports.js tell WHICH process owns this socket —
// github-webhook answers 'OK\n' too, so the body alone cannot identify us.
const ok = (_req, res) => res.set('X-Service', 'mobile-telemetry').send('OK\n');

router.get('/health', ok);
router.get('/ping', ok);

module.exports = router;
