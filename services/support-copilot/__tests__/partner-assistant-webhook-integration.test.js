#!/usr/bin/env node
'use strict';

/**
 * End-to-end through the real support-copilot process: a WhatsApp group message
 * that mentions the support number reaches the partner assistant (fake Hermes
 * binary), which proposes the answer to the central for human review. The
 * station investigator, also allowlisted for the group, must not answer, and
 * nothing is sent to the group in shadow mode.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICE_DIR = path.join(__dirname, '..');
const GROUP_JID = '120363-arena-partner@g.us';
const CONVERSATION_ID = 'conv_arenapartner01';
const BOT_JID = '66435376238593@lid';
const RUN = `${process.pid}-${Date.now()}`;
const DB_PATH = path.join(os.tmpdir(), `partner-assistant-webhook-${RUN}.sqlite`);
const MEDIA_DIR = path.join(os.tmpdir(), `partner-assistant-media-${RUN}`);
const FAKE_HERMES = path.join(os.tmpdir(), `fake-hermes-${RUN}.js`);
const WEBHOOK_SECRET = 'partner-assistant-webhook-secret';
const AGENT_SECRET = 'partner-assistant-agent-secret';
const PARTNER_SECRET = 'partner-assistant-partner-secret';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
async function waitUntil(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
function jsonServer(handler) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : null));
  });
}
function webhook(messageId, mentioned) {
  return {
    event: 'messages.upsert',
    instance: 'turbostation',
    data: {
      key: { remoteJid: GROUP_JID, fromMe: false, id: messageId, participant: '5561999999999@s.whatsapp.net' },
      pushName: 'Leonardo',
      messageType: 'extendedTextMessage',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { extendedTextMessage: { text: '@Turbo Station o Fornassa caiu?', contextInfo: mentioned ? { mentionedJid: [BOT_JID] } : {} } },
    },
  };
}

const FAKE_HERMES_SOURCE = [
  "let input = '';",
  "process.stdin.on('data', (c) => { input += c; });",
  "process.stdin.on('end', () => {",
  `  if (process.env.TURBO_PARCEIRO_CONVERSATION_ID !== ${JSON.stringify(CONVERSATION_ID)}) process.exit(3);`,
  "  if (!input.includes('o Fornassa caiu?')) process.exit(4);",
  "  console.log('session_id: 20260927_000000_000000');",
  "  console.log('O *Restaurante Fornassa* está funcionando normalmente.');",
  '});',
].join('\n');

(async () => {
  const proposals = [];
  let investigations = 0;
  let gatewaySends = 0;
  let child;
  let childOutput = '';

  fs.writeFileSync(FAKE_HERMES, FAKE_HERMES_SOURCE);

  const central = jsonServer((req, res, body) => {
    if (req.method === 'GET' && req.url.startsWith('/api/agents/config?')) {
      assert.equal(req.headers.authorization, `Bearer ${AGENT_SECRET}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ config: {
        enabled: true,
        agents: { stationSupport: true, accounting: false, partnerAssistant: true },
        accountingGroupConversationIds: [],
        stationInvestigator: {
          enabled: true, autoSend: false, killSwitch: false, allowedConversationIds: [CONVERSATION_ID],
          mentionJids: [BOT_JID], dailyLimit: 20, contextHours: 24, maxContextMessages: 40,
        },
        partnerAssistant: { autoSend: false, allowedConversationIds: [CONVERSATION_ID], mentionJids: [BOT_JID] },
      } }));
    }
    if (req.method === 'POST' && req.url === '/api/agents/partner-memory') {
      assert.equal(req.headers.authorization, `Bearer ${PARTNER_SECRET}`);
      proposals.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, reviewId: 'review-partner-1', duplicate: false }));
    }
    if (req.method === 'POST' && req.url === '/api/agents/station-investigations') {
      investigations += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ decision: 'review', confidence: 'low', stationIds: [], reply: null, reasons: [] }));
    }
    res.writeHead(404).end();
  });
  const gateway = jsonServer((req, res) => {
    if (req.url.startsWith('/message/sendText/')) gatewaySends += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/group/') ? { subject: 'Turbo Station + Arena' } : { key: { id: 'unexpected' } }));
  });

  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const [centralPort, gatewayPort] = await Promise.all([listen(central), listen(gateway)]);
    const probe = http.createServer();
    const supportPort = await listen(probe);
    await close(probe);

    child = spawn(process.execPath, ['index.js'], {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        SUPPORT_COPILOT_PORT: String(supportPort),
        SUPPORT_COPILOT_DB_PATH: DB_PATH,
        SUPPORT_COPILOT_MEDIA_DIR: MEDIA_DIR,
        AGENT_EVENT_BASE_URL: `http://127.0.0.1:${centralPort}`,
        AGENT_EVENT_SECRET: AGENT_SECRET,
        PARTNER_AGENT_SECRET: PARTNER_SECRET,
        HERMES_BIN: FAKE_HERMES,
        EVOLUTION_API_URL: `http://127.0.0.1:${gatewayPort}`,
        EVOLUTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EVOLUTION_INSTANCE_MAP: 'turbostation:turbo_station',
        GROUP_AGENT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    await waitUntil(async () => {
      try { return (await fetch(`http://127.0.0.1:${supportPort}/health`)).ok; } catch { return false; }
    });

    const Database = require('better-sqlite3');
    const bootstrap = new Database(DB_PATH);
    const now = new Date().toISOString();
    bootstrap.prepare(`INSERT INTO conversations (id, brand_id, channel, external_conversation_id, customer_phone, customer_name, status, created_at, updated_at)
      VALUES (?, 'turbo_station', 'whatsapp-group', ?, ?, 'Turbo Station + Arena', 'open', ?, ?)`).run(CONVERSATION_ID, GROUP_JID, GROUP_JID, now, now);
    bootstrap.close();

    const post = (payload) => fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET }, body: JSON.stringify(payload),
    });

    // Without a structured mention the partner assistant stays silent.
    const quiet = await post(webhook(`wamid-quiet-${RUN}`, false));
    assert.equal(quiet.status, 201);
    assert.notEqual((await quiet.json()).partnerAssistant, true);

    const mentionedId = `wamid-mention-${RUN}`;
    const mentioned = await post(webhook(mentionedId, true));
    assert.equal(mentioned.status, 201);
    assert.equal((await mentioned.json()).partnerAssistant, true);

    await waitUntil(() => proposals.length === 1);
    assert.equal(proposals[0].action, 'propose_reply');
    assert.deepEqual(proposals[0].subject, { type: 'whatsapp_group', conversationId: CONVERSATION_ID });
    assert.equal(proposals[0].reply.answer, 'O *Restaurante Fornassa* está funcionando normalmente.');
    assert.equal(proposals[0].reply.sourceMessageId, mentionedId);

    // A provider replay of the same message is not answered twice.
    await post(webhook(mentionedId, true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(proposals.length, 1);

    assert.equal(investigations, 0, 'the station investigator must not answer a message the partner assistant owns');
    assert.equal(gatewaySends, 0, 'shadow mode never sends to the group');

    const check = new Database(DB_PATH, { readonly: true });
    const job = check.prepare('SELECT status, review_id FROM partner_assistant_jobs WHERE message_id = ?').get(mentionedId);
    check.close();
    assert.deepEqual({ ...job }, { status: 'review', review_id: 'review-partner-1' });
    console.log('PASS partner assistant webhook: structured mention, shadow review, precedence over investigator, idempotent replay');
  } catch (error) {
    console.error(childOutput.slice(-3000));
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }
    await Promise.all([close(central), close(gateway)]);
    for (const target of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, FAKE_HERMES, MEDIA_DIR]) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* Windows may still hold the file briefly */ }
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
