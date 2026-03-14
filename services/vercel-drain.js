#!/usr/bin/env node
/**
 * Vercel Log Drain Webhook
 * 
 * Receives Vercel log drain HTTP POST requests (NDJSON payload),
 * filters out noise, and writes relevant logs to SQLite.
 * 
 * Usage:
 *   PORT=3001 DRAIN_SECRET=your-secret node vercel-drain.js
 * 
 * Vercel Dashboard Configuration:
 *   1. Go to: https://vercel.com/[team]/settings/log-drains
 *   2. Click "Add Log Drain"
 *   3. URL: https://your-domain.com/vercel-drain (or ngrok for testing)
 *   4. Sources: Select all or specific projects
 *   5. Secret: Set matching DRAIN_SECRET env var
 *   6. Save
 */

const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// Configuration
const PORT = process.env.PORT || 3001;
const DRAIN_SECRET = process.env.DRAIN_SECRET || '';
const TELEMETRY_API_KEY = process.env.TELEMETRY_API_KEY || 'f593c26c80894c8aef64a4c977f280d8ae687387b049f454';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '1700081a5b367b04b35758df55a42b72d3c9ba65';
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '1700081a5b367b04b35758df55a42b72d3c9ba65';
const DB_PATH = path.join(__dirname, '..', 'db', 'vercel.db');
const BATCH_SIZE = 100; // Batch DB writes for performance
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB max

// Stats tracking
let stats = {
  received: 0,
  filtered: 0,
  saved: 0,
  errors: 0,
  lastReset: Date.now()
};

// Initialize database
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL'); // Better concurrency
  console.log(`[vercel-drain] Database connected: ${DB_PATH}`);
} catch (err) {
  console.error('[vercel-drain] Failed to connect to database:', err.message);
  process.exit(1);
}

// --- Vercel logs: dedicated table (request logs) ---
// We keep the existing `logs` table for OCPP + mobile telemetry events.
// Vercel drain entries are better modeled as HTTP request logs.
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS vercel_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_id TEXT,
      log_type TEXT,
      endpoint TEXT,
      method TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      region TEXT,
      level TEXT,
      request_id TEXT,
      body TEXT,
      meta TEXT
    )
  `).run();

  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_logs_timestamp ON vercel_logs(timestamp)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_logs_endpoint_ts ON vercel_logs(endpoint, timestamp)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_logs_status_ts ON vercel_logs(status_code, timestamp)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_logs_request_id ON vercel_logs(request_id)').run();

  // Lightweight migrations for existing DBs (SQLite allows ADD COLUMN).
  const cols = db.prepare("PRAGMA table_info('vercel_logs')").all().map((r) => r.name);
  if (!cols.includes('event_id')) db.prepare('ALTER TABLE vercel_logs ADD COLUMN event_id TEXT').run();
  if (!cols.includes('log_type')) db.prepare('ALTER TABLE vercel_logs ADD COLUMN log_type TEXT').run();

  // Dedupe: some drains resend the same event. When event_id exists, keep it unique.
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_vercel_logs_event_id ON vercel_logs(event_id) WHERE event_id IS NOT NULL').run();

  console.log('[vercel-drain] vercel_logs table ready');

  // --- Vercel requests: normalized 1-row-per-request table ---
  // This table is derived from vercel_logs (stdout/stderr/proxy) and is optimized for dashboards/alerts.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS vercel_requests (
      request_id TEXT PRIMARY KEY,
      first_ts INTEGER,
      last_ts INTEGER,
      endpoint TEXT,
      method TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      region TEXT,
      warning_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0
    )
  `).run();

  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_requests_last_ts ON vercel_requests(last_ts)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_requests_endpoint_last_ts ON vercel_requests(endpoint, last_ts)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_vercel_requests_status_last_ts ON vercel_requests(status_code, last_ts)').run();

  console.log('[vercel-drain] vercel_requests table ready');
} catch (err) {
  console.error('[vercel-drain] Failed to init vercel_logs table:', err.message);
}

// Prepare insert statement for Vercel logs
const vercelInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO vercel_logs (
    timestamp, event_id, log_type, endpoint, method, status_code, duration_ms, region, level, request_id, body, meta
  ) VALUES (
    @timestamp, @event_id, @log_type, @endpoint, @method, @status_code, @duration_ms, @region, @level, @request_id, @body, @meta
  )
`);

// Upsert normalized request row (1 row per request_id)
const requestUpsertStmt = db.prepare(`
  INSERT INTO vercel_requests (
    request_id, first_ts, last_ts, endpoint, method, status_code, duration_ms, region, warning_count, error_count
  ) VALUES (
    @request_id, @timestamp, @timestamp, @endpoint, @method, @status_code, @duration_ms, @region, @warning_inc, @error_inc
  )
  ON CONFLICT(request_id) DO UPDATE SET
    last_ts = excluded.last_ts,
    endpoint = COALESCE(excluded.endpoint, vercel_requests.endpoint),
    method = COALESCE(excluded.method, vercel_requests.method),
    status_code = COALESCE(excluded.status_code, vercel_requests.status_code),
    duration_ms = COALESCE(excluded.duration_ms, vercel_requests.duration_ms),
    region = COALESCE(excluded.region, vercel_requests.region),
    warning_count = vercel_requests.warning_count + excluded.warning_count,
    error_count = vercel_requests.error_count + excluded.error_count
