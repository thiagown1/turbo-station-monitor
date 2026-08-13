'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { buildContador, classifyInbound } = require('./contador');
const { db, nowIso, randomId } = require('./db');
const { sendText } = require('./evolution-client');
const { emitEvent } = require('./sse');
const {
  MEDIA_DIR,
  LOG_TAG,
  CONTADOR_ENABLED,
  CONTADOR_GROUP_CONVERSATION_ID,
  CONTADOR_NEXT_BASE_URL,
  CONTADOR_NEXT_SECRET,
  CONTADOR_INSTANCE,
  CONTADOR_OPENCLAW_AGENT,
  CONTADOR_OPENCLAW_MODEL,
  CONTADOR_SESSION_ID,
  CONTADOR_HEARTBEAT_HOUR,
} = require('./constants');

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/openclaw/.npm-global/bin/openclaw';
const WORKER_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
let runtimeStarted = false;

const config = {
  enabled: CONTADOR_ENABLED,
  groupConversationId: CONTADOR_GROUP_CONVERSATION_ID,
  nextBaseUrl: CONTADOR_NEXT_BASE_URL,
  secret: CONTADOR_NEXT_SECRET,
  instance: CONTADOR_INSTANCE,
  agent: CONTADOR_OPENCLAW_AGENT,
  model: CONTADOR_OPENCLAW_MODEL,
  sessionId: CONTADOR_SESSION_ID,
  maxToolCalls: 5,
};

function configured() {
  return Boolean(config.enabled && config.groupConversationId && config.nextBaseUrl && config.secret);
}

