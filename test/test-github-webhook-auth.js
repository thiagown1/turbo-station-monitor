#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const SERVICE = path.join(__dirname, '..', 'services', 'github-webhook.js');

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
      host: '127.0.0.1', port, method, path: requestPath,
      headers: { 'content-length': Buffer.byteLength(body), ...headers }, timeout: 1500,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(secret) {
  const port = await freePort();
  const env = { ...process.env, GITHUB_WEBHOOK_PORT: String(port), GITHUB_WEBHOOK_SECRET: secret };
  delete env.PORT;
  const child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const health = await request(port, 'GET', '/health');
      if (health.status === 200) return { port, child, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`github-webhook did not start:\n${output}`);
}

(async () => {
  console.log('🧪 GitHub webhook authentication');
  const raw = JSON.stringify({ repository: { full_name: 'thiagown1/turbo-station-monitor' } });

  const noSecret = await start('');
  try {
    const res = await request(noSecret.port, 'POST', '/api/github/webhook', raw, {
      'content-type': 'application/json', 'x-github-event': 'ping',
    });
    assert.strictEqual(res.status, 503);
    console.log('  ✅ rejects every webhook when the server secret is missing');
  } finally {
    noSecret.child.kill();
  }

  const configured = await start('test-secret-not-real');
  try {
    const missing = await request(configured.port, 'POST', '/api/github/webhook', raw, {
      'content-type': 'application/json', 'x-github-event': 'ping',
    });
    assert.strictEqual(missing.status, 401);

    const malformed = await request(configured.port, 'POST', '/api/github/webhook', raw, {
      'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=x',
    });
    assert.strictEqual(malformed.status, 401);
    console.log('  ✅ rejects missing and malformed signatures without throwing');
  } finally {
    configured.child.kill();
  }

  console.log('✅ GitHub webhook auth tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
