/**
 * Suggestion generation backends — Support Copilot
 *
 * The prompt is built once by copilot.js; this module decides HOW it's sent to a
 * model. Measured (2026-06-15): the OpenClaw `agent` CLI adds ~40-60s of flat
 * overhead per call regardless of prompt size (a 41-token delta call took 63s),
 * while `claude -p` returns in ~2-3s. So the backend is pluggable + configurable.
 *
 * Backends:
 *  - 'agent'      : OpenClaw agent CLI (session memory, knowledge-doc RAG, slow).
 *  - 'claude-cli' : local `claude -p` — flat-cost subscription, fast, stateless.
 *  - 'openrouter' : direct OpenRouter chat/completions — fast, PAID, stateless.
 *
 * Stateless backends (claude-cli/openrouter) have no session memory, so copilot.js
 * always sends them the FULL prompt.
 *
 * Resolution precedence: env SUGGESTION_BACKEND > copilot_settings.suggestion_backend
 * > 'agent' (safe default / current behavior). All backends return the same shape
 * the agent returns, so copilot.js parses one way: { payloads:[{text}], meta:{...} }.
 */
'use strict';

const { execFile } = require('child_process');

const VALID = new Set(['agent', 'claude-cli', 'openrouter']);
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/openclaw/.npm-global/bin/claude';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.SUGGESTION_OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
const STATELESS = new Set(['claude-cli', 'openrouter']);

function resolveSuggestionBackend(perBrandSetting) {
  const env = (process.env.SUGGESTION_BACKEND || '').trim();
  if (VALID.has(env)) return env;
  const s = (perBrandSetting || '').trim();
  if (VALID.has(s)) return s;
  return 'agent';
}

function isStateless(backend) {
  return STATELESS.has(backend);
}

function wrap(text, provider, model) {
  return { payloads: [{ text: String(text || '').trim() }], meta: { agentMeta: { provider, model } } };
}

function callClaudeCli(prompt, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(CLAUDE_BIN, ['-p', prompt], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude-cli failed: ${err.message}${stderr ? ' | ' + String(stderr).slice(0, 200) : ''}`));
      const text = String(stdout || '').trim();
      if (!text) return reject(new Error('claude-cli returned empty output'));
      resolve(wrap(text, 'claude-cli', 'default'));
    });
  });
}

async function callOpenRouter(prompt, { timeoutMs = 45000, model = OPENROUTER_MODEL } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('openrouter backend requires OPENROUTER_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://turbostation.app',
        'X-Title': 'Turbo Station Support Suggestion',
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 600,
        temperature: 0.5,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`openrouter ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text.trim()) throw new Error('openrouter returned empty content');
    return wrap(text, 'openrouter', model);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch a prompt to the configured backend.
 * @param backend one of agent|claude-cli|openrouter
 * @param opts.callAgent  copilot.js's callOpenClawAgent (passed in to avoid a cycle)
 */
async function callSuggestionBackend(backend, { prompt, sessionId, agentId, attachments, callAgent }) {
  if (backend === 'claude-cli') return callClaudeCli(prompt);
  if (backend === 'openrouter') return callOpenRouter(prompt);
  // default: agent
  return callAgent(sessionId, prompt, agentId, { attachments: attachments || [] });
}

module.exports = {
  resolveSuggestionBackend,
  callSuggestionBackend,
  isStateless,
  VALID_BACKENDS: [...VALID],
};
