#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICE_DIR = path.join(__dirname, '..');
const GROUP_JID = 'contas-test@g.us';
const MESSAGE_ID = `wamid-contador-pdf-${process.pid}-${Date.now()}`;
const RECOVERY_MESSAGE_ID = `${MESSAGE_ID}-recovery`;
const DIRECT_RECOVERY_MESSAGE_ID = `${MESSAGE_ID}-direct-recovery`;
const DRAFT_RECOVERY_MESSAGE_ID = `${MESSAGE_ID}-draft-recovery`;
const DRAFT_PROMPT_EXTERNAL_ID = `${MESSAGE_ID}-draft-prompt`;
const DB_PATH = path.join(os.tmpdir(), `contador-pdf-integration-${process.pid}-${Date.now()}.sqlite`);
const MEDIA_DIR = path.join(os.tmpdir(), `contador-media-${process.pid}-${Date.now()}`);
const WEBHOOK_SECRET = 'integration-webhook-secret-not-real';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitUntil(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
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

(async () => {
  let intakeRequest = null;
  let gatewayRequest = null;
  let intakeCount = 0;
  let gatewayCount = 0;
  let child;
  const next = jsonServer((req, res, body) => {
    if (req.url === '/api/accounting/energy-bill-intake') {
      intakeCount += 1;
      intakeRequest = { authorization: req.headers.authorization, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, outcome: 'registered', replyMessage: 'Conta registrada para a estação teste.' }));
    }
    res.writeHead(404).end();
  });
  const gateway = jsonServer((req, res, body) => {
    if (req.url === '/message/sendText/turbostation') {
      gatewayCount += 1;
      gatewayRequest = { url: req.url, body };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: { id: `contador-outbound-test-${gatewayCount}` } }));
  });

  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const [nextPort, gatewayPort] = await Promise.all([listen(next), listen(gateway)]);
    const supportProbe = http.createServer();
    const supportPort = await listen(supportProbe);
    await close(supportProbe);

    child = spawn(process.execPath, ['index.js'], {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        SUPPORT_COPILOT_PORT: String(supportPort),
        SUPPORT_COPILOT_DB_PATH: DB_PATH,
        SUPPORT_COPILOT_MEDIA_DIR: MEDIA_DIR,
        CONTADOR_ENABLED: 'true',
        CONTADOR_GROUP_CONVERSATION_ID: GROUP_JID,
        CONTADOR_NEXT_BASE_URL: `http://127.0.0.1:${nextPort}`,
        CONTADOR_NEXT_SECRET: 'integration-secret',
        CONTADOR_INSTANCE: 'turbostation',
        EVOLUTION_API_URL: `http://127.0.0.1:${gatewayPort}`,
        EVOLUTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EVOLUTION_INSTANCE_MAP: 'turbostation:turbo_station',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childOutput = '';
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });

    await waitUntil(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${supportPort}/health`);
        return response.ok;
      } catch { return false; }
    });

    const pdf = Buffer.from('%PDF-1.4 integration fixture');
    const webhookPayload = {
        event: 'messages.upsert',
        instance: 'turbostation',
        data: {
          key: { remoteJid: GROUP_JID, fromMe: false, id: MESSAGE_ID, participant: '556299999999@s.whatsapp.net' },
          pushName: 'Financeiro',
          messageType: 'documentMessage',
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { documentMessage: { fileName: 'conta.pdf', mimetype: 'application/pdf' } },
          mediaBase64: pdf.toString('base64'),
          mediaMimetype: 'application/pdf',
        },
    };
    const response = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload),
    });
    assert.equal(response.status, 201, await response.text());

    try {
      await waitUntil(() => intakeRequest && gatewayRequest, 8_000);
    } catch (err) {
      throw new Error(`${err.message}\n--- support-copilot output ---\n${childOutput}`);
    }

    assert.equal(intakeRequest.authorization, 'Bearer integration-secret');
    assert.equal(intakeRequest.body.messageId, MESSAGE_ID);
    assert.equal(intakeRequest.body.groupConversationId, GROUP_JID);
    assert.equal(Buffer.from(intakeRequest.body.contentBase64, 'base64').toString(), pdf.toString());
    assert.equal(gatewayRequest.url, '/message/sendText/turbostation');
    assert.equal(gatewayRequest.body.number, GROUP_JID);
    assert.equal(gatewayRequest.body.text, 'Conta registrada para a estação teste.');
    assert.equal(fs.existsSync(path.join(MEDIA_DIR, `${MESSAGE_ID}.pdf`)), true);

    const replay = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(intakeCount, 1);
    assert.equal(gatewayCount, 1);

    const Database = require('better-sqlite3');
    const bootstrap = new Database(DB_PATH);
    const original = bootstrap.prepare('SELECT conversation_id, brand_id FROM messages WHERE external_message_id = ?').get(MESSAGE_ID);
    bootstrap.prepare(`
      INSERT INTO messages
        (id, conversation_id, brand_id, direction, source, body, external_message_id, delivery_status, sender_id, sender_name, created_at)
      VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, NULL, ?, ?, ?)
    `).run(
      `msg-precommitted-${Date.now()}`,
      original.conversation_id,
      original.brand_id,
      '[Financeiro]: [Documento: conta-recuperada.pdf]',
      RECOVERY_MESSAGE_ID,
      '556299999999',
      'Financeiro',
      new Date().toISOString(),
    );
    bootstrap.close();

    const recoveryPayload = JSON.parse(JSON.stringify(webhookPayload));
    recoveryPayload.data.key.id = RECOVERY_MESSAGE_ID;
    recoveryPayload.data.message.documentMessage.fileName = 'conta-recuperada.pdf';
    const recovery = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(recoveryPayload),
    });
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json()).duplicate, true);
    await waitUntil(() => intakeCount === 2 && gatewayCount === 2, 8_000);

    const directBootstrap = new Database(DB_PATH);
    const directNow = new Date().toISOString();
    directBootstrap.prepare(`
      INSERT INTO conversations
        (id, brand_id, channel, customer_phone, status, created_at, updated_at)
      VALUES ('conv-direct-recovery', 'turbo_station', 'whatsapp', '5511999999999', 'open', ?, ?)
    `).run(directNow, directNow);
    directBootstrap.prepare(`
      INSERT INTO messages
        (id, conversation_id, brand_id, direction, source, body, external_message_id, delivery_status, sender_id, sender_name, created_at)
      VALUES ('msg-direct-recovery', 'conv-direct-recovery', 'turbo_station', 'inbound', 'evolution', '[📷 Imagem]', ?, NULL, '5511999999999', 'Cliente', ?)
    `).run(DIRECT_RECOVERY_MESSAGE_ID, directNow);
    directBootstrap.close();

    const directPayload = {
      event: 'messages.upsert',
      instance: 'turbostation',
      data: {
        key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: DIRECT_RECOVERY_MESSAGE_ID },
        pushName: 'Cliente',
        messageType: 'imageMessage',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { imageMessage: { caption: 'imagem', mimetype: 'image/jpeg' } },
        mediaBase64: Buffer.from('direct image fixture').toString('base64'),
        mediaMimetype: 'image/jpeg',
      },
    };
    const directRecovery = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(directPayload),
    });
    assert.equal(directRecovery.status, 200);
    assert.equal((await directRecovery.json()).duplicate, true);
    await waitUntil(() => {
      const probe = new Database(DB_PATH, { readonly: true });
      const row = probe.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get('msg-direct-recovery');
      probe.close();
      return row;
    }, 8_000);

    const draftBootstrap = new Database(DB_PATH);
    const draftNow = new Date().toISOString();
    draftBootstrap.prepare(`
      INSERT INTO messages
        (id, conversation_id, brand_id, direction, source, body, external_message_id, media_json, delivery_status, created_at)
      VALUES (?, ?, ?, 'outbound', 'contador', ?, ?, ?, 'sent', ?)
    `).run(
      `msg-draft-prompt-${Date.now()}`,
      original.conversation_id,
      original.brand_id,
      'De qual estação é essa conta?',
      DRAFT_PROMPT_EXTERNAL_ID,
      JSON.stringify({ contador: { kind: 'draft_prompt', draftId: 'rcpt_recovery_test' } }),
      draftNow,
    );
    draftBootstrap.prepare(`
      INSERT INTO messages
        (id, conversation_id, brand_id, direction, source, body, external_message_id, sender_id, sender_name, created_at)
      VALUES (?, ?, ?, 'inbound', 'evolution', ?, ?, ?, ?, ?)
    `).run(
      `msg-draft-recovery-${Date.now()}`,
      original.conversation_id,
      original.brand_id,
      '[Financeiro]: é do Galois',
      DRAFT_RECOVERY_MESSAGE_ID,
      '556299999999',
      'Financeiro',
      draftNow,
    );
    draftBootstrap.close();

    const draftRecoveryPayload = {
      event: 'messages.upsert',
      instance: 'turbostation',
      data: {
        key: { remoteJid: GROUP_JID, fromMe: false, id: DRAFT_RECOVERY_MESSAGE_ID, participant: '556299999999@s.whatsapp.net' },
        pushName: 'Financeiro',
        messageType: 'extendedTextMessage',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { extendedTextMessage: { text: 'é do Galois', contextInfo: { stanzaId: DRAFT_PROMPT_EXTERNAL_ID } } },
      },
    };
    const draftRecovery = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(draftRecoveryPayload),
    });
    assert.equal(draftRecovery.status, 200);
    assert.equal((await draftRecovery.json()).duplicate, true);
    await waitUntil(() => {
      const probe = new Database(DB_PATH, { readonly: true });
      const row = probe.prepare('SELECT status FROM contador_jobs WHERE message_id = ?').get(DRAFT_RECOVERY_MESSAGE_ID);
      probe.close();
      return row;
    }, 8_000);

    const database = new Database(DB_PATH, { readonly: true });
    const job = database.prepare('SELECT status, attempts FROM contador_jobs WHERE message_id = ?').get(MESSAGE_ID);
    const recoveredJob = database.prepare('SELECT status, attempts FROM contador_jobs WHERE message_id = ?').get(RECOVERY_MESSAGE_ID);
    const recoveredDraftJob = database.prepare('SELECT kind FROM contador_jobs WHERE message_id = ?').get(DRAFT_RECOVERY_MESSAGE_ID);
    const directRecoveryJob = database.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get('msg-direct-recovery');
    const outbound = database.prepare("SELECT body, source, delivery_status FROM messages WHERE external_message_id = 'contador-outbound-test-1'").get();
    database.close();
    assert.deepEqual(job, { status: 'completed', attempts: 1 });
    assert.deepEqual(recoveredJob, { status: 'completed', attempts: 1 });
    assert.deepEqual(recoveredDraftJob, { kind: 'query' });
    assert.ok(directRecoveryJob, 'duplicate one-to-one webhook should recreate its durable media job');
    assert.deepEqual(outbound, { body: 'Conta registrada para a estação teste.', source: 'contador', delivery_status: 'sent' });
    console.log('PASS PDF webhook and duplicate replay both recover durable Contador work');
  } finally {
    child?.kill();
    await Promise.allSettled([close(next), close(gateway)]);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch {}
    }
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('FAIL PDF Contador integration');
  console.error(err);
  process.exitCode = 1;
});
