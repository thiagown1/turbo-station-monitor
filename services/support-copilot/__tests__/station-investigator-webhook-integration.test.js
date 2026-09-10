#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICE_DIR = path.join(__dirname, '..');
const GROUP_JID = '120363-habibs-pilot@g.us';
const CONVERSATION_ID = 'conv-habibs-pilot';
const BOT_JID = 'support-bot@s.whatsapp.net';
const MESSAGE_ID = `wamid-habibs-${process.pid}-${Date.now()}`;
const DB_PATH = path.join(os.tmpdir(), `station-investigator-webhook-${process.pid}-${Date.now()}.sqlite`);
const MEDIA_DIR = path.join(os.tmpdir(), `station-investigator-media-${process.pid}-${Date.now()}`);
const WEBHOOK_SECRET = 'station-investigator-webhook-test-secret';
const AGENT_SECRET = 'station-investigator-central-test-secret';

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

function webhookPayload(messageId, structuredMention = true, withMedia = false) {
  const contextInfo = structuredMention ? { mentionedJid: [BOT_JID] } : {};
  return {
    event: 'messages.upsert',
    instance: 'turbostation',
    data: {
      key: {
        remoteJid: GROUP_JID,
        fromMe: false,
        id: messageId,
        participant: '5561999999999@s.whatsapp.net',
      },
      pushName: 'Luan',
      messageType: withMedia ? 'imageMessage' : 'extendedTextMessage',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: withMedia ? {
        imageMessage: {
          caption: '@Turbo Station Suporte Habibs desarmou de novo?',
          mimetype: 'image/jpeg',
          contextInfo,
        },
      } : {
        extendedTextMessage: {
          text: '@Turbo Station Suporte Habibs desarmou de novo?',
          contextInfo,
        },
      },
    },
  };
}

function quotedContadorPayload(messageId, quotedMessageId) {
  return {
    event: 'messages.upsert',
    instance: 'turbostation',
    data: {
      key: {
        remoteJid: GROUP_JID,
        fromMe: false,
        id: messageId,
        participant: '5561999999999@s.whatsapp.net',
      },
      pushName: 'Luan',
      messageType: 'extendedTextMessage',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        extendedTextMessage: {
          text: '@Turbo Station Suporte Habibs desarmou?',
          contextInfo: { mentionedJid: [BOT_JID], stanzaId: quotedMessageId },
        },
      },
    },
  };
}

