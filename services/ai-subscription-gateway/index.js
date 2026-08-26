#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 110_000;

// Claude profiles route through OpenClaw's `claude-cli` provider, which is
// backed by the Claude Max subscription. Verified on the VPS: a gateway agent
// turn with `claude-cli/claude-sonnet-4-6` returns `provider: claude-cli` and
// reports real subscription usage.
//
// Codex profiles route through the `codex` runtime (ChatGPT subscription).
// That plan hit its usage limit on 2026-08-15 and does not reset until
// 2026-08-20, so the Claude profiles are the working path meanwhile.
const CURATED_PROFILES = Object.freeze({
  'claude-subscription': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-sonnet-4-6',
  }),
  'claude-opus-5': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-opus-5',
  }),
  'claude-sonnet-5': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-sonnet-5',
  }),
  'claude-fable-5': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-fable-5',
  }),
  'claude-opus-4-8': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-opus-4-8',
  }),
  'claude-opus-4-7': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-opus-4-7',
  }),
  'claude-opus-4-6': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
    model: 'claude-cli/claude-opus-4-6',
  }),
  'codex-5-6-sol': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CODEX_AGENT_ID || 'ai_dashboard_codex',
    model: 'openai/gpt-5.6-sol',
  }),
  'codex-5-6-terra': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CODEX_AGENT_ID || 'ai_dashboard_codex',
    model: 'openai/gpt-5.6-terra',
  }),
  'codex-5-6-luna': Object.freeze({
    agentId: process.env.AI_SUBSCRIPTION_CODEX_AGENT_ID || 'ai_dashboard_codex',
    model: 'openai/gpt-5.6-luna',
  }),
});

function tokenMatches(header, expected) {
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function flattenMessages(messages, screenContextLine = '') {
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((message) =>
      message &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim(),
    )
    .slice(-50);

  let prompt = '';
  if (clean.length === 1) {
    prompt = clean[0].content.trim();
  } else if (clean.length > 1) {
    const current = clean[clean.length - 1];
    const history = clean
      .slice(0, -1)
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
      .join('\n\n');
    prompt = `--- Conversa até agora ---\n${history}\n\n--- Pergunta atual ---\nUser: ${current.content}`;
  }

  const screen = typeof screenContextLine === 'string' ? screenContextLine.trim().slice(0, 4096) : '';
  return screen ? `${screen}\n\n${prompt}` : prompt;
}

function extractAgentText(result) {
  const payloadText = result && result.result && Array.isArray(result.result.payloads)
    ? result.result.payloads.find((payload) => payload && typeof payload.text === 'string')?.text
    : undefined;
  if (payloadText) return payloadText.trim();
  if (result && typeof result.text === 'string') return result.text.trim();
  if (result && typeof result.result === 'string') return result.result.trim();
  return '';
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(parsed), 1_000), 120_000);
}

function runOpenclawProfile({ agentId, model, prompt, systemPrompt, signal }, options = {}) {
  const timeoutMs = normalizeTimeoutMs(
    options.timeoutMs ?? process.env.AI_SUBSCRIPTION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const runnerPath = options.runnerPath || path.join(__dirname, 'openclaw-gateway-runner.mjs');
  const sourceRoot = options.sourceRoot || process.env.OPENCLAW_SRC_ROOT || '/home/openclaw/openclaw';
  const spawnImpl = options.spawnImpl || spawn;
  const fullPrompt = systemPrompt
    ? `--- Instruções do sistema ---\n${String(systemPrompt).slice(0, 16 * 1024)}\n\n--- Solicitação ---\n${prompt}`
    : prompt;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, ['--import', 'tsx', runnerPath], {
      // OpenClaw keeps `tsx` in its own source tree; resolving the loader from
      // that cwd is what lets the runner import src/gateway/call.ts.
      cwd: sourceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AI_SUBSCRIPTION_ALLOWED_AGENT_IDS: [...new Set(
          Object.values(CURATED_PROFILES).map((profile) => profile.agentId),
        )]
          .join(','),
        AI_SUBSCRIPTION_ALLOWED_MODELS: [...new Set(
          Object.values(CURATED_PROFILES).map((profile) => profile.model),
        )]
          .join(','),
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = () => {
      try { child.kill('SIGKILL'); } catch {}
    };
    const onAbort = () => {
      stop();
      finish(new Error('Requisição cancelada.'));
    };
    const timer = setTimeout(() => {
      stop();
      finish(new Error('Tempo esgotado ao consultar o agente OpenClaw.'));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        stop();
        finish(new Error('Resposta do agente excedeu o limite permitido.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr) < 2048) stderr += chunk;
    });
    child.stdin.on('error', (error) => {
      finish(new Error(`Falha ao enviar a solicitação ao OpenClaw: ${error.message}`));
    });
    child.on('error', (error) => finish(new Error(`Falha ao iniciar OpenClaw: ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        if (stderr) console.error('[ai-subscription-gateway] OpenClaw runner returned invalid JSON');
        finish(new Error('Resposta inválida do OpenClaw.'));
        return;
      }
      const text = extractAgentText(parsed);
      if (code !== 0 || !text) {
        finish(new Error(`OpenClaw não retornou uma resposta válida (código ${code}).`));
        return;
      }
      finish(null, text);
    });

    child.stdin.end(JSON.stringify({
      agentId,
      model,
      message: fullPrompt,
      timeoutMs,
      sessionId: `dashboard-${crypto.randomUUID()}`,
    }));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function createRequestHandler({
  token = process.env.OPENCLAW_AGENT_TOKEN || '',
  runProfile = runOpenclawProfile,
} = {}) {
  return (req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/api/agent/health')) {
      sendJson(res, token ? 200 : 503, { ok: Boolean(token), profiles: Object.keys(CURATED_PROFILES) });
      return;
    }
    if (req.method !== 'POST' || (url !== '/run' && url !== '/api/agent/run')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!token) {
      sendJson(res, 503, { error: 'service not configured' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooLarge) {
        sendJson(res, 413, { error: 'request too large' });
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'invalid request' });
        return;
      }
      const profile = CURATED_PROFILES[body.agentProfile];
      if (!profile) {
        sendJson(res, 400, { error: 'unsupported agent profile' });
        return;
      }
      const prompt = flattenMessages(body.messages, body.screenContextLine);
      if (!prompt) {
        sendJson(res, 400, { error: 'empty prompt' });
        return;
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      const emit = (event) => {
        if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
      };
      try {
        const text = await runProfile({
          agentProfile: body.agentProfile,
          agentId: profile.agentId,
          model: profile.model,
          prompt,
          systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : '',
          signal: abortController.signal,
        });
        emit({ type: 'delta', text });
      } catch (error) {
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : 'Falha no agente OpenClaw.',
        });
      } finally {
        emit({ type: 'done' });
        if (!res.destroyed) res.end();
      }
    });
  };
}

if (require.main === module) {
  const port = Number(process.env.OPENCLAW_AGENT_PORT) || 3105;
  const host = process.env.OPENCLAW_AGENT_HOST || '127.0.0.1';
  http.createServer(createRequestHandler()).listen(port, host, () => {
    console.log(`[ai-subscription-gateway] listening on ${host}:${port}`);
  });
}

module.exports = {
  CURATED_PROFILES,
  createRequestHandler,
  extractAgentText,
  flattenMessages,
  normalizeTimeoutMs,
  runOpenclawProfile,
  tokenMatches,
};