async function postNext(route, body) {
  if (!configured()) throw new Error('Contador is enabled but required configuration is incomplete');
  const response = await fetch(`${config.nextBaseUrl}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(`Next ${route} failed with HTTP ${response.status}`);
    err.statusCode = response.status;
    err.retryable = response.status >= 500 || response.status === 429;
    throw err;
  }
  return data;
}

function extractAgentText(result) {
  return String(
    result?.result?.payloads?.[0]?.text ||
    result?.payloads?.[0]?.text ||
    result?.text ||
    ''
  ).trim();
}

function runAgent(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--agent', config.agent,
      '--session-id', config.sessionId,
      '--model', config.model,
      '--json',
      '--timeout', '120',
      '-m', prompt,
    ];
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.OPENCLAW_GATEWAY_URL;
    execFile(OPENCLAW_BIN, args, { timeout: 135_000, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`OpenClaw Contador failed: ${error.message}${stderr ? ` | ${String(stderr).slice(0, 180)}` : ''}`));
      try {
        const text = extractAgentText(JSON.parse(stdout));
        if (!text) throw new Error('empty response');
        resolve(text);
      } catch (err) {
        reject(new Error(`OpenClaw Contador returned invalid JSON: ${err.message}`));
      }
    });
  });
}

function resolveMediaPath(media) {
  const rawUrl = String(media?.url || '');
  const filename = path.basename(rawUrl);
  if (!filename || filename === '.' || filename === path.sep) throw new Error('Contador media file is missing');
  const resolved = path.resolve(MEDIA_DIR, filename);
  if (!resolved.startsWith(`${MEDIA_DIR}${path.sep}`)) throw new Error('Contador media path escaped the media directory');
  return resolved;
}

async function readMedia(media) {
  return fs.promises.readFile(resolveMediaPath(media));
}

function loadContext(conversationId, limit = 30) {
  if (!conversationId) return [];
  return db.prepare(`
    SELECT direction, body, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `).all(conversationId, Math.min(30, Math.max(1, limit))).reverse();
}

function recordOutbound(text, event, externalMessageId) {
  const now = nowIso();
  const messageId = randomId('msg');
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages
        (id, conversation_id, brand_id, direction, source, body, author_id, external_message_id, delivery_status, created_at)
      VALUES (?, ?, ?, 'outbound', 'contador', ?, NULL, ?, 'sent', ?)
    `).run(messageId, event.conversationId, event.brandId, text, externalMessageId || null, now);
    db.prepare(`
      UPDATE conversations
      SET last_message_at = ?, last_outbound_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, now, event.conversationId);
  })();
  emitEvent({
    type: 'message',
    conversationId: event.conversationId,
    brandId: event.brandId,
    direction: 'outbound',
    channel: 'whatsapp-group',
    message: {
      id: messageId,
      conversation_id: event.conversationId,
      brand_id: event.brandId,
      direction: 'outbound',
      source: 'contador',
      body: text,
      external_message_id: externalMessageId || null,
      delivery_status: 'sent',
      created_at: now,
    },
  });
}

async function sendReply(text, event) {
  const groupJid = event.groupJid || config.groupConversationId;
  const instance = event.instance || config.instance;
  const result = await sendText(instance, groupJid, text);
  let resolvedEvent = event;
  if (!event.conversationId || !event.brandId) {
    const conversation = db.prepare(`
      SELECT id, brand_id FROM conversations
      WHERE channel = 'whatsapp-group' AND customer_phone = ?
      ORDER BY datetime(updated_at) DESC LIMIT 1
    `).get(groupJid);
    if (conversation) resolvedEvent = { ...event, conversationId: conversation.id, brandId: conversation.brand_id };
  }
  if (resolvedEvent.conversationId && resolvedEvent.brandId) {
    recordOutbound(text, resolvedEvent, result?.key?.id);
  }
  return result;
}

const contador = buildContador({
  config,
  readMedia,
  intake: (payload) => postNext('/api/accounting/energy-bill-intake', payload),
  queryTool: async (tool, params) => {
    const response = await postNext('/api/accounting/energy-agent/query', { tool, params });
    if (!response || response.data == null) throw new Error(`Next query ${tool} returned no data`);
    return response.data;
  },
  sendReply,
  runAgent,
  loadContext,
});

function enqueueContadorMessage(event) {
  if (!configured()) return { kind: 'ignored', reason: config.enabled ? 'incomplete_config' : 'disabled' };
  const classification = classifyInbound(event, config);
  if (classification.kind === 'ignored') return classification;

  const now = nowIso();
  const payload = { ...event, kind: classification.kind, instance: event.instance || config.instance };
  const result = db.prepare(`
    INSERT OR IGNORE INTO contador_jobs
      (id, message_id, conversation_id, brand_id, group_jid, instance, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    randomId('contador_job'), event.messageId, event.conversationId, event.brandId,
    event.groupJid, payload.instance, classification.kind, JSON.stringify(payload), now, now, now
  );
  if (result.changes === 1 && runtimeStarted) {
    setImmediate(() => processPendingJobs().catch((err) => {
      console.warn(`${LOG_TAG} [contador] immediate worker failed:`, err.message);
    }));
  }
  return { ...classification, enqueued: result.changes === 1 };
}

function nextRetryIso(attempts) {
  const minutes = [1, 5, 15, 30, 60][Math.min(attempts, 4)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

let workerBusy = false;
async function processPendingJobs() {
  if (!configured() || workerBusy) return;
  workerBusy = true;
  try {
    const jobs = db.prepare(`
      SELECT * FROM contador_jobs
      WHERE status IN ('pending', 'retry')
        AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
      ORDER BY datetime(created_at) ASC
      LIMIT 5
    `).all();

    for (const job of jobs) {
      const claimed = db.prepare(`
        UPDATE contador_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry')
      `).run(nowIso(), job.id);
      if (!claimed.changes) continue;
      try {
        const result = await contador.handle(JSON.parse(job.payload_json));
        const status = result.status === 'blocked' ? 'blocked' : 'completed';
        db.prepare(`UPDATE contador_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
          .run(status, result.reason || null, nowIso(), job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        const retryable = err.retryable !== false && attempts < MAX_ATTEMPTS;
        db.prepare(`
          UPDATE contador_jobs
          SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(
          retryable ? 'retry' : 'failed',
          retryable ? nextRetryIso(attempts - 1) : null,
          String(err.message || err).slice(0, 500), nowIso(), job.id
        );
        console.warn(`${LOG_TAG} [contador] job ${job.id} failed (attempt ${attempts}):`, err.message);
      }
    }
  } finally {
    workerBusy = false;
  }
}

function saoPauloDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function saoPauloHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23',
  }).format(now));
}

