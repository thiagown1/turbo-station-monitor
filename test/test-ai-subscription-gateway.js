'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  CURATED_PROFILES,
  createRequestHandler,
  flattenMessages,
  normalizeTimeoutMs,
  runOpenclawProfile,
} = require('../services/ai-subscription-gateway');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body, token = 'test-secret') {
  return fetch(`${baseUrl}/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

test('curated profiles pin the only two permitted OpenClaw agent ids', () => {
  assert.deepEqual(Object.keys(CURATED_PROFILES).sort(), [
    'claude-subscription',
    'codex-subscription',
  ]);
  assert.equal(CURATED_PROFILES['claude-subscription'].agentId, 'ai_dashboard_claude');
  assert.equal(CURATED_PROFILES['codex-subscription'].agentId, 'ai_dashboard_codex');
});

test('flattenMessages keeps history and separates the current question', () => {
  assert.match(
    flattenMessages(
      [
        { role: 'user', content: 'primeira' },
        { role: 'assistant', content: 'resposta' },
        { role: 'user', content: 'agora?' },
      ],
      '[Tela atual: dashboard]',
    ),
    /^\[Tela atual: dashboard\]\n\n--- Conversa até agora ---[\s\S]*--- Pergunta atual ---\nUser: agora\?$/,
  );
});

test('subscription timeout is finite and clamped to the gateway safety bounds', () => {
  assert.equal(normalizeTimeoutMs(undefined), 110_000);
  assert.equal(normalizeTimeoutMs('not-a-number'), 110_000);
  assert.equal(normalizeTimeoutMs(-1), 1_000);
  assert.equal(normalizeTimeoutMs(500_000), 120_000);
});

test('rejects missing authentication before invoking a subscription', async () => {
  let calls = 0;
  const handler = createRequestHandler({
    token: 'test-secret',
    runProfile: async () => { calls += 1; return 'never'; },
  });
  await withServer(handler, async (baseUrl) => {
    const response = await post(baseUrl, {
      agentProfile: 'codex-subscription',
      messages: [{ role: 'user', content: 'oi' }],
    }, 'wrong');
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });
});

test('rejects arbitrary profiles and never trusts an agent id from the body', async () => {
  let calls = 0;
  const handler = createRequestHandler({
    token: 'test-secret',
    runProfile: async () => { calls += 1; return 'never'; },
  });
  await withServer(handler, async (baseUrl) => {
    const response = await post(baseUrl, {
      agentProfile: 'custom-provider',
      agentId: 'ops',
      messages: [{ role: 'user', content: 'oi' }],
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });
});

test('rejects a valid JSON body with the wrong shape', async () => {
  const handler = createRequestHandler({
    token: 'test-secret',
    runProfile: async () => 'never',
  });
  await withServer(handler, async (baseUrl) => {
    const response = await post(baseUrl, null);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid request' });
  });
});

test('runs a curated profile and returns the dashboard NDJSON contract', async () => {
  let received;
  const handler = createRequestHandler({
    token: 'test-secret',
    runProfile: async (input) => {
      received = input;
      return 'resposta pelo GPT';
    },
  });
  await withServer(handler, async (baseUrl) => {
    const response = await post(baseUrl, {
      agentProfile: 'codex-subscription',
      agentId: 'ops',
      systemPrompt: 'somente leitura',
      messages: [{ role: 'user', content: 'onde fica X?' }],
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const lines = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines, [
      { type: 'delta', text: 'resposta pelo GPT' },
      { type: 'done' },
    ]);
  });
  assert.equal(received.agentProfile, 'codex-subscription');
  assert.equal(received.agentId, 'ai_dashboard_codex');
  assert.equal(received.systemPrompt, 'somente leitura');
  assert.equal(received.prompt, 'onde fica X?');
});

test('fails closed when the service token is absent', async () => {
  const handler = createRequestHandler({
    token: '',
    runProfile: async () => 'never',
  });
  await withServer(handler, async (baseUrl) => {
    const response = await post(baseUrl, {
      agentProfile: 'claude-subscription',
      messages: [{ role: 'user', content: 'oi' }],
    });
    assert.equal(response.status, 503);
  });
});

test('the OpenClaw runner receives prompts on stdin, never in process arguments', async () => {
  let spawned;
  let stdin = '';
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('data', (chunk) => { stdin += chunk.toString(); });
    spawned = { command, args, options };
    setImmediate(() => {
      child.stdout.write(JSON.stringify({
        result: { payloads: [{ text: 'ok via harness' }] },
      }));
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };

  const text = await runOpenclawProfile(
    {
      agentId: 'ai_dashboard_codex',
      prompt: 'PROMPT_PRIVADO',
      systemPrompt: 'somente leitura',
      signal: new AbortController().signal,
    },
    {
      spawnImpl,
      sourceRoot: '/openclaw/source',
      runnerPath: '/gateway/runner.mjs',
      timeoutMs: 1000,
    },
  );

  assert.equal(text, 'ok via harness');
  assert.deepEqual(spawned.args, ['--import', 'tsx', '/gateway/runner.mjs']);
  assert.equal(spawned.options.cwd, '/openclaw/source');
  assert.equal(spawned.args.join(' ').includes('PROMPT_PRIVADO'), false);
  assert.match(JSON.parse(stdin).message, /PROMPT_PRIVADO/);
});