`);



function extractDurationMsFromBody(body) {
  if (!body) return null;
  // AWS lambda REPORT line: "Duration: 389 ms"
  const m = String(body).match(/Duration:\s*(\d+)\s*ms/i);
  return m ? Number(m[1]) : null;
}

function extractStatusCodeFromBody(body) {
  if (!body) return null;
  // Common app log: "status=200" or "status=500"
  const m = String(body).match(/status\s*=\s*(\d{3})/i);
  return m ? Number(m[1]) : null;
}

/**
 * Filter out noise from Vercel logs
 */
function shouldFilterOut(log) {
  // Extract status code from various possible locations
  const statusCode = log.statusCode || log.responseStatusCode || 
                     log.proxy?.statusCode || log.response?.statusCode;
  
  // 308 redirects (www → non-www)
  if (statusCode === 308) return true;
  
  // Favicon requests
  if (log.proxy?.userAgent === 'vercel-favicon/1.0') return true;
  
  // Extract path from various locations
  const requestPath = log.path || log.proxy?.path || log.requestPath;
  if (requestPath === '/favicon.ico') return true;
  
  // Health checks / monitoring pings
  if (requestPath === '/health' || requestPath === '/ping') return true;
  
  // UptimeRobot and other monitoring services
  const userAgent = log.proxy?.userAgent || log.requestUserAgent;
  if (userAgent?.includes('UptimeRobot')) return true;
  
  return false;
}

/**
 * Parse and normalize Vercel log entry
 * Vercel Log Drains send NDJSON with varying field structures
 * NOTE: Vercel sends arrays of log objects: [{...}] or sometimes just {...}
 */
function parseVercelLog(line) {
  try {
    const parsed = JSON.parse(line);

    // Vercel can send either a single log object or an array of log objects in one NDJSON line.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) return [];

    const normalized = [];
    for (const log of items) {
      // Filter out noise
      if (shouldFilterOut(log)) {
        stats.filtered++;
        continue;
      }

      // Extract timestamp - Vercel sends it in milliseconds
      const timestamp = log.timestamp || Date.now();

      // Extract endpoint/path from various possible locations
      const endpoint = log.proxy?.path || log.path || log.requestPath || null;

      // Extract HTTP method
      const method = log.method || log.proxy?.method || log.requestMethod || null;

      // Extract status code
      let status_code = log.statusCode || log.proxy?.statusCode || log.responseStatusCode || null;

      // Extract duration (ms)
      let duration_ms = log.proxy?.duration || log.duration || log.requestDuration || null;

      // Extract region
      const region = log.proxy?.region || log.region || log.executionRegion || null;

      // Extract log level
      const level = log.level || null;

      // Correlation
      const request_id = log.requestId || log.proxy?.requestId || null;

      // Event id (used for dedupe when present)
      const event_id = log.id || null;

      // Event type (stdout/stderr/etc.)
      const log_type = log.type || null;

      // Extract body/message
      const body = log.message || log.body || null;

      if (duration_ms == null) duration_ms = extractDurationMsFromBody(body);
      if (status_code == null) status_code = extractStatusCodeFromBody(body);

      // Store FULL raw object (not the whole array) in meta to keep rows small but lossless.
      const meta = JSON.stringify(log);

      normalized.push({
        timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime(),
        event_id,
        log_type,
        endpoint,
        method,
        status_code,
        duration_ms,
        region,
        level,
        request_id,
        body,
        meta
      });
    }

    return normalized;
  } catch (err) {
    console.error('[vercel-drain] Failed to parse log line:', err.message);
    console.error('[vercel-drain] Problem line:', line.substring(0, 200));
    stats.errors++;
    return [];
  }
}

/**
 * Batch insert logs into SQLite
 *//**
 * Batch insert logs into SQLite
 */
function insertLogs(logs) {
  if (logs.length === 0) return;
  
  try {
    const insert = db.transaction((logBatch) => {
      for (const log of logBatch) {
        vercelInsertStmt.run(log);

        if (log.request_id) {
          const level = (log.level || '').toLowerCase();
          const warning_inc = level === 'warning' ? 1 : 0;
          const error_inc = level === 'error' ? 1 : 0;
          requestUpsertStmt.run({
            request_id: log.request_id,
            timestamp: log.timestamp,
            endpoint: log.endpoint,
            method: log.method,
            status_code: log.status_code,
            duration_ms: log.duration_ms,
            region: log.region,
            warning_inc,
            error_inc
          });
        }
      }
    });
    
    insert(logs);
    stats.saved += logs.length;
  } catch (err) {
    console.error('[vercel-drain] Batch insert failed:', err.message);
    stats.errors++;
  }
}

/**
 * Verify request signature (if DRAIN_SECRET is set)
 * Vercel uses HMAC-SHA1 for drain signatures
 * https://vercel.com/docs/drains/security
 */
function verifySignature(body, signature) {
  if (!DRAIN_SECRET) return true; // No secret configured, skip verification
  if (!signature) return false;
  
  try {
    // Generate HMAC-SHA1 hash (Vercel standard for drains)
    const hmac = crypto.createHmac('sha1', DRAIN_SECRET);
    hmac.update(body);
    const expectedSignature = hmac.digest('hex');
    
    // Simple comparison (Vercel signature is already hex)
    return signature.toLowerCase() === expectedSignature.toLowerCase();
  } catch (err) {
    console.error('[vercel-drain] Signature verification error:', err.message);
    return false;
  }
}

/**
 * HTTP request handler
 */
function handleRequest(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  
  // Verify endpoint
  if (req.url !== '/vercel-drain' && req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  
  let body = '';
  let bodySize = 0;
  
  req.on('data', (chunk) => {
    bodySize += chunk.length;
    
    // Prevent DoS attacks
    if (bodySize > MAX_PAYLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.connection.destroy();
      return;
    }
    
    body += chunk.toString();
  });
  
  req.on('end', () => {
    try {
      // Verify signature if secret is configured
      const signature = req.headers['x-vercel-signature'];
      if (!verifySignature(body, signature)) {
        console.warn('[vercel-drain] Invalid signature from', req.socket.remoteAddress);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
      
      // Parse NDJSON payload
      const lines = body.trim().split('\n').filter(line => line.length > 0);
      stats.received += lines.length;
      
      // Parse and filter logs (flatten arrays)
      const parsedLogs = [];
      for (const line of lines) {
        const parsed = parseVercelLog(line);
        if (parsed && parsed.length) {
          parsedLogs.push(...parsed);
        }
      }
      
      // Batch insert into database
      if (parsedLogs.length > 0) {
        // Process in batches for better performance
        for (let i = 0; i < parsedLogs.length; i += BATCH_SIZE) {
          const batch = parsedLogs.slice(i, i + BATCH_SIZE);
          insertLogs(batch);
        }
      }
      
      // Log stats periodically
      const now = Date.now();
      if (now - stats.lastReset > 60000) { // Every minute
        console.log('[vercel-drain] Stats:', {
          received: stats.received,
          filtered: stats.filtered,
          saved: stats.saved,
          errors: stats.errors,
          filterRate: `${((stats.filtered / stats.received) * 100).toFixed(1)}%`
        });
        
        // Reset counters
        stats = {
          received: 0,
          filtered: 0,
          saved: 0,
          errors: 0,
          lastReset: now
        };
      }
      
      // Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        received: lines.length,
        saved: parsedLogs.length,
        filtered: lines.length - parsedLogs.length
      }));
      
    } catch (err) {
      console.error('[vercel-drain] Request handling error:', err.message);
      stats.errors++;
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
  
  req.on('error', (err) => {
    console.error('[vercel-drain] Request error:', err.message);
    stats.errors++;
  });
}

/**
 * Health check endpoint
 */
function handleHealthCheck(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      stats: {
        received: stats.received,
        filtered: stats.filtered,
        saved: stats.saved,
        errors: stats.errors
      }
    }));
    return true;
  }
  return false;
}

/**
 * NOTE: GitHub webhooks and Mobile Telemetry have been separated into their
 * own ingress processes (github-webhook on :3002, mobile-telemetry on :3003).
 * This vercel-drain process should only handle Vercel log drain + health.
 */

/**
 * GitHub Webhook handler
 * Receives PR comments, review comments, etc. and writes them to a file
 * for OpenClaw to pick up via cron/heartbeat
 */
/**
 * Main request router
 */
function requestHandler(req, res) {
  // Health check
  if (handleHealthCheck(req, res)) return;
  
  // Vercel log drain handler
  handleRequest(req, res);
}

// Create HTTP server
const server = http.createServer(requestHandler);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[vercel-drain] SIGTERM received, closing server...');
  server.close(() => {
    db.close();
    console.log('[vercel-drain] Server closed gracefully');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[vercel-drain] SIGINT received, closing server...');
  server.close(() => {
    db.close();
    console.log('[vercel-drain] Server closed gracefully');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`[vercel-drain] Server listening on port ${PORT}`);
  console.log(`[vercel-drain] Endpoint: http://localhost:${PORT}/vercel-drain`);
  console.log(`[vercel-drain] Health check: http://localhost:${PORT}/health`);
  console.log(`[vercel-drain] Signature verification: ${DRAIN_SECRET ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[vercel-drain] Database: ${DB_PATH}`);
});
