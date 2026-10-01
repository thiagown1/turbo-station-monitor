'use strict';

/**
 * Partner assistant, end to end, "as if it came from WhatsApp".
 *
 * Boots the REAL support-copilot process (index.js) against a throwaway SQLite
 * database and two loopback stubs:
 *   - a stub "central" that serves the Agent Center config for the scenarios,
 *     captures `propose_reply` / `record_interaction` and counts station
 *     investigator calls;
 *   - a stub Evolution gateway that counts (and never delivers) sends.
 * Each scenario is seeded (conversation + context messages), posted as an
 * Evolution webhook and observed until the partner assistant job settles.
 *
 * Safety: the child process gets an explicit environment (`buildChildEnv`), so
 * real Evolution credentials, the real central URL and every other secret in
 * the parent environment never reach it. `assertStubGateway` refuses to start
 * when the gateway is not the loopback stub. Hermes is whatever `hermesBin`
 * (or `HERMES_BIN`) points to: a fake in tests, the real CLI for the operator.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICE_DIR = path.join(__dirname, '..');
const BOT_JID = '66435376238593@lid';
const BRAND_ID = 'turbo_station';
const INSTANCE = 'turbostation';
const WEBHOOK_SECRET = 'sim-webhook-secret';
const AGENT_SECRET = 'sim-agent-secret';
const PARTNER_SECRET = 'sim-partner-secret';
const STUB_GATEWAY_KEY = 'sim-stub-gateway-key';
const SENDER_PARTICIPANT = '5500000000001@s.whatsapp.net';
const CONVERSATION_ID_RE = /^conv_[A-Za-z0-9]{6,64}$/;
const SETTLED_STATUSES = new Set(['review', 'sent', 'failed', 'retry']);

/** Variables a child needs only to run Node/Hermes; nothing that holds a credential. */
const PASSTHROUGH_ENV = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'LANG', 'LC_ALL',
  'HERMES_HOME',
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }

async function waitUntil(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`${what || 'condition'} not met within ${timeoutMs}ms`);
}

function jsonServer(handler) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON bodies are not used */ }
      handler(req, res, body);
    });
  });
}

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** A stable, obviously fake group JID for a conversation id. */
function defaultGroupJid(conversationId) {
  return `120363${conversationId.replace(/^conv_/, '').toLowerCase()}-sim@g.us`;
}

