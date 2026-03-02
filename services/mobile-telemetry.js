#!/usr/bin/env node
/**
 * Mobile Telemetry Ingress (separated from vercel-drain)
 *
 * Endpoint: /api/telemetry/mobile
 */

const http = require('http');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3003', 10);
const TELEMETRY_API_KEY =
  process.env.TELEMETRY_API_KEY || 'f593c26c80894c8aef64a4c977f280d8ae687387b049f454';

// NOTE: Mobile telemetry is intentionally stored in a dedicated DB to keep
// logs.db (station/infra logs) smaller and faster.
const DB_PATH = path.join(__dirname, '..', 'db', 'mobile.db');

const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  console.log(`[mobile-telemetry] Database connected: ${DB_PATH}`);
} catch (err) {
  console.error('[mobile-telemetry] Failed to connect to database:', err.message);
  process.exit(1);
}

function initSchema() {
  // Raw ingest: keeps the full payload for debugging/replay.
  // Normalized events: one row per event for querying.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at INTEGER NOT NULL,
      session_id TEXT,
      device_id TEXT,
      app_version TEXT,
      platform TEXT,
      user_id TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mobile_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_id INTEGER,
      received_at INTEGER NOT NULL,
      event_timestamp INTEGER,
      session_id TEXT,
      device_id TEXT,
      app_version TEXT,
      platform TEXT,
      user_id TEXT,
      event_type TEXT,
      station_id TEXT,
      severity TEXT,
      message TEXT,
      data_json TEXT,
      FOREIGN KEY(raw_id) REFERENCES mobile_raw(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_raw_received_at ON mobile_raw(received_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_raw_session_id ON mobile_raw(session_id);

    CREATE INDEX IF NOT EXISTS idx_mobile_events_received_at ON mobile_events(received_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_event_timestamp ON mobile_events(event_timestamp);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_session_id ON mobile_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_station_id ON mobile_events(station_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_events_event_type ON mobile_events(event_type);
  `);
}

try {
  initSchema();
  console.log('[mobile-telemetry] Schema ready (mobile_raw, mobile_events)');
} catch (err) {
  console.error('[mobile-telemetry] Failed to initialize schema:', err.message);
  process.exit(1);
}

function handleHealth(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return true;
  }
  return false;
}

function handleMobileTelemetry(req, res) {
  if (req.url !== '/api/telemetry/mobile') return false;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }

  // Validate API key
  const apiKey = req.headers['x-telemetry-key'];
  if (apiKey !== TELEMETRY_API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }

  // Determine if the body is compressed
  const contentEncoding = (req.headers['content-encoding'] || '').toLowerCase();
  let stream = req;
  if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
    stream = req.pipe(zlib.createGunzip());
  } else if (contentEncoding === 'deflate') {
    stream = req.pipe(zlib.createInflate());
  }

  const chunks = [];
  let bodySize = 0;

  stream.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_PAYLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  stream.on('error', (err) => {
    console.error('[mobile-telemetry] Stream/decompression error:', err.message);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
    }
  });

  stream.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf-8');

      // Strip UTF-8 BOM if present
      const cleanBody = body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body;

      let payload;
      try {
        payload = JSON.parse(cleanBody);
      } catch (parseErr) {
        // Diagnostic logging: show exactly what arrived
        const preview = cleanBody.substring(0, 200);
        const hexPreview = Buffer.from(cleanBody.substring(0, 50)).toString('hex');
        console.error(`[mobile-telemetry] JSON parse failed: ${parseErr.message}`);
        console.error(`[mobile-telemetry]   Content-Encoding: ${contentEncoding || '(none)'}`);
        console.error(`[mobile-telemetry]   Content-Type: ${req.headers['content-type'] || '(none)'}`);
        console.error(`[mobile-telemetry]   Body length: ${cleanBody.length}`);
        console.error(`[mobile-telemetry]   Body preview: ${JSON.stringify(preview)}`);
        console.error(`[mobile-telemetry]   Hex preview:  ${hexPreview}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body', detail: parseErr.message }));
        return;
      }

      if (!payload.events || !Array.isArray(payload.events)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid payload: events array required' }));
        return;
      }

      const receivedAt = Date.now();

      const events = payload.events;
      const sessionId = payload.session_id;
      const appVersion = payload.app_version;
      const platform = payload.platform;
      const deviceId = payload.device_id;
      const userId = payload.user_id || null;

      const insertRawStmt = db.prepare(`
        INSERT INTO mobile_raw (received_at, session_id, device_id, app_version, platform, user_id, payload_json)
        VALUES (@received_at, @session_id, @device_id, @app_version, @platform, @user_id, @payload_json)
      `);

      const insertEventStmt = db.prepare(`
        INSERT INTO mobile_events (
          raw_id,
          received_at,
          event_timestamp,
          session_id,
          device_id,
          app_version,
          platform,
          user_id,
          event_type,
          station_id,
          severity,
          message,
          data_json
        ) VALUES (
          @raw_id,
          @received_at,
          @event_timestamp,
          @session_id,
          @device_id,
          @app_version,
          @platform,
          @user_id,
          @event_type,
          @station_id,
          @severity,
          @message,
          @data_json
        )
      `);

      const ingest = db.transaction(() => {
        const rawResult = insertRawStmt.run({
          received_at: receivedAt,
          session_id: sessionId,
          device_id: deviceId,
          app_version: appVersion,
          platform,
          user_id: userId,
          payload_json: JSON.stringify(payload),
        });

        const rawId = rawResult.lastInsertRowid;

        for (const event of events) {
          const eventTimestamp = event.timestamp || receivedAt;
          const eventType = event.event_type || 'unknown';
          const data = event.data || {};

          const stationId = data.station_id || data.stationId || null;

          const severity =
            eventType === 'error' || eventType === 'transaction_error'
              ? 'error'
              : eventType === 'user_cancelled'
                ? 'warning'
                : 'info';

          const message = (data.message || JSON.stringify(data)).substring(0, 500);

          insertEventStmt.run({
            raw_id: rawId,
            received_at: receivedAt,
            event_timestamp: eventTimestamp,
            session_id: sessionId,
            device_id: deviceId,
            app_version: appVersion,
            platform,
            user_id: userId,
            event_type: eventType,
            station_id: stationId,
            severity,
            message,
            data_json: JSON.stringify(data),
          });
        }
      });

      ingest();

      console.log(`[mobile-telemetry] Saved ${events.length} events from session ${sessionId}`);

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, received: events.length, session_id: sessionId }));
    } catch (err) {
      console.error('[mobile-telemetry] Error processing request:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  req.on('error', (err) => {
    console.error('[mobile-telemetry] Request error:', err.message);
  });

  return true;
}

function requestHandler(req, res) {
  if (handleHealth(req, res)) return;
  if (handleMobileTelemetry(req, res)) return;

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(requestHandler);

process.on('SIGTERM', () => {
  console.log('[mobile-telemetry] SIGTERM received, closing server...');
  server.close(() => {
    db.close();
    console.log('[mobile-telemetry] Server closed gracefully');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`[mobile-telemetry] Server listening on port ${PORT}`);
  console.log(`[mobile-telemetry] Endpoint: http://localhost:${PORT}/api/telemetry/mobile`);
});
