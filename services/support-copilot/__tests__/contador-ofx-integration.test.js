#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const groupJid = 'contas-ofx-test@g.us';
const allowedSender = '5511999999999';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contador-ofx-'));
const dbPath = path.join(tempDir, 'support.sqlite');
const mediaDir = path.join(tempDir, 'media');
const requests = [];
const replies = [];
let child;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for OFX intake');
}

function jsonServer(handler) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (part) => { raw += part; });
    req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : null));
  });
}

(async () => {
  const next = jsonServer((req, res, body) => {
    if (req.url?.startsWith('/api/agents/config?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Simulate an unconfigured Agent Center; the exact group env fallback is
      // still required and the OFX path must never use paid media analysis.
      return res.end(JSON.stringify({ config: null }));
    }
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/accounting/bank-statements/import') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ counts: { total: 2, new: 1, duplicate: 1, ignoredBalance: 0, autoClassified: 0 } }));
    }
    res.writeHead(404).end();
  });
  const gateway = jsonServer((req, res, body) => {
    replies.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: { id: `ofx-reply-${replies.length}` } }));
  });

  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    const [nextPort, gatewayPort] = await Promise.all([listen(next), listen(gateway)]);
    const probe = http.createServer();
    const supportPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    child = spawn(process.execPath, ['index.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        SUPPORT_COPILOT_PORT: String(supportPort),
        SUPPORT_COPILOT_DB_PATH: dbPath,
        SUPPORT_COPILOT_MEDIA_DIR: mediaDir,
        CONTADOR_ENABLED: 'true',
        CONTADOR_GROUP_CONVERSATION_ID: groupJid,
        CONTADOR_NEXT_BASE_URL: `http://127.0.0.1:${nextPort}`,
        CONTADOR_NEXT_SECRET: 'test-energy-secret',
        CONTADOR_BANK_STATEMENTS_ENABLED: 'true',
        CONTADOR_BANK_STATEMENTS_API_KEY: 'test-bank-key',
        CONTADOR_BANK_STATEMENTS_APPROVAL_SECRET: 'synthetic-test-approval-secret-32-bytes',
        CONTADOR_BANK_STATEMENTS_ALLOWED_SENDER_IDS: allowedSender,
        AGENT_EVENT_BASE_URL: `http://127.0.0.1:${nextPort}`,
        AGENT_EVENT_SECRET: 'test-energy-secret',
        EVOLUTION_API_URL: `http://127.0.0.1:${gatewayPort}`,
        EVOLUTION_WEBHOOK_SECRET: 'test-webhook-secret',
        EVOLUTION_INSTANCE_MAP: 'turbostation:turbo_station',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let startupError = '';
    child.stderr.on('data', (chunk) => { startupError = (startupError + chunk.toString()).slice(-2000); });
    await waitUntil(async () => {
      if (child.exitCode != null) throw new Error(`Isolated OFX server exited ${child.exitCode}: ${startupError}`);
      try { return (await fetch(`http://127.0.0.1:${supportPort}/health`)).ok; }
      catch { return false; }
    });

    const ofx = Buffer.from('<OFX>synthetic bank statement</OFX>');
    async function send(id, sender, jid = groupJid) {
      const response = await fetch(`http://127.0.0.1:${supportPort}/api/support/ingest/evolution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'test-webhook-secret' },
        body: JSON.stringify({
          event: 'messages.upsert', instance: 'turbostation',
          data: {
            key: { remoteJid: jid, fromMe: false, id, participant: `${sender}@s.whatsapp.net` },
            pushName: 'Financeiro', messageType: 'documentMessage',
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: { documentMessage: { fileName: 'extrato.ofx', mimetype: 'application/x-ofx' } },
            mediaBase64: ofx.toString('base64'), mediaMimetype: 'application/x-ofx',
          },
        }),
      });
      if (![200, 201].includes(response.status)) throw new Error(await response.text());
      return response.json();
    }

    const first = await send('wamid-ofx-1', allowedSender);
    assert.equal(first.bankStatementQueued, true, JSON.stringify(first));
    await waitUntil(() => requests.some((item) => item.url === '/api/accounting/bank-statements/import') && replies.length);
    const imported = requests.find((item) => item.url === '/api/accounting/bank-statements/import');
    assert.equal(imported.headers['x-api-key'], 'test-bank-key');
    assert.equal(imported.headers.authorization, undefined);
    assert.equal(imported.body.confirmedBy, allowedSender);
    assert.equal(Buffer.from(imported.body.contentBase64, 'base64').toString(), ofx.toString());
    const textReply = replies.find((item) => item.url === '/message/sendText/turbostation');
    assert.ok(textReply, JSON.stringify(replies.map((item) => item.url)));
    assert.match(textReply.body.text, /1 novos/);

    const duplicate = await send('wamid-ofx-1', allowedSender);
    assert.equal(duplicate.duplicate, true);
    const unauthorized = await send('wamid-ofx-2', '5511888888888');
    assert.equal(unauthorized.bankStatementQueued, false);
    const otherGroup = await send('wamid-ofx-3', allowedSender, 'other-group@g.us');
    assert.equal(otherGroup.bankStatementQueued, false);
    const direct = await send('wamid-ofx-4', allowedSender, `${allowedSender}@s.whatsapp.net`);
    assert.equal(direct.bankStatementQueued, undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(requests.filter((item) => item.url === '/api/accounting/bank-statements/import').length, 1);
    assert.equal(replies.filter((item) => item.url === '/message/sendText/turbostation').length, 1);
    console.log('PASS OFX intake uses the scoped key, avoids media classification and ignores untrusted groups/senders');
  } finally {
    if (child && child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await Promise.all([new Promise((resolve) => next.close(resolve)), new Promise((resolve) => gateway.close(resolve))]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