/** Validates and normalizes scenarios; throws a descriptive error for unusable ones. */
function normalizeScenarios(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('scenarios must be a non-empty array');
  const seen = new Set();
  const policyByConversation = new Map();
  const normalized = scenarios.map((raw, index) => {
    const where = `scenario #${index + 1}`;
    if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object`);
    if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error(`${where} needs an id`);
    if (seen.has(raw.id)) throw new Error(`duplicate scenario id: ${raw.id}`);
    seen.add(raw.id);
    if (!CONVERSATION_ID_RE.test(String(raw.conversationId || ''))) throw new Error(`${raw.id}: conversationId must look like conv_<alphanumeric>`);
    if (typeof raw.question !== 'string' || !raw.question.trim()) throw new Error(`${raw.id}: question is required`);
    const context = raw.context === undefined ? [] : raw.context;
    if (!Array.isArray(context)) throw new Error(`${raw.id}: context must be an array`);
    context.forEach((message, i) => {
      if (!message || typeof message.sender !== 'string' || typeof message.text !== 'string') {
        throw new Error(`${raw.id}: context[${i}] needs sender and text`);
      }
      if (message.at !== undefined && Number.isNaN(Date.parse(message.at))) throw new Error(`${raw.id}: context[${i}].at is not a date`);
    });
    const scenario = {
      id: raw.id,
      conversationId: raw.conversationId,
      groupJid: raw.groupJid || defaultGroupJid(raw.conversationId),
      question: raw.question,
      context,
      mention: raw.mention !== false,
      allowed: raw.allowed !== false,
      autoSend: raw.autoSend === true,
      sender: typeof raw.sender === 'string' && raw.sender.trim() ? raw.sender : 'Parceiro',
    };
    const known = policyByConversation.get(scenario.conversationId);
    if (known && (known.allowed !== scenario.allowed || known.groupJid !== scenario.groupJid)) {
      throw new Error(`${scenario.id}: conversation ${scenario.conversationId} is configured inconsistently across scenarios`);
    }
    policyByConversation.set(scenario.conversationId, { allowed: scenario.allowed, groupJid: scenario.groupJid });
    return scenario;
  });
  // The Agent Center switch is global to the group list, so one run has one mode.
  if (new Set(normalized.map((s) => s.autoSend)).size > 1) {
    throw new Error('all scenarios in one run must agree on autoSend (the Agent Center setting is global)');
  }
  return normalized;
}

/** The Agent Center config the stub central serves for these scenarios. */
function buildCentralConfig(scenarios) {
  const allowed = [...new Set(scenarios.filter((s) => s.allowed).map((s) => s.conversationId))];
  const autoSend = scenarios.some((s) => s.autoSend);
  return {
    enabled: true,
    agents: { stationSupport: true, accounting: false, partnerAssistant: true },
    accountingGroupConversationIds: [],
    stationInvestigator: {
      enabled: true, autoSend: false, killSwitch: false, allowedConversationIds: allowed,
      mentionJids: [BOT_JID], dailyLimit: 20, contextHours: 24, maxContextMessages: 40,
    },
    partnerAssistant: { autoSend, allowedConversationIds: allowed, mentionJids: [BOT_JID] },
  };
}

/**
 * Environment for the support-copilot child. Built from scratch on purpose: the
 * parent's EVOLUTION_*, AGENT_EVENT_*, PARTNER_AGENT_* and any other secret are
 * never forwarded, and the gateway is always the loopback stub.
 */
function buildChildEnv(parentEnv, { supportPort, centralPort, gatewayPort, dbPath, mediaDir, hermesBin }) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  Object.assign(env, {
    SUPPORT_COPILOT_PORT: String(supportPort),
    SUPPORT_COPILOT_DB_PATH: dbPath,
    SUPPORT_COPILOT_MEDIA_DIR: mediaDir,
    AGENT_EVENT_BASE_URL: `http://127.0.0.1:${centralPort}`,
    AGENT_EVENT_SECRET: AGENT_SECRET,
    PARTNER_AGENT_SECRET: PARTNER_SECRET,
    EVOLUTION_API_URL: `http://127.0.0.1:${gatewayPort}`,
    EVOLUTION_API_KEY: STUB_GATEWAY_KEY,
    EVOLUTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
    EVOLUTION_INSTANCE_MAP: `${INSTANCE}:${BRAND_ID}`,
    GROUP_AGENT: '',
  });
  if (hermesBin) env.HERMES_BIN = hermesBin;
  return env;
}

/** Throws unless the child's gateway is the loopback stub started by this simulator. */
function assertStubGateway(env, gatewayPort) {
  if (env.EVOLUTION_API_URL !== `http://127.0.0.1:${gatewayPort}` || env.EVOLUTION_API_KEY !== STUB_GATEWAY_KEY) {
    throw new Error('refusing_real_gateway: the simulator only runs against its own stub Evolution gateway');
  }
}

function webhookPayload(scenario, messageId) {
  const text = scenario.mention ? `@Turbo Station ${scenario.question}` : scenario.question;
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid: scenario.groupJid, fromMe: false, id: messageId, participant: SENDER_PARTICIPANT },
      pushName: scenario.sender,
      messageType: 'extendedTextMessage',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { extendedTextMessage: { text, contextInfo: scenario.mention ? { mentionedJid: [BOT_JID] } : {} } },
    },
  };
}

/**
 * Starts the simulator for a fixed list of scenarios (the Agent Center config is
 * cached by the service for a minute, so it is derived from the whole list up front).
 *
 * @param {object[]} rawScenarios `{ id, conversationId, groupJid?, question, context?, mention?, allowed?, autoSend?, sender? }`
 * @param {{ hermesBin?: string, timeoutMs?: number, settleMs?: number, parentEnv?: object }} [options]
 */
