#!/usr/bin/env node
/**
 * Suggestion gate + OpenClaw retirement — Support Copilot
 *
 * Proves the copilot never spawns the `openclaw` CLI (or the gateway runner)
 * and that suggestion generation is fail-closed: off unless
 * SUPPORT_COPILOT_SUGGESTIONS_ENABLED=true, and never through the retired
 * 'agent' backend even when enabled. A stateless backend still works when the
 * operator turns the flag on.
 *
 * Run: node --test services/support-copilot/__tests__/suggestion-gate.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  suggestionsEnabled,
  suggestionDecision,
  skippedSuggestion,
} = require('../lib/suggestion-gate');

test('suggestions stay off unless the flag is exactly "true"', () => {
  assert.equal(suggestionsEnabled({}), false);
  assert.equal(suggestionsEnabled({ SUPPORT_COPILOT_SUGGESTIONS_ENABLED: '' }), false);
  assert.equal(suggestionsEnabled({ SUPPORT_COPILOT_SUGGESTIONS_ENABLED: 'TRUE' }), false);
  assert.equal(suggestionsEnabled({ SUPPORT_COPILOT_SUGGESTIONS_ENABLED: '1' }), false);
  assert.equal(suggestionsEnabled({ SUPPORT_COPILOT_SUGGESTIONS_ENABLED: 'true' }), true);
});

test('the agent backend is refused even when suggestions are enabled', () => {
  const on = { SUPPORT_COPILOT_SUGGESTIONS_ENABLED: 'true' };
  assert.deepEqual(suggestionDecision('openrouter', {}), { allowed: false, reason: 'suggestions_disabled' });
  assert.deepEqual(suggestionDecision('agent', on), { allowed: false, reason: 'agent_backend_retired' });
  assert.deepEqual(suggestionDecision('openrouter', on), { allowed: true });
  assert.deepEqual(suggestionDecision('claude-cli', on), { allowed: true });
  assert.deepEqual(skippedSuggestion('x'), { text: null, model: 'skipped', skipped: 'x' });
});

/**
 * Run a scenario in a fresh process against a throwaway DB. Every
 * child_process entry point is replaced BEFORE lib/copilot is required, so any
 * attempt to spawn anything is recorded and fails the scenario.
 */
function runScenario(env, body) {
  const dbPath = path.join(os.tmpdir(), `suggestion-gate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const script = `
    (async () => {
      const cp = require('child_process');
      const spawned = [];
      for (const fn of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) {
        cp[fn] = (...args) => { spawned.push([fn, String(args[0])]); throw new Error('spawn blocked: ' + fn + ' ' + args[0]); };
      }
      const logs = [];
      const origLog = console.log;
      console.log = (...a) => { logs.push(a.join(' ')); };
      const copilot = require('./lib/copilot');
      const conv = { id: 'conv_gate', brand_id: 'turbo_station', channel: 'whatsapp', customer_phone: '5500000000000', customer_name: 'Teste' };
      const messages = [{ id: 'm1', conversation_id: 'conv_gate', direction: 'inbound', body: 'Oi, o carregador parou', created_at: new Date().toISOString() }];
      const out = {};
      ${body}
      console.log = origLog;
      console.log(JSON.stringify({ out, spawned, logs }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, SUPPORT_COPILOT_SUGGESTIONS_ENABLED: '', SUGGESTION_BACKEND: '', ...env, SUPPORT_COPILOT_DB_PATH: dbPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const last = stdout.trim().split('\n').pop();
    return JSON.parse(last);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
}

test('default (flag unset): suggestion is skipped, logged, and nothing is spawned', () => {
  const r = runScenario({}, `
    out.suggestion = await copilot.generateSuggestion(conv, messages);
    await copilot.injectIntoSession('conv_gate', 'x', 'turbo_station');
    await copilot.compactSession('conv_gate', 'turbo_station');
    out.analyze = await copilot.analyzeEdit('turbo_station', 'a', 'b', 'conv_gate');
    await copilot.extractLearnedRule('turbo_station', 'sug1', 'a', 'b', 'conv_gate');
  `);
  assert.deepEqual(r.spawned, []);
  assert.equal(r.out.suggestion.text, null);
  assert.equal(r.out.suggestion.skipped, 'suggestions_disabled');
  assert.equal(r.out.analyze.rule, null);
  assert.equal(r.out.analyze.error, 'openclaw_agent_retired');
  const skips = r.logs.filter((l) => l.includes('[copilot-skip]'));
  for (const action of ['generate_suggestion', 'inject_into_session', 'compact_session', 'analyze_edit', 'extract_learned_rule']) {
    assert.ok(skips.some((l) => l.includes(`action=${action}`)), `missing auditable skip for ${action}`);
  }
});

test('enabled with the default agent backend: skipped as retired, nothing spawned', () => {
  const r = runScenario({ SUPPORT_COPILOT_SUGGESTIONS_ENABLED: 'true' }, `
    out.suggestion = await copilot.generateSuggestion(conv, messages);
  `);
  assert.deepEqual(r.spawned, []);
  assert.equal(r.out.suggestion.skipped, 'agent_backend_retired');
  assert.ok(r.logs.some((l) => l.includes('reason=agent_backend_retired')));
});

test('enabled with a stateless backend: suggestion is generated over HTTP, nothing spawned', () => {
  const r = runScenario({
    SUPPORT_COPILOT_SUGGESTIONS_ENABLED: 'true',
    SUGGESTION_BACKEND: 'openrouter',
    OPENROUTER_API_KEY: 'test-key-not-real',
  }, `
    global.fetch = async (url) => {
      if (String(url).includes('openrouter.ai')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Vou verificar o carregador agora.' } }], model: 'stub' }), text: async () => '' };
      }
      throw new Error('unexpected fetch ' + url);
    };
    out.suggestion = await copilot.generateSuggestion(conv, messages);
  `);
  assert.deepEqual(r.spawned, []);
  assert.equal(r.out.suggestion.skipped, undefined);
  assert.match(String(r.out.suggestion.text), /verificar o carregador/);
});