let heartbeatBusy = false;
async function processHeartbeat(now = new Date()) {
  if (!configured() || heartbeatBusy || saoPauloHour(now) !== CONTADOR_HEARTBEAT_HOUR) return;
  const runDate = saoPauloDay(now);
  const created = nowIso();
  let claim = db.prepare(`
    INSERT OR IGNORE INTO contador_daily_runs (run_date, status, attempts, created_at, updated_at)
    VALUES (?, 'processing', 1, ?, ?)
  `).run(runDate, created, created);
  if (!claim.changes) {
    claim = db.prepare(`
      UPDATE contador_daily_runs
      SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE run_date = ? AND status = 'failed' AND attempts < ?
    `).run(created, runDate, MAX_ATTEMPTS);
  }
  if (!claim.changes) return;

  heartbeatBusy = true;
  try {
    const result = await contador.heartbeat(now);
    db.prepare(`UPDATE contador_daily_runs SET status = ?, updated_at = ? WHERE run_date = ?`)
      .run(result.status === 'sent' ? 'sent' : 'silent', nowIso(), runDate);
  } catch (err) {
    db.prepare(`UPDATE contador_daily_runs SET status = 'failed', last_error = ?, updated_at = ? WHERE run_date = ?`)
      .run(String(err.message || err).slice(0, 500), nowIso(), runDate);
    console.warn(`${LOG_TAG} [contador] heartbeat ${runDate} failed:`, err.message);
  } finally {
    heartbeatBusy = false;
  }
}

function startContadorRuntime() {
  if (!config.enabled) {
    console.log(`${LOG_TAG} [contador] disabled (CONTADOR_ENABLED is not true)`);
    return { started: false, reason: 'disabled' };
  }
  if (!configured()) {
    console.warn(`${LOG_TAG} [contador] fail-closed: missing group, Next URL or secret`);
    return { started: false, reason: 'incomplete_config' };
  }
  const recoveredAt = nowIso();
  db.prepare(`
    UPDATE contador_jobs
    SET status = 'retry', next_attempt_at = ?, last_error = 'interrupted_process', updated_at = ?
    WHERE status = 'processing'
  `).run(recoveredAt, recoveredAt);
  db.prepare(`
    UPDATE contador_daily_runs
    SET status = 'failed', last_error = 'interrupted_process', updated_at = ?
    WHERE status = 'processing'
  `).run(recoveredAt);
  runtimeStarted = true;
  console.log(`${LOG_TAG} [contador] runtime enabled for configured group; heartbeat hour=${CONTADOR_HEARTBEAT_HOUR} America/Sao_Paulo`);
  processPendingJobs().catch((err) => console.warn(`${LOG_TAG} [contador] initial worker failed:`, err.message));
  processHeartbeat().catch((err) => console.warn(`${LOG_TAG} [contador] initial heartbeat failed:`, err.message));
  const workerTimer = setInterval(() => processPendingJobs().catch((err) => console.warn(`${LOG_TAG} [contador] worker failed:`, err.message)), WORKER_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => processHeartbeat().catch((err) => console.warn(`${LOG_TAG} [contador] heartbeat failed:`, err.message)), HEARTBEAT_INTERVAL_MS);
  workerTimer.unref?.();
  heartbeatTimer.unref?.();
  return { started: true };
}

module.exports = {
  config,
  configured,
  enqueueContadorMessage,
  processPendingJobs,
  processHeartbeat,
  startContadorRuntime,
  resolveMediaPath,
};
