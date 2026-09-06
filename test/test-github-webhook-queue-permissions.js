#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const SERVICE = path.join(__dirname, '..', 'services', 'github-webhook.js');
const PRIVATE_MODE = 0o600;
const modeTest = process.platform === 'win32' ? test.skip : test;

function permissionBits(filePath) {
  return fs.statSync(filePath).mode & 0o7777;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, method, requestPath, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: { 'content-length': Buffer.byteLength(body), ...headers },
      timeout: 1500,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(queuePath) {
  const port = await freePort();
  const secret = 'queue-permission-test-secret';
  const env = {
    ...process.env,
    GITHUB_WEBHOOK_PORT: String(port),
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_WEBHOOK_QUEUE_PATH: queuePath,
  };
  delete env.PORT;

  const child = spawn(process.execPath, [SERVICE], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`github-webhook exited before becoming healthy:\n${output}`);
    }
    try {
      const health = await request(port, 'GET', '/health');
      if (health.status === 200) {
        return { port, secret, child, output: () => output };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill();
  throw new Error(`github-webhook did not start:\n${output}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function signature(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

modeTest('fresh queue creation and every append enforce mode 0600', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-webhook-queue-mode-'));
  const queuePath = path.join(tempDir, 'github-webhook-queue.jsonl');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const service = await start(queuePath);
  t.after(() => stop(service.child));

  assert.equal(permissionBits(queuePath), PRIVATE_MODE, 'startup must create the queue as 0600');

  // Prove the append path repairs a later permission regression too.
  fs.chmodSync(queuePath, 0o644);
  const body = JSON.stringify({ repository: { full_name: 'example/test' } });
  const response = await request(service.port, 'POST', '/api/github/webhook', body, {
    'content-type': 'application/json',
    'x-github-event': 'ping',
    'x-hub-signature-256': signature(service.secret, body),
  });

  assert.equal(response.status, 200, response.body);
  assert.equal(permissionBits(queuePath), PRIVATE_MODE, 'append must restore mode 0600 before writing');
  const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'ping');
});

modeTest('startup audibly tightens an existing 0644 queue without replacing it', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-webhook-queue-existing-'));
  const queuePath = path.join(tempDir, 'github-webhook-queue.jsonl');
  const existingContent = '{"existing":true}\n';
  fs.writeFileSync(queuePath, existingContent);
  fs.chmodSync(queuePath, 0o644);
  const before = fs.statSync(queuePath);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const service = await start(queuePath);
  t.after(() => stop(service.child));
  const after = fs.statSync(queuePath);

  assert.equal(after.mode & 0o7777, PRIVATE_MODE);
  assert.equal(after.ino, before.ino, 'permission repair must preserve the inode');
  assert.equal(after.uid, before.uid, 'permission repair must preserve the owner');
  assert.equal(after.gid, before.gid, 'permission repair must preserve the group');
  assert.equal(fs.readFileSync(queuePath, 'utf8'), existingContent, 'permission repair must preserve content');
  assert.match(
    service.output(),
    /corrected queue permissions from 0644 to 0600/i,
    'startup repair must be visible in service logs'
  );
});
