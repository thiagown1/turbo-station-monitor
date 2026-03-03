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

router.get('/health', (_req, res) => res.send('OK\n'));
router.get('/ping', (_req, res) => res.send('OK\n'));

module.exports = router;
