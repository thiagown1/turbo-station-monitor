/**
 * Mobile Telemetry Service — Entry Point
 *
 * Express application that ingests telemetry events from the Turbo Station
 * mobile app and exposes read-only query endpoints for the dashboard.
 *
 * Architecture:
 *   lib/          — database, constants, utilities
 *   middleware/    — authentication
 *   routes/       — one file per endpoint group
 *
 * Routes:
 *   GET  /health | /ping                   → liveness probe
 *   GET  /api/telemetry/online-users       → currently active users
 *   GET  /api/telemetry/heatmap-data       → aggregated demand density
 *   POST /api/telemetry/mobile             → event ingestion
 */

const express = require('express');
const { PORT, LOG_TAG } = require('./lib/constants');
const { db } = require('./lib/db'); // ensure DB is initialised before routes

// ─── App Setup ──────────────────────────────────────────────────────────────────

const app = express();

// ─── Middleware ──────────────────────────────────────────────────────────────────

const { requireSecret } = require('./middleware/auth');

// ─── Routes ─────────────────────────────────────────────────────────────────────

// Public routes (no auth)
app.use('/', require('./routes/health'));

// Dashboard-facing routes (require shared secret)
app.use('/api/telemetry/online-users', requireSecret, require('./routes/online-users'));
app.use('/api/telemetry/heatmap-data', requireSecret, require('./routes/heatmap-data'));

// Mobile app ingestion (auth temporarily disabled — see routes/ingest.js)
app.use('/api/telemetry/mobile', require('./routes/ingest'));

// ─── 404 Fallback ───────────────────────────────────────────────────────────────

app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ─── Global Error Handler ───────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
    console.error(`${LOG_TAG} Unhandled error:`, err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Server (only when run directly, not when imported by tests) ────────────

if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`${LOG_TAG} Server listening on port ${PORT}`);
        console.log(`${LOG_TAG} Routes:`);
        console.log(`${LOG_TAG}   GET  /health`);
        console.log(`${LOG_TAG}   GET  /ping`);
        console.log(`${LOG_TAG}   GET  /api/telemetry/online-users`);
        console.log(`${LOG_TAG}   GET  /api/telemetry/heatmap-data`);
        console.log(`${LOG_TAG}   POST /api/telemetry/mobile`);
    });

    process.on('SIGTERM', () => {
        console.log(`${LOG_TAG} SIGTERM received, closing server...`);
        server.close(() => {
            db.close();
            console.log(`${LOG_TAG} Server closed gracefully`);
            process.exit(0);
        });
    });
}

module.exports = app;