async function startSimulator(rawScenarios, options = {}) {
  const scenarios = normalizeScenarios(rawScenarios);
  const timeoutMs = options.timeoutMs || 30_000;
  const settleMs = options.settleMs ?? 300;
  const parentEnv = options.parentEnv || process.env;
  const runId = `${process.pid}-${Date.now()}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-whatsapp-sim-'));
  const dbPath = path.join(workDir, 'support-copilot.sqlite');
  const mediaDir = path.join(workDir, 'media');
  const config = buildCentralConfig(scenarios);
  const captured = { proposals: [], interactions: [], investigations: 0, gatewaySends: [], unexpected: [] };
  let sequence = 0;
  let child;
  let childOutput = '';
  let closed = false;
  const sentMessages = new Map();

  const central = jsonServer((req, res, body) => {
    if (req.method === 'GET' && req.url.startsWith('/api/agents/config?')) {
      if (req.headers.authorization !== `Bearer ${AGENT_SECRET}`) return reply(res, 401, { error: 'unauthorized' });
      return reply(res, 200, { config });
    }
    if (req.method === 'POST' && req.url === '/api/agents/partner-memory') {
      if (req.headers.authorization !== `Bearer ${PARTNER_SECRET}`) return reply(res, 401, { error: 'unauthorized' });
      if (body?.action === 'propose_reply') {
        captured.proposals.push(body);
        return reply(res, 200, { ok: true, reviewId: `review-sim-${captured.proposals.length}`, duplicate: false });
      }
      if (body?.action === 'record_interaction') {
        captured.interactions.push(body);
        return reply(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && req.url === '/api/agents/station-investigations') {
      captured.investigations += 1;
      return reply(res, 200, { decision: 'review', confidence: 'low', stationIds: [], reply: null, reasons: [] });
    }
    captured.unexpected.push(`${req.method} ${req.url}`);
    return reply(res, 404, { error: 'not_found' });
  });
  const gateway = jsonServer((req, res, body) => {
    if (req.url.startsWith('/message/sendText/')) {
      captured.gatewaySends.push({ to: body?.number || null, text: body?.text || '' });
      return reply(res, 200, { key: { id: `sim-sent-${captured.gatewaySends.length}` } });
    }
    return reply(res, 200, req.url.startsWith('/group/') ? { subject: 'Grupo simulado' } : {});
  });

  function withDb(fn, readonly = false) {
    const Database = require('better-sqlite3');
    const conn = new Database(dbPath, readonly ? { readonly: true } : undefined);
    try { return fn(conn); } finally { conn.close(); }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (child && child.exitCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }
    await Promise.all([closeServer(central), closeServer(gateway)]);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may still hold the file briefly */ }
  }

  let supportPort;
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    const [centralPort, gatewayPort] = await Promise.all([listen(central), listen(gateway)]);
    const probe = http.createServer();
    supportPort = await listen(probe);
    await closeServer(probe);

    const env = buildChildEnv(parentEnv, {
      supportPort, centralPort, gatewayPort, dbPath, mediaDir, hermesBin: options.hermesBin || parentEnv.HERMES_BIN,
    });
    assertStubGateway(env, gatewayPort);
    child = spawn(process.execPath, ['index.js'], { cwd: SERVICE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    await waitUntil(async () => {
      try { return (await fetch(`http://127.0.0.1:${supportPort}/health`)).ok; } catch { return false; }
    }, timeoutMs, 'support-copilot health');
  } catch (error) {
    await close();
    throw error;
  }

  const post = (payload) => fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
    body: JSON.stringify(payload),
  });

  /** Fresh conversation state: a scenario never sees another scenario's messages. */
  function seed(scenario) {
    const now = new Date();
    withDb((conn) => {
      conn.prepare('DELETE FROM messages WHERE conversation_id = ?').run(scenario.conversationId);
      conn.prepare(`INSERT OR IGNORE INTO conversations (id, brand_id, channel, external_conversation_id, customer_phone, customer_name, status, created_at, updated_at)
        VALUES (?, ?, 'whatsapp-group', ?, ?, 'Grupo simulado', 'open', ?, ?)`)
        .run(scenario.conversationId, BRAND_ID, scenario.groupJid, scenario.groupJid, now.toISOString(), now.toISOString());
      const insert = conn.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, external_message_id, sender_name, created_at)
        VALUES (?, ?, ?, ?, 'evolution', ?, ?, ?, ?)`);
      scenario.context.forEach((message, index) => {
        const at = message.at ? new Date(message.at) : new Date(now.getTime() - (scenario.context.length - index) * 60_000);
        const outbound = message.sender === 'Turbo Station';
        insert.run(`sim-ctx-${runId}-${scenario.id}-${index}`, scenario.conversationId, BRAND_ID, outbound ? 'outbound' : 'inbound',
          `[${message.sender}]: ${message.text}`, `sim-ctx-${runId}-${scenario.id}-${index}`, message.sender, at.toISOString());
      });
    });
  }

  function jobFor(messageId) {
    return withDb((conn) => conn.prepare('SELECT status, review_id, last_error, response_external_message_id FROM partner_assistant_jobs WHERE message_id = ?').get(messageId), true);
  }

  async function run(input) {
    const scenario = scenarios.find((s) => s.id === (typeof input === 'string' ? input : input?.id));
    if (!scenario) throw new Error(`unknown scenario: ${typeof input === 'string' ? input : input?.id}`);
    sequence += 1;
    const messageId = `wamid-sim-${runId}-${sequence}`;
    seed(scenario);
    const sendsBefore = captured.gatewaySends.length;
    const investigationsBefore = captured.investigations;
    const response = await post(webhookPayload(scenario, messageId));
    if (response.status !== 201) throw new Error(`${scenario.id}: webhook answered HTTP ${response.status}`);
    const claimed = (await response.json()).partnerAssistant === true;
    sentMessages.set(scenario.id, { scenario, messageId, claimed });

    let job = null;
    if (claimed) {
      job = await waitUntil(() => {
        const row = jobFor(messageId);
        return row && SETTLED_STATUSES.has(row.status) ? row : null;
      }, timeoutMs, `${scenario.id}: partner assistant job`);
      if (job.status === 'sent') {
        // The job settles before the interaction is posted; give the (best-effort) record a moment.
        await waitUntil(() => captured.interactions.some((i) => i.interaction?.sourceMessageId === messageId), 2_000, 'interaction record').catch(() => null);
      }
    } else {
      await sleep(settleMs); // give a wrongly-routed pipeline time to show itself
    }

    const proposal = captured.proposals.find((p) => p.reply?.sourceMessageId === messageId);
    const interaction = captured.interactions.find((p) => p.interaction?.sourceMessageId === messageId);
    const delivery = proposal?.reply || interaction?.interaction || null;
    const sends = captured.gatewaySends.slice(sendsBefore);
    return {
      id: scenario.id,
      claimed,
      answer: delivery ? delivery.answer : null,
      tools: delivery ? delivery.tools || [] : [],
      reviewId: job?.review_id || null,
      sentToGroup: sends.length > 0,
      status: job ? job.status : null,
      error: job?.last_error || null,
      messageId,
      investigatorCalls: captured.investigations - investigationsBefore,
    };
  }

  async function runAll() {
    const results = [];
    for (const scenario of scenarios) results.push(await run(scenario.id));
    return results;
  }

  /** Posts the same provider message again (a webhook retry). Resolves to the HTTP status and the ingest flags. */
  async function replay(scenarioId) {
    const sent = sentMessages.get(scenarioId);
    if (!sent) throw new Error(`scenario ${scenarioId} has not run yet`);
    const response = await post(webhookPayload(sent.scenario, sent.messageId));
    const body = await response.json().catch(() => ({}));
    await sleep(settleMs + 200);
    return { status: response.status, duplicate: body.duplicate === true, partnerAssistant: body.partnerAssistant === true };
  }

  return {
    run, runAll, replay, close,
    captured,
    scenarios,
    jobFor,
    output: () => childOutput,
    gatewayUrl: () => gateway.address() && `http://127.0.0.1:${gateway.address().port}`,
  };
}

/** One-shot: start, run every scenario, always shut down. */
async function runScenarios(scenarios, options = {}) {
  const sim = await startSimulator(scenarios, options);
  try {
    return await sim.runAll();
  } catch (error) {
    error.childOutput = sim.output().slice(-3000);
    throw error;
  } finally {
    await sim.close();
  }
}

module.exports = {
  BOT_JID,
  assertStubGateway,
  buildCentralConfig,
  buildChildEnv,
  defaultGroupJid,
  normalizeScenarios,
  runScenarios,
  startSimulator,
};
