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
  CONTADOR_MONTHLY_DAY,
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

function canRouteContadorEvent(event) {
  return Boolean(configured() && event?.direction === 'inbound' && event?.groupJid === config.groupConversationId);
}

function isQuotedContadorDraftReply(event) {
  return Boolean(
    canRouteContadorEvent(event)
    && event?.replyToContador
    && typeof event?.quotedContadorDraftId === 'string'
    && event.quotedContadorDraftId.trim()
  );
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

// The OpenClaw gateway spends most of a Contador call on session load and
// workspace injection, not on the model turn: measured 2026-08-18, successful
// calls land at ~130-140s wall while the model turn itself is ~3s. The previous
// 135s exec ceiling therefore killed roughly half the runs (the 2026-08-18
// monthly closing died at ~145s), so both ledgers burned retries on healthy
// work. Schedules run every 15 min and are not latency-sensitive; give the call
// room and keep the CLI timeout just under the exec kill so the CLI reports its
// own timeout instead of being SIGTERMed mid-write.
//
// The ceiling has to cover the DEGRADED path, not just the happy one: when the
// box is saturated (CI review agents peg all 4 cores), the CLI spends ~240s
// retrying the gateway, falls back to embedded transport and only then runs the
// model turn (~11s). Measured worst case 2026-08-18: 255s wall. 330s leaves
// real margin and still finishes well inside the 15-minute scheduler tick.
const AGENT_CLI_TIMEOUT_MS = 300_000;
const AGENT_EXEC_TIMEOUT_MS = 330_000;

function runAgent(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--agent', config.agent,
      '--session-id', config.sessionId,
      '--model', config.model,
      '--json',
      '--timeout', String(Math.floor(AGENT_CLI_TIMEOUT_MS / 1000)),
      '-m', prompt,
    ];
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.OPENCLAW_GATEWAY_URL;
    execFile(OPENCLAW_BIN, args, { timeout: AGENT_EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
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

function recordOutbound(text, event, externalMessageId, contadorJobId = null) {
  const now = nowIso();
  const messageId = randomId('msg');
  const metadata = event.contadorDraftId
    ? JSON.stringify({ contador: { kind: 'draft_prompt', draftId: event.contadorDraftId } })
    : null;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages
        (id, conversation_id, brand_id, direction, source, body, author_id, external_message_id, media_json, delivery_status, created_at)
      VALUES (?, ?, ?, 'outbound', 'contador', ?, NULL, ?, ?, 'sent', ?)
    `).run(messageId, event.conversationId, event.brandId, text, externalMessageId || null, metadata, now);
    db.prepare(`
      UPDATE conversations
      SET last_message_at = ?, last_outbound_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, now, event.conversationId);
    if (contadorJobId) {
      db.prepare(`
        UPDATE contador_jobs
        SET reply_status = 'sent', reply_external_message_id = ?, updated_at = ?
        WHERE id = ? AND reply_status = 'sending'
      `).run(externalMessageId || null, now, contadorJobId);
    }
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
  const contadorJobId = event.contadorJobId || null;
  if (contadorJobId) {
    const prior = db.prepare(`
      SELECT reply_status, reply_external_message_id FROM contador_jobs WHERE id = ?
    `).get(contadorJobId);
    if (prior?.reply_status === 'sent') {
      return { key: { id: prior.reply_external_message_id || null }, duplicate: true };
    }
    if (prior?.reply_status === 'sending' || prior?.reply_status === 'delivery_unknown') {
      const err = new Error('Contador reply delivery is ambiguous and requires operator reconciliation');
      err.retryable = false;
      err.deliveryUnknown = true;
      throw err;
    }
    const fenced = db.prepare(`
      UPDATE contador_jobs SET reply_status = 'sending', updated_at = ?
      WHERE id = ? AND reply_status IS NULL
    `).run(nowIso(), contadorJobId);
    if (!fenced.changes) throw new Error('Contador reply send fence could not be acquired');
  }

  let result;
  try {
    result = await sendText(instance, groupJid, text);
  } catch (err) {
    if (contadorJobId) {
      const definitive = isDefinitiveEvolutionRejection(err);
      db.prepare(`
        UPDATE contador_jobs
        SET reply_status = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND reply_status = 'sending'
      `).run(
        definitive ? null : 'delivery_unknown',
        String(err.message || err).slice(0, 500),
        nowIso(),
        contadorJobId
      );
      if (!definitive) {
        err.retryable = false;
        err.deliveryUnknown = true;
      }
    }
    throw err;
  }
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
    recordOutbound(text, resolvedEvent, result?.key?.id, contadorJobId);
  } else if (contadorJobId) {
    db.prepare(`
      UPDATE contador_jobs
      SET reply_status = 'sent', reply_external_message_id = ?, updated_at = ?
      WHERE id = ? AND reply_status = 'sending'
    `).run(result?.key?.id || null, nowIso(), contadorJobId);
  }
  return result;
}

let contador = buildContador({
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

function _setContadorForTest(value) {
  contador = value;
}

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

function monthlyRetryIso(attempts, now = new Date()) {
  const hours = [1, 4, 12, 24][Math.min(Math.max(Number(attempts || 1) - 1, 0), 3)];
  return new Date(now.getTime() + hours * 60 * 60_000).toISOString();
}

function isDefinitiveEvolutionRejection(err) {
  const statusCode = Number(err?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500;
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
        if (job.reply_status === 'sent') {
          db.prepare(`UPDATE contador_jobs SET status = 'completed', last_error = NULL, updated_at = ? WHERE id = ?`)
            .run(nowIso(), job.id);
          continue;
        }
        const result = await contador.handle({ ...JSON.parse(job.payload_json), contadorJobId: job.id });
        const status = result.status === 'blocked' ? 'blocked' : 'completed';
        db.prepare(`UPDATE contador_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
          .run(status, result.reason || null, nowIso(), job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        const deliveryUnknown = Boolean(err.deliveryUnknown)
          || db.prepare('SELECT reply_status FROM contador_jobs WHERE id = ?').get(job.id)?.reply_status === 'delivery_unknown';
        const retryable = !deliveryUnknown && err.retryable !== false && attempts < MAX_ATTEMPTS;
        db.prepare(`
          UPDATE contador_jobs
          SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(
          deliveryUnknown ? 'delivery_unknown' : (retryable ? 'retry' : 'failed'),
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

function monthlyScheduleReached(now, localDate = saoPauloDay(now)) {
  const localDay = Number(localDate.slice(-2));
  const localHour = saoPauloHour(now);
  return localDay > CONTADOR_MONTHLY_DAY
    || (localDay === CONTADOR_MONTHLY_DAY && localHour >= CONTADOR_HEARTBEAT_HOUR);
}

function shiftMonth(runMonth, amount) {
  const [year, month] = String(runMonth).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthlyRunDate(runMonth) {
  const [year, month] = String(runMonth).split('-').map(Number);
  // Sao Paulo has remained UTC-3 since 2019. This instant is the configured
  // local schedule and makes monthlySummary close the month before runMonth.
  return new Date(Date.UTC(year, month - 1, CONTADOR_MONTHLY_DAY, CONTADOR_HEARTBEAT_HOUR + 3));
}

function dueMonthlyRunMonths(now, localDate = saoPauloDay(now)) {
  const currentMonth = localDate.slice(0, 7);
  const scheduleReached = monthlyScheduleReached(now, localDate);
  const rows = db.prepare(`
    SELECT run_month, status, attempts, next_attempt_at FROM contador_monthly_runs ORDER BY run_month ASC
  `).all();
  if (!rows.length) {
    const seededAt = nowIso();
    db.prepare(`
      INSERT OR IGNORE INTO contador_monthly_runs (run_month, status, attempts, created_at, updated_at)
      VALUES (?, 'pending', 0, ?, ?)
    `).run(currentMonth, seededAt, seededAt);
    return scheduleReached ? [currentMonth] : [];
  }

  const dueThrough = scheduleReached ? currentMonth : shiftMonth(currentMonth, -1);
  const byMonth = new Map(rows.map((row) => [row.run_month, row]));
  const due = [];
  for (let runMonth = rows[0].run_month; runMonth <= dueThrough; runMonth = shiftMonth(runMonth, 1)) {
    const row = byMonth.get(runMonth);
    const retryAt = row?.next_attempt_at ? Date.parse(row.next_attempt_at) : NaN;
    const retryDue = !row?.next_attempt_at || !Number.isFinite(retryAt) || retryAt <= now.getTime();
    if (!row || row.status === 'pending') {
      due.push(runMonth);
      continue;
    }
    if (row.status === 'delivery_unknown') {
      break; // An operator must reconcile the ambiguous delivery before later closings proceed.
    }
    if (row.status === 'failed' && Number(row.attempts || 0) < MAX_ATTEMPTS) {
      if (retryDue) due.push(runMonth);
      else break; // Never overtake an older closing that is waiting for retry.
    }
  }
  return due;
}

function monthlySummaryOwnsHeartbeat(now, localDate) {
  if (dueMonthlyRunMonths(now, localDate).length > 0) return true;
  if (!monthlyScheduleReached(now, localDate)) return false;
  const runMonth = localDate.slice(0, 7);
  const row = db.prepare(`
    SELECT status, attempts, updated_at FROM contador_monthly_runs WHERE run_month = ?
  `).get(runMonth);
  if (!row) return true;
  if (row.status === 'failed') return Number(row.attempts || 0) < MAX_ATTEMPTS;
  if (row.status === 'processing') return true;
  if (!row.updated_at) return false;
  return saoPauloDay(new Date(row.updated_at)) === localDate;
}

let heartbeatBusy = false;
async function processHeartbeat(now = new Date()) {
  const localDate = saoPauloDay(now);
  if (
    !configured()
    || heartbeatBusy
    || saoPauloHour(now) !== CONTADOR_HEARTBEAT_HOUR
    || monthlySummaryOwnsHeartbeat(now, localDate)
  ) return;
  const runDate = localDate;
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

let monthlyBusy = false;
async function processMonthlySummary(now = new Date()) {
  const localDate = saoPauloDay(now);
  if (!configured() || monthlyBusy) return;
  const runMonths = dueMonthlyRunMonths(now, localDate);
  if (!runMonths.length) return;
  monthlyBusy = true;
  try {
    for (const runMonth of runMonths) {
      const created = nowIso();
      let claim = db.prepare(`
        INSERT OR IGNORE INTO contador_monthly_runs (run_month, status, attempts, created_at, updated_at)
        VALUES (?, 'processing', 1, ?, ?)
      `).run(runMonth, created, created);
      if (!claim.changes) {
        claim = db.prepare(`
          UPDATE contador_monthly_runs
          SET status = 'processing', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
          WHERE run_month = ?
            AND (
              (status = 'pending' AND attempts = 0)
              OR (status = 'failed' AND attempts < ? AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime(?)))
            )
        `).run(created, runMonth, MAX_ATTEMPTS, now.toISOString());
      }
      if (!claim.changes) continue;

      try {
        const result = await contador.monthlySummary(monthlyRunDate(runMonth), {
          beforeSend: async () => {
            const fenced = db.prepare(`
              UPDATE contador_monthly_runs
              SET status = 'sending', updated_at = ?
              WHERE run_month = ? AND status = 'processing'
            `).run(nowIso(), runMonth);
            if (!fenced.changes) throw new Error('monthly_send_fence_lost');
          },
        });
        const current = db.prepare('SELECT status FROM contador_monthly_runs WHERE run_month = ?').get(runMonth);
        if (result.status === 'sent' && current?.status !== 'sending') {
          throw new Error('monthly_send_was_not_fenced');
        }
        db.prepare(`UPDATE contador_monthly_runs SET status = ?, next_attempt_at = NULL, updated_at = ? WHERE run_month = ?`)
          .run(result.status === 'sent' ? 'sent' : 'silent', nowIso(), runMonth);
      } catch (err) {
        const attempt = db.prepare('SELECT status, attempts FROM contador_monthly_runs WHERE run_month = ?').get(runMonth);
        const deliveryUnknown = attempt?.status === 'sending' && !isDefinitiveEvolutionRejection(err);
        db.prepare(`UPDATE contador_monthly_runs SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE run_month = ?`)
          .run(
            deliveryUnknown ? 'delivery_unknown' : 'failed',
            deliveryUnknown ? null : monthlyRetryIso(attempt?.attempts, now),
            String(err.message || err).slice(0, 500),
            nowIso(),
            runMonth
          );
        console.warn(`${LOG_TAG} [contador] monthly summary ${runMonth} failed:`, err.message);
        break;
      }
    }
  } finally {
    monthlyBusy = false;
  }
}

function recoverInterruptedContadorWork(recoveredAt = nowIso()) {
  db.prepare(`
    UPDATE contador_jobs
    SET status = 'delivery_unknown', reply_status = 'delivery_unknown', next_attempt_at = NULL,
        last_error = 'interrupted_during_reply_send', updated_at = ?
    WHERE status = 'processing' AND reply_status = 'sending'
  `).run(recoveredAt);
  db.prepare(`
    UPDATE contador_jobs
    SET status = 'retry', next_attempt_at = ?, last_error = 'interrupted_process', updated_at = ?
    WHERE status = 'processing' AND (reply_status IS NULL OR reply_status = 'sent')
  `).run(recoveredAt, recoveredAt);
  db.prepare(`
    UPDATE contador_daily_runs
    SET status = 'failed', last_error = 'interrupted_process', updated_at = ?
    WHERE status = 'processing'
  `).run(recoveredAt);
  db.prepare(`
    UPDATE contador_monthly_runs
    SET status = 'failed', next_attempt_at = ?, last_error = 'interrupted_process', updated_at = ?
    WHERE status = 'processing'
  `).run(recoveredAt, recoveredAt);
  db.prepare(`
    UPDATE contador_monthly_runs
    SET status = 'delivery_unknown', next_attempt_at = NULL, last_error = 'interrupted_during_send', updated_at = ?
    WHERE status = 'sending'
  `).run(recoveredAt);
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
  recoverInterruptedContadorWork();
  runtimeStarted = true;
  console.log(`${LOG_TAG} [contador] runtime enabled for configured group; heartbeat hour=${CONTADOR_HEARTBEAT_HOUR}, monthly day=${CONTADOR_MONTHLY_DAY} America/Sao_Paulo`);
  processPendingJobs().catch((err) => console.warn(`${LOG_TAG} [contador] initial worker failed:`, err.message));
  processHeartbeat().catch((err) => console.warn(`${LOG_TAG} [contador] initial heartbeat failed:`, err.message));
  processMonthlySummary().catch((err) => console.warn(`${LOG_TAG} [contador] initial monthly summary failed:`, err.message));
  const workerTimer = setInterval(() => processPendingJobs().catch((err) => console.warn(`${LOG_TAG} [contador] worker failed:`, err.message)), WORKER_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    processHeartbeat().catch((err) => console.warn(`${LOG_TAG} [contador] heartbeat failed:`, err.message));
    processMonthlySummary().catch((err) => console.warn(`${LOG_TAG} [contador] monthly summary failed:`, err.message));
  }, HEARTBEAT_INTERVAL_MS);
  workerTimer.unref?.();
  heartbeatTimer.unref?.();
  return { started: true };
}

module.exports = {
  config,
  configured,
  canRouteContadorEvent,
  isQuotedContadorDraftReply,
  enqueueContadorMessage,
  processPendingJobs,
  processHeartbeat,
  processMonthlySummary,
  startContadorRuntime,
  resolveMediaPath,
  sendReply,
  _setContadorForTest,
  _recordOutboundForTest: recordOutbound,
  _recoverInterruptedContadorWorkForTest: recoverInterruptedContadorWork,
};