(async () => {
  let investigationCount = 0;
  let investigationRequest = null;
  let gatewaySendCount = 0;
  let unavailableConfigCount = 0;
  let outageConfigAvailable = false;
  let outageConversationId = null;
  let child;
  let childOutput = '';

  const central = jsonServer((req, res, body) => {
    assert.equal(req.headers.authorization, `Bearer ${AGENT_SECRET}`);
    if (req.method === 'GET' && req.url.startsWith('/api/agents/config?')) {
      const requestedBrand = new URL(req.url, 'http://central.test').searchParams.get('brandId');
      if (requestedBrand === 'unavailable_brand' && !outageConfigAvailable) {
        unavailableConfigCount += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        config: {
          enabled: true,
          agents: { stationSupport: true, accounting: false },
          accountingGroupConversationIds: [CONVERSATION_ID],
          stationInvestigator: {
            enabled: true,
            autoSend: false,
            killSwitch: false,
            allowedConversationIds: [CONVERSATION_ID, outageConversationId].filter(Boolean),
            mentionJids: [BOT_JID],
            dailyLimit: 20,
            contextHours: 24,
            maxContextMessages: 40,
          },
        },
      }));
    }
    if (req.method === 'POST' && req.url === '/api/agents/station-investigations') {
      investigationCount += 1;
      investigationRequest = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        decision: 'review',
        confidence: 'medium',
        stationIds: ['DFAR2606180001'],
        candidateReply: 'O Habibs está online e comunicando normalmente.',
        reply: null,
        reasons: ['shadow_mode'],
      }));
    }
    res.writeHead(404).end();
  });

  const gateway = jsonServer((req, res) => {
    if (req.url.startsWith('/message/sendText/')) gatewaySendCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/group/') ? { subject: 'Turbo Station + Arena' } : { key: { id: 'unexpected-send' } }));
  });

  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const [centralPort, gatewayPort] = await Promise.all([listen(central), listen(gateway)]);
    const portProbe = http.createServer();
    const supportPort = await listen(portProbe);
    await close(portProbe);

    child = spawn(process.execPath, ['index.js'], {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        SUPPORT_COPILOT_PORT: String(supportPort),
        SUPPORT_COPILOT_DB_PATH: DB_PATH,
        SUPPORT_COPILOT_MEDIA_DIR: MEDIA_DIR,
        AGENT_EVENT_BASE_URL: `http://127.0.0.1:${centralPort}`,
        AGENT_EVENT_SECRET: AGENT_SECRET,
        EVOLUTION_API_URL: `http://127.0.0.1:${gatewayPort}`,
        EVOLUTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EVOLUTION_INSTANCE_MAP: 'turbostation:turbo_station,outage:unavailable_brand',
        CONTADOR_ENABLED: 'true',
        CONTADOR_GROUP_CONVERSATION_ID: GROUP_JID,
        CONTADOR_NEXT_BASE_URL: `http://127.0.0.1:${centralPort}`,
        CONTADOR_NEXT_SECRET: AGENT_SECRET,
        GROUP_AGENT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });

    await waitUntil(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${supportPort}/health`)).ok;
      } catch {
        return false;
      }
    });

    const Database = require('better-sqlite3');
    const bootstrap = new Database(DB_PATH);
    const now = new Date().toISOString();
    bootstrap.prepare(`
      INSERT INTO conversations
        (id, brand_id, channel, external_conversation_id, customer_phone, customer_name, status, created_at, updated_at)
      VALUES (?, 'turbo_station', 'whatsapp-group', ?, ?, 'Turbo Station + Arena', 'open', ?, ?)
    `).run(CONVERSATION_ID, GROUP_JID, GROUP_JID, now, now);
    bootstrap.close();

    const unauthenticated = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(`${MESSAGE_ID}-unauthenticated`)),
    });
    assert.equal(unauthenticated.status, 401);

    const unavailableId = `${MESSAGE_ID}-config-unavailable`;
    const unavailablePayload = webhookPayload(unavailableId, false);
    unavailablePayload.instance = 'outage';
    unavailablePayload.data.message.extendedTextMessage.text = 'Oi';
    const unavailable = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(unavailablePayload),
    });
    assert.equal(unavailable.status, 201);
    outageConversationId = (await unavailable.json()).conversationId;
    assert.equal(unavailableConfigCount, 1, 'one inbound message must reuse one failed Agent Center lookup');

    const genericOwnedId = `${MESSAGE_ID}-generic-owned`;
    const genericOwnedPayload = webhookPayload(genericOwnedId, true, true);
    genericOwnedPayload.instance = 'outage';
    const genericFirst = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(genericOwnedPayload),
    });
    assert.equal(genericFirst.status, 201);
    await waitUntil(() => {
      const probe = new Database(DB_PATH, { readonly: true });
      const stored = probe.prepare('SELECT id FROM messages WHERE external_message_id = ?').get(genericOwnedId);
      const generic = stored
        ? probe.prepare('SELECT status FROM agent_media_jobs WHERE message_id = ?').get(stored.id)
        : null;
      probe.close();
      return generic;
    });

    outageConfigAvailable = true;
    const genericReplay = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(genericOwnedPayload),
    });
    assert.equal(genericReplay.status, 200);
    assert.equal((await genericReplay.json()).duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const genericOwnershipProbe = new Database(DB_PATH, { readonly: true });
    const genericStationJobs = genericOwnershipProbe.prepare('SELECT COUNT(*) count FROM station_investigation_jobs WHERE message_id = ?')
      .get(genericOwnedId).count;
    genericOwnershipProbe.close();
    assert.equal(genericStationJobs, 0, 'a durable generic job must retain ownership after config recovery');
    assert.equal(investigationCount, 0, 'generic ownership must block a second station investigation');

    const first = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(MESSAGE_ID, true, true)),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 201, JSON.stringify(firstBody));
    assert.equal(firstBody.stationInvestigation, true);

    try {
      await waitUntil(() => investigationCount === 1);
      await waitUntil(() => {
        const probe = new Database(DB_PATH, { readonly: true });
        const job = probe.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?').get(MESSAGE_ID);
        probe.close();
        return job?.status === 'review';
      });
    } catch (error) {
      throw new Error(`${error.message}\n--- support-copilot output ---\n${childOutput}`);
    }

    assert.equal(investigationRequest.sourceMessageId, MESSAGE_ID);
    assert.equal(investigationRequest.conversationId, CONVERSATION_ID);
    assert.equal(investigationRequest.mentionedJid, BOT_JID);
    assert.equal(investigationRequest.context.effectiveQuestion, 'Habibs desarmou de novo?');
    assert.equal(investigationRequest.context.contextConfidence, 'medium');
    assert.deepEqual(investigationRequest.context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    assert.equal(gatewaySendCount, 0, 'shadow mode must not call the Evolution send endpoint');

    const replay = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(MESSAGE_ID, true, true)),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(investigationCount, 1, 'provider replay must not repeat central investigation');
    assert.equal(gatewaySendCount, 0);

    const lookalikeId = `${MESSAGE_ID}-plain-text-lookalike`;
    const lookalike = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(lookalikeId, false)),
    });
    assert.equal(lookalike.status, 201);
    assert.equal((await lookalike.json()).stationInvestigation, undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(investigationCount, 1, 'plain-text lookalike must not reach the investigator');
    assert.equal(gatewaySendCount, 0);

    const staleReplayId = `${MESSAGE_ID}-stale-replay`;
    const staleFirst = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(staleReplayId, true, true)),
    });
    assert.equal(staleFirst.status, 201);
    await waitUntil(() => investigationCount === 2);
    await waitUntil(() => {
      const probe = new Database(DB_PATH, { readonly: true });
      const job = probe.prepare('SELECT status FROM station_investigation_jobs WHERE message_id = ?').get(staleReplayId);
      probe.close();
      return job?.status === 'review';
    });
    const staleSetup = new Database(DB_PATH);
    const staleStoredMessage = staleSetup.prepare('SELECT id FROM messages WHERE external_message_id = ?').get(staleReplayId);
    staleSetup.prepare("UPDATE messages SET created_at = datetime('now', '-3 days') WHERE id = ?").run(staleStoredMessage.id);
    staleSetup.prepare('DELETE FROM station_investigation_jobs WHERE message_id = ?').run(staleReplayId);
    staleSetup.close();

    const staleReplay = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(staleReplayId, true, true)),
    });
    assert.equal(staleReplay.status, 200);
    assert.equal((await staleReplay.json()).duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(investigationCount, 2, 'stale replay must not repeat a failed context investigation');

    const quotedDraftExternalId = `${MESSAGE_ID}-contador-draft`;
    const quotedReplyId = `${MESSAGE_ID}-contador-reply`;
    const quotedSetup = new Database(DB_PATH);
    quotedSetup.prepare(`INSERT INTO messages
      (id, conversation_id, brand_id, direction, source, body, raw_body,
       external_message_id, media_json, delivery_status, created_at)
      VALUES (?, ?, ?, 'outbound', 'contador', ?, ?, ?, ?, 'sent', ?)`)
      .run(
        `${quotedDraftExternalId}-local`, CONVERSATION_ID, 'turbo_station',
        'Qual estação devo considerar?', 'Qual estação devo considerar?', quotedDraftExternalId,
        JSON.stringify({ contador: { kind: 'draft_prompt', draftId: 'draft-habibs' } }),
        new Date().toISOString(),
      );
    quotedSetup.close();

    const quotedReply = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(quotedContadorPayload(quotedReplyId, quotedDraftExternalId)),
    });
    const quotedReplyBody = await quotedReply.json();
    assert.equal(quotedReply.status, 201, JSON.stringify(quotedReplyBody));
    assert.equal(quotedReplyBody.stationInvestigation, undefined, 'quoted Contador reply must take precedence');
    await waitUntil(() => {
      const probe = new Database(DB_PATH, { readonly: true });
      const count = probe.prepare('SELECT COUNT(*) count FROM contador_jobs WHERE message_id = ?').get(quotedReplyId).count;
      probe.close();
      return count === 1;
    });
    const quotedStationProbe = new Database(DB_PATH, { readonly: true });
    const quotedStationJobCount = quotedStationProbe.prepare('SELECT COUNT(*) count FROM station_investigation_jobs WHERE message_id = ?')
      .get(quotedReplyId).count;
    quotedStationProbe.close();
    assert.equal(quotedStationJobCount, 0, 'quoted Contador reply must not reserve station ownership or quota');
    assert.equal(investigationCount, 2, 'quoted Contador reply must not reach the station investigator');

    const quotedReplay = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(quotedContadorPayload(quotedReplyId, quotedDraftExternalId)),
    });
    assert.equal(quotedReplay.status, 200);
    assert.equal((await quotedReplay.json()).duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const quotedReplayProbe = new Database(DB_PATH, { readonly: true });
    const quotedJobCount = quotedReplayProbe.prepare('SELECT COUNT(*) count FROM contador_jobs WHERE message_id = ?').get(quotedReplyId).count;
    const quotedReplayStationCount = quotedReplayProbe.prepare('SELECT COUNT(*) count FROM station_investigation_jobs WHERE message_id = ?')
      .get(quotedReplyId).count;
    quotedReplayProbe.close();
    assert.equal(quotedJobCount, 1, 'quoted Contador replay must remain idempotent');
    assert.equal(quotedReplayStationCount, 0, 'quoted Contador replay must stay outside station ownership and quota');
    assert.equal(investigationCount, 2, 'quoted Contador replay must not reach the station investigator');

    const database = new Database(DB_PATH, { readonly: true });
    const job = database.prepare(`
      SELECT status, decision, confidence, station_ids_json, response_sent_at, response_external_message_id
      FROM station_investigation_jobs WHERE message_id = ?
    `).get(MESSAGE_ID);
    const storedMessage = database.prepare('SELECT id FROM messages WHERE external_message_id = ?').get(MESSAGE_ID);
    const genericJobs = database.prepare('SELECT COUNT(*) count FROM agent_media_jobs WHERE message_id = ?').get(storedMessage.id);
    const staleGenericJobs = database.prepare('SELECT COUNT(*) count FROM agent_media_jobs WHERE message_id = ?').get(staleStoredMessage.id);
    const suggestions = database.prepare('SELECT COUNT(*) count FROM suggestions WHERE source_message_id = ?').get(MESSAGE_ID);
    database.close();

    assert.deepEqual(job, {
      status: 'review',
      decision: 'review',
      confidence: 'medium',
      station_ids_json: JSON.stringify(['DFAR2606180001']),
      response_sent_at: null,
      response_external_message_id: null,
    });
    assert.equal(genericJobs.count, 0, 'claimed station message must not enter the generic agent pipeline');
    assert.equal(staleGenericJobs.count, 0, 'stale replay with failed context must retain station ownership');
    assert.equal(suggestions.count, 0, 'claimed station message must not create a generic group suggestion');
    console.log('PASS station webhook shadow flow, structured mention, idempotency, isolation, and zero-send gates');
  } finally {
    child?.kill();
    await Promise.allSettled([close(central), close(gateway)]);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch {}
    }
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL station investigator webhook integration');
  console.error(error);
  process.exitCode = 1;
});
