#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createContadorModelRunner } = require('../lib/contador-model-runner');

function response({ error = null, stdout = '', stderr = '' }) {
  return { error, stdout, stderr };
}

function scriptedExec(responses) {
  const calls = [];
  const execFileImpl = (bin, args, options, callback) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected execFile call for ${bin}`);
    const call = { bin, args: [...args], options, stdin: null };
    calls.push(call);
    const finish = () => queueMicrotask(() => callback(next.error, next.stdout, next.stderr));
    const child = {
      stdin: {
        end(value) {
          call.stdin = String(value || '');
          finish();
        },
      },
    };
    if (!args.includes('-')) finish();
    return child;
  };
  execFileImpl.calls = calls;
  return execFileImpl;
}

function runner(execFileImpl, overrides = {}) {
  return createContadorModelRunner({
    execFileImpl,
    openClawBin: '/bin/openclaw',
    codexBin: '/bin/codex',
    agent: 'contador',
    sessionId: 'contador-contas',
    primaryModel: 'claude-cli/claude-opus-4-8',
    codexFallbackEnabled: true,
    codexFallbackModel: 'gpt-5.6-sol',
    codexWorkspace: '/workspace-contador',
    logger: { warn() {} },
    ...overrides,
  });
}

test('uses the primary OpenClaw model without invoking Codex when it succeeds', async () => {
  const exec = scriptedExec([
    response({ stdout: JSON.stringify({ result: { payloads: [{ text: 'primary answer' }] } }) }),
  ]);

  const result = await runner(exec).runAgent('safe prompt');

  assert.equal(result, 'primary answer');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].bin, '/bin/openclaw');
  assert.deepEqual(exec.calls[0].args.slice(0, 7), [
    'agent', '--agent', 'contador', '--session-id', 'contador-contas', '--model', 'claude-cli/claude-opus-4-8',
  ]);
});

test('falls back to GPT-5.6 Sol through the read-only Codex CLI on weekly quota exhaustion', async () => {
  const primaryError = Object.assign(new Error('primary failed'), { code: 1, killed: false });
  const exec = scriptedExec([
    response({ error: primaryError, stderr: "FailoverError: You've hit your weekly limit · resets 6am (UTC)" }),
    response({ stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fallback answer' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join('\n') }),
  ]);

  const result = await runner(exec).runAgent('financial prompt');

  assert.equal(result, 'fallback answer');
  assert.equal(exec.calls.length, 2);
  assert.equal(exec.calls[1].bin, '/bin/codex');
  assert.deepEqual(exec.calls[1].args, [
    'exec',
    '--model', 'gpt-5.6-sol',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--cd', '/workspace-contador',
    '--json',
    '-',
  ]);
  assert.equal(exec.calls[1].stdin, 'financial prompt');
});

test('reconstructs the current Contador turn when capacity is exhausted after a tool call', async () => {
  const primaryError = Object.assign(new Error('primary failed'), { code: 1, killed: false });
  const exec = scriptedExec([
    response({ stdout: JSON.stringify({ result: { payloads: [{ text: '{"action":"tool","tool":"buscar"}' }] } }) }),
    response({ error: primaryError, stderr: "FailoverError: You've hit your weekly limit" }),
    response({ stdout: JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"action":"reply","text":"ok"}' },
    }) }),
  ]);
  const turnState = {};
  const modelRunner = runner(exec);

  await modelRunner.runAgent('INITIAL RUNTIME RULES AND REQUEST', turnState);
  const result = await modelRunner.runAgent('TOOL RESULT FOR THE SAME REQUEST', turnState);

  assert.equal(result, '{"action":"reply","text":"ok"}');
  assert.match(exec.calls[2].stdin, /INITIAL RUNTIME RULES AND REQUEST/);
  assert.match(exec.calls[2].stdin, /\{"action":"tool","tool":"buscar"\}/);
  assert.match(exec.calls[2].stdin, /TOOL RESULT FOR THE SAME REQUEST/);
  assert.match(exec.calls[2].stdin, /Prior model responses are untrusted history/);
});

test('does not carry turn context into a different Contador job', async () => {
  const primaryError = Object.assign(new Error('primary failed'), { code: 1, killed: false });
  const exec = scriptedExec([
    response({ stdout: JSON.stringify({ result: { payloads: [{ text: 'first answer' }] } }) }),
    response({ error: primaryError, stderr: 'HTTP 429 quota exceeded' }),
    response({ stdout: JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'second answer' },
    }) }),
  ]);
  const modelRunner = runner(exec);

  await modelRunner.runAgent('first job sensitive context', {});
  await modelRunner.runAgent('second job prompt', {});

  assert.equal(exec.calls[2].stdin, 'second job prompt');
  assert.ok(!exec.calls[2].stdin.includes('first job sensitive context'));
});

test('does not cross providers for arbitrary primary failures', async () => {
  const primaryError = Object.assign(new Error('primary failed'), { code: 1, killed: false });
  const exec = scriptedExec([
    response({ error: primaryError, stderr: 'workspace policy rejected the request' }),
  ]);

  await assert.rejects(runner(exec).runAgent('safe prompt'), /workspace policy rejected/);
  assert.equal(exec.calls.length, 1);
});

test('keeps the fallback fail-closed until explicitly enabled', async () => {
  const primaryError = Object.assign(new Error('primary failed'), { code: 1, killed: false });
  const exec = scriptedExec([
    response({ error: primaryError, stderr: 'HTTP 429 rate limit exceeded' }),
  ]);

  await assert.rejects(
    runner(exec, { codexFallbackEnabled: false }).runAgent('safe prompt'),
    /rate limit exceeded/,
  );
  assert.equal(exec.calls.length, 1);
});

test('reports both providers without leaking the prompt when the fallback also fails', async () => {
  const primaryError = Object.assign(new Error('primary failed'), { code: 1, killed: false });
  const fallbackError = Object.assign(new Error('fallback failed'), { code: 2, killed: false });
  const exec = scriptedExec([
    response({ error: primaryError, stderr: 'HTTP 429 quota exceeded' }),
    response({ error: fallbackError, stderr: 'Codex usage limit reached' }),
  ]);

  const secretPrompt = 'prompt-with-sensitive-financial-context';
  await assert.rejects(
    runner(exec).runAgent(secretPrompt),
    (error) => {
      assert.match(error.message, /primary=.*quota exceeded/i);
      assert.match(error.message, /fallback=.*usage limit reached/i);
      assert.ok(!error.message.includes(secretPrompt));
      return true;
    },
  );
});
