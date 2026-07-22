#!/usr/bin/env node
/**
 * vercel-deploy-hook.js — Vercel native Webhook receiver → WhatsApp + Telegram.
 *
 * Purpose
 *   The team's recurring pain is unreliable deploy notifications. `deploy-watch`
 *   detects deploys by POLLING https://www.turbostation.com.br/api/version
 *   (≤60s lag, flaky). A native Vercel Webhook (Team Settings → Webhooks) pushes
 *   `deployment.promoted` / `deployment.error` / `deployment.succeeded` events
 *   INSTANTLY with the sha + deployment id. This standalone service receives
 *   those events and relays a concise message to:
 *     • the team WhatsApp alerts group (via support-copilot relay), and
 *     • Telegram (via the openclaw CLI, same path the auto-rollback-watchdog uses).
 *
 *   It is NEW coverage for FAILED builds: nothing currently alerts on
 *   `deployment.error`.
 *
 *   On a PRODUCTION promotion it also appends a short "what to test manually"
 *   checklist, derived from the files changed since the last prod deploy we saw
 *   (gh api compare, read-only) and phrased by a fast cloud LLM (openclaw agent)
 *   with a deterministic path→area map as the always-on fallback. Automated tests
 *   don't cover real payments / OCPP charging / push / mobile UI — this nudges a
 *   human to smoke exactly the areas this deploy touched. Toggle: DEPLOY_HOOK_SMOKE=0.
 *
 *   This does NOT touch / replace vercel-drain, deploy-watch, support-copilot,
 *   the OCPP services, or the runners. It is a separate pm2 process on its own
 *   loopback port; nginx is the only public entry.
 *
 * Security notes (OWASP/LGPD)
 *   - A01/A07/A08: every inbound event is HMAC-SHA1-verified against
 *     VERCEL_WEBHOOK_SECRET (x-vercel-signature) over the RAW request body —
 *     the exact same scheme vercel-drain uses for the log drain. FAIL CLOSED:
 *     if the secret is unset, EVERY event is rejected (503 "secret not
 *     configured") and logged; a wrong/missing signature → 401. Timing-safe
 *     compare.
 *   - A10 (SSRF): no URL is taken from the request to drive a server-side fetch;
 *     the only outbound calls are to fixed loopback (support-copilot :3005) and
 *     the openclaw CLI. The inspector/alias URL from the payload is only ever
 *     placed into the human-readable message text, never fetched.
 *   - A09/LGPD: no PII is read or logged. We log only event type, project id,
 *     target, short sha, and a truncated commit message. No request bodies are
 *     persisted. The relay body is a deploy notice (sha + commit subject), not
 *     customer data. The smoke checklist feeds the LLM only changed file PATHS
 *     and commit SUBJECTS — never customer data.
 *   - A03/A10 (smoke checklist): the sha from the payload is validated against
 *     /^[0-9a-f]{7,40}$/ before it is interpolated into a fixed `gh api` path on a
 *     hard-coded repo slug; gh is invoked via execFileSync (array args, no shell),
 *     and the LLM via the openclaw CLI the same way. No request value reaches a
 *     shell or an arbitrary URL.
 *   - A04 (cost/DoS): MAX_PAYLOAD_SIZE cap before parse; loopback bind only, so
 *     nginx (with its own client_max_body_size) is the only reachable path.
 *   - Best-effort relays: a WhatsApp/Telegram hiccup never fails the 200 — we
 *     respond 200 FAST and relay AFTER, so Vercel never retries on our slow/down
 *     downstream.
 *
 * Run
 *   PORT=3010 VERCEL_WEBHOOK_SECRET=… node services/vercel-deploy-hook.js
 *   node services/vercel-deploy-hook.js --selftest   # verify mechanics, NO WhatsApp send
 *   DRY_WHATSAPP=1 node services/vercel-deploy-hook.js   # never POST to the group
 *
 * Vercel dashboard config (human step)
 *   Team Settings → Webhooks → Create Webhook
 *     URL:      https://logs.turbostation.com.br/vercel-deploy-hook
 *     Events:   deployment.promoted, deployment.error  (optionally deployment.succeeded)
 *     Project:  Turbo Station (prj_dptfUFsPBJ9yg0xVC9Ga05I0eU5m) — scope to this project
 *   Copy the generated signing secret into VERCEL_WEBHOOK_SECRET in the skill .env,
 *   then: pm2 restart vercel-deploy-hook --update-env
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────
const { resolveServicePort } = require('./lib/service-port');

const PORT = resolveServicePort('VERCEL_DEPLOY_HOOK_PORT', 3010, '[vercel-deploy-hook]');
const WEBHOOK_SECRET = process.env.VERCEL_WEBHOOK_SECRET || '';
const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB — webhook payloads are tiny

// Only notify for THIS project; ignore everything else.
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'prj_dptfUFsPBJ9yg0xVC9Ga05I0eU5m';

// WhatsApp relay (support-copilot) — mirror next/lib/services/whatsapp-notifier.ts.
const SUPPORT_BASE = process.env.SUPPORT_COPILOT_URL || 'http://127.0.0.1:3005';
const MONITOR_API_SECRET = process.env.MONITOR_API_SECRET || process.env.SUPPORT_API_SECRET || '';
const ALERTS_BRAND = process.env.DEPLOY_WATCH_ALERTS_BRAND || 'turbo_station';
// turbo_station's whatsapp_outbound_config.alertsConversationId (the alerts group).
const ALERTS_CONVERSATION_ID = process.env.DEPLOY_HOOK_ALERTS_CONV || 'conv_jiuijxjtmnet23i9';
const MESSAGE_SOURCE = 'vercel-deploy-hook';

// Next.js prod base + kill switch for the deploy-watch trigger (see startDeployWatch).
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://www.turbostation.com.br').replace(/\/+$/, '');
const ENABLE_WATCH_START = process.env.DEPLOY_HOOK_START_WATCH !== '0';

// Telegram — mirror auto-rollback-watchdog.js sendTelegram (openclaw CLI).
const DEPLOY_TELEGRAM_GROUP =
  process.env.DEPLOY_TELEGRAM_GROUP || process.env.ALERT_TELEGRAM_GROUP || 'telegram:-5102620169';

// Safety switches (never spam the group during build/verify).
const DRY_WHATSAPP = process.env.DRY_WHATSAPP === '1' || process.argv.includes('--dry-whatsapp');

// ─── Smoke-checklist config ──────────────────────────────────────────
// On a PRODUCTION promotion we append a short "what to test manually" list,
// derived from the files changed since the LAST production deploy we saw.
// Diff comes from `gh api compare` (read-only, GitHub already has the sha — no
// local checkout / fetch lag). Phrasing optionally goes through a fast cloud LLM
// (openclaw agent), with a deterministic path→area map as the always-on fallback.
const REPO_SLUG = process.env.DEPLOY_HOOK_REPO || 'thiagown1/turbo_station';
const ENABLE_SMOKE = process.env.DEPLOY_HOOK_SMOKE !== '0';
const ENABLE_SMOKE_LLM = process.env.DEPLOY_HOOK_SMOKE_LLM !== '0';
const SMOKE_MAX = Number(process.env.DEPLOY_HOOK_SMOKE_MAX || 8);
const SMOKE_LLM_SESSION = process.env.DEPLOY_HOOK_SMOKE_SESSION || 'vercel-deploy-hook-smoke';
const SMOKE_LLM_TIMEOUT = Number(process.env.DEPLOY_HOOK_SMOKE_LLM_TIMEOUT || 75); // seconds
// Pointer to the last production sha we built a checklist for (the diff base).
const LAST_SHA_FILE = process.env.DEPLOY_HOOK_LAST_SHA_FILE ||
  path.join(__dirname, '..', '.deploy-hook-last-prod-sha');
// Validate any sha before it touches a `gh api` path (A03/A10 — no ref injection).
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// ─── Logging (no PII, truncated) ─────────────────────────────────────
function log(...a) { console.log(new Date().toISOString(), '[vercel-deploy-hook]', ...a); }
function elide(s, n = 200) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ─── Signature verification (HMAC-SHA1 hex, fail-closed) ─────────────
// Mirrors vercel-drain.js verifySignature, but FAIL-CLOSED: no secret ⇒ reject.
// Returns { ok, code, reason }.
function verifySignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return { ok: false, code: 503, reason: 'secret not configured' };
  if (!signature) return { ok: false, code: 401, reason: 'missing signature' };
  let expected;
  try {
    expected = crypto.createHmac('sha1', WEBHOOK_SECRET).update(rawBody).digest('hex');
  } catch (err) {
    log('signature compute error:', err.message);
    return { ok: false, code: 401, reason: 'signature error' };
  }
  const a = Buffer.from(String(signature).toLowerCase(), 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 401, reason: 'invalid signature' };
  }
  return { ok: true };
}

// ─── Payload extraction ──────────────────────────────────────────────
// Vercel webhook shape (v1):
//   { id, type, createdAt, payload: { team, user, project:{id}, deployment:{...},
//     deploymentId, target, plan, regions, links:{deployment, project}, name, url } }
// Fields drift across event types/versions, so probe several locations.
function extractEvent(evt) {
  const type = evt && evt.type;
  const p = (evt && evt.payload) || {};
  const deployment = p.deployment || {};
  const meta = deployment.meta || p.meta || {};

  const projectId =
    (p.project && p.project.id) || deployment.projectId || p.projectId || null;

  // production | preview — present at payload.target and/or deployment.target.
  const target = p.target || deployment.target || meta.target || null;

  // sha: githubCommitSha (most common) → gitlab/bitbucket variants → generic.
  const sha =
    meta.githubCommitSha || meta.gitlabCommitSha || meta.bitbucketCommitSha ||
    meta.commitSha || deployment.sha || p.sha || null;
  const sha7 = sha ? String(sha).slice(0, 7) : 'unknown';

  // commit message subject (first line only, truncated).
  const rawMsg =
    meta.githubCommitMessage || meta.gitlabCommitMessage ||
    meta.bitbucketCommitMessage || meta.commitMessage || '';
  const commitMsg = rawMsg ? elide(String(rawMsg).split('\n')[0].trim(), 140) : '';

  // branch / ref.
  const ref =
    meta.githubCommitRef || meta.gitlabCommitRef || meta.bitbucketCommitRef ||
    deployment.meta?.branch || null;

  // inspector / alias URL for the human to click.
  const links = p.links || {};
  const inspectorUrl =
    links.deployment || deployment.inspectorUrl || deployment.url ||
    (p.url ? `https://${String(p.url).replace(/^https?:\/\//, '')}` : null) ||
    (deployment.url ? `https://${String(deployment.url).replace(/^https?:\/\//, '')}` : null) ||
    null;

  return {
    type, projectId, target, sha, sha7, commitMsg, ref, inspectorUrl,
    deploymentId: deployment.id || p.deploymentId || null,
  };
}

const RELEVANT_TYPES = new Set([
  'deployment.promoted',
  'deployment.error',
  'deployment.succeeded',
]);

/**
 * "This deployment is now serving production."
 *
 * Vercel OMITS `target` on `deployment.promoted` — observed null on 7/7 real
 * promotions between 2026-06-22 and 2026-07-11 — so a `target === 'production'`
 * test is never true for it. Two things were silently broken by that: the smoke
 * checklist never ran once, and every real production promotion was announced to
 * the team as "Deploy em preview".
 *
 * Preview deployments are never "promoted", so accept a missing target and only
 * reject an explicit preview (defensive, in case Vercel starts sending one).
 */
const isProductionPromotion = (e) =>
  e.type === 'deployment.promoted' && e.target !== 'preview';

// ─── Message formatting ──────────────────────────────────────────────
function formatMessage(e) {
  const isProd = e.target === 'production' || isProductionPromotion(e);
  const scope = isProd ? 'produção' : (e.target ? `preview (${e.target})` : 'preview');
  const lines = [];
  if (e.type === 'deployment.error') {
    lines.push(`🔴 Deploy FALHOU: ${e.sha7}`);
    lines.push(`Ambiente: ${scope}`);
  } else if (e.type === 'deployment.promoted') {
    lines.push(`🚀 Deploy em ${scope}: ${e.sha7}`);
  } else if (e.type === 'deployment.succeeded') {
    lines.push(`✅ Build concluído: ${e.sha7}`);
    lines.push(`Ambiente: ${scope}`);
  } else {
    lines.push(`ℹ️ ${e.type}: ${e.sha7}`);
  }
  if (e.commitMsg) lines.push(`"${e.commitMsg}"`);
  if (e.ref) lines.push(`Branch: ${e.ref}`);
  if (e.inspectorUrl) lines.push(e.inspectorUrl);
  return lines.join('\n');
}

// ─── Smoke checklist: changed files → "what to test manually" ────────
// Ordered most-specific → least; first matching rule per key wins (deduped).
// Tokens are chosen to avoid false positives (e.g. OCPP uses "charger"/"charging",
// never bare "charg", so "recharge" payment files don't read as charging).
const AREA_RULES = [
  { key: 'coupon',    re: /(coupon|cupom)/i,
    smoke: 'Cupom: aplicar um cupom e testar o limite por CPF (2ª vez no mesmo CPF deve barrar).' },
  { key: 'payments',  re: /(recharge|payment|pagar|pagarme|checkout|\bcredits?\b|nfse|invoice|settlement|payout|billing|tesouraria)/i,
    smoke: 'Pagamentos: 1 recarga real de baixo valor e confirmar crédito + recibo/NFSe.' },
  { key: 'pricing',   re: /(pricing|tariff|\bprice)/i,
    smoke: 'Preço: conferir a tarifa de 1 estação e um apply em lote (bulk).' },
  { key: 'ocpp',      re: /(ocpp|connector|charger|charging|stop-transaction|start-transaction|metervalue)/i,
    smoke: 'Carga: iniciar e parar 1 sessão num charger real e ver status + energia.' },
  { key: 'auth',      re: /(\bauth|\brole|permission|login|signin|\botp\b|account-link|access-scope|station-link)/i,
    smoke: 'Auth/permissão: logar como super-admin e como brand-admin (ZEV) e conferir visibilidade.' },
  { key: 'notify',    re: /(notif|whatsapp|\bpush\b|fcm|email|\bmail\b|campaign)/i,
    smoke: 'Notificações: disparar 1 do fluxo alterado e confirmar entrega.' },
  { key: 'rules',     re: /firestore\.rules/i,
    smoke: 'Firestore rules: telas que streamam doc direto ainda carregam (sem permission-denied).' },
  { key: 'cron',      re: /api\/cron\//i,
    smoke: 'Cron: conferir o próximo disparo e idempotência (rodar 2x não duplica).' },
  { key: 'mobile',    re: /^mobile\//i,
    smoke: 'App mobile: abrir, logar e navegar home + tela de carga.' },
  { key: 'dashboard', re: /^next\/app\/(dashboard|components)\//i,
    smoke: 'Dashboard: abrir a(s) página(s) alterada(s) sem erro de console/network.' },
  { key: 'api',       re: /^next\/app\/api\//i,
    smoke: 'API: exercitar a(s) rota(s) alterada(s) — 200 no caso feliz, 401/403 nos negados.' },
];

function deriveSmokeAreas(files) {
  const hits = [];
  for (const rule of AREA_RULES) {
    if (files.some((f) => rule.re.test(f))) hits.push(rule);
  }
  return hits;
}

function deterministicChecklist(areas) {
  if (!areas.length) {
    return ['Smoke geral: abrir as áreas tocadas neste deploy e checar console/network sem erro.'];
  }
  return areas.slice(0, SMOKE_MAX).map((a) => a.smoke);
}

// last-production-sha pointer (the diff base). Validated on read.
function readLastSha() {
  try {
    const s = fs.readFileSync(LAST_SHA_FILE, 'utf8').trim();
    return SHA_RE.test(s) ? s : null;
  } catch { return null; }
}
function writeLastSha(sha) {
  try { fs.writeFileSync(LAST_SHA_FILE, String(sha) + '\n', 'utf8'); }
  catch (e) { log('lastSha write failed:', e.message); }
}

// Changed files + commit subjects for prevSha..sha via gh (read-only, no checkout).
// Returns { files:[], commits:[] } or null. sha/prevSha must pass SHA_RE.
function fetchDiff(prevSha, sha) {
  if (!SHA_RE.test(String(sha || ''))) return null;
  const base = prevSha && SHA_RE.test(prevSha) ? prevSha : null;
  const env = { ...process.env, PATH: '/home/openclaw/.npm-global/bin:' + (process.env.PATH || '') };
  try {
    let out;
    if (base) {
      out = execFileSync('gh', ['api', `repos/${REPO_SLUG}/compare/${base}...${sha}`,
        '--jq', '{files: [.files[]?.filename], commits: [.commits[]?.commit.message | split("\n")[0]]}'],
        { timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 8 * 1024 * 1024 });
    } else {
      out = execFileSync('gh', ['api', `repos/${REPO_SLUG}/commits/${sha}`,
        '--jq', '{files: [.files[]?.filename], commits: [(.commit.message | split("\n")[0])]}'],
        { timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 8 * 1024 * 1024 });
    }
    const j = JSON.parse(out.toString());
    return { files: Array.isArray(j.files) ? j.files.filter(Boolean) : [],
             commits: Array.isArray(j.commits) ? j.commits.filter(Boolean) : [] };
  } catch (e) {
    log('smoke diff fetch failed:', e.message);
    return null;
  }
}

// Optional: phrase the checklist with a fast cloud LLM (openclaw agent).
// Sync execFileSync (relay already runs after the 200, off the response path).
// Returns string[] or null on any failure → caller falls back to deterministic.
function llmChecklist(commits, files, areas) {
  if (!ENABLE_SMOKE_LLM) return null;
  const env = { ...process.env, PATH: '/home/openclaw/.npm-global/bin:' + (process.env.PATH || '') };
  delete env.OPENCLAW_GATEWAY_URL; // CLI refuses the override without explicit creds; use its own config
  const prompt =
`Você é QA do Turbo Station (app de recarga de carro elétrico). Vai sair um deploy em PRODUÇÃO.
Com base nos commits e arquivos alterados abaixo, escreva uma checklist CURTA do que vale testar MANUALMENTE para pegar regressão.
Regras: pt-BR, no máximo ${SMOKE_MAX} itens, 1 linha cada, específico ao que mudou (não genérico). Priorize dinheiro/pagamento, carga (OCPP), auth e fluxos de usuário. Responda SOMENTE as linhas, cada uma começando com "- ".

Commits (${commits.length}):
${commits.slice(0, 40).map((c) => '- ' + c).join('\n')}

Áreas detectadas: ${areas.map((a) => a.key).join(', ') || 'nenhuma'}
Arquivos alterados (amostra):
${files.slice(0, 60).join('\n')}`;
  try {
    const out = execFileSync('openclaw', ['agent',
      '--session-id', SMOKE_LLM_SESSION, '--model', 'claude-cli/claude-opus-4-8',
      '--json', '--timeout', String(SMOKE_LLM_TIMEOUT), '-m', prompt],
      { timeout: (SMOKE_LLM_TIMEOUT + 15) * 1000, stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out.toString());
    const text = j && j.result && j.result.payloads && j.result.payloads[0] && j.result.payloads[0].text;
    if (!text) return null;
    const lines = String(text).split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-•*]/.test(l))
      .map((l) => l.replace(/^[-•*]+\s*/, '').trim())
      .filter(Boolean);
    return lines.length ? lines.slice(0, SMOKE_MAX) : null;
  } catch (e) {
    log('smoke llm failed:', e.message);
    return null;
  }
}

// Build the "what to test" block appended to a production deploy notice.
// Returns a string (header + bullets) or null when there's nothing to say.
async function buildSmokeChecklist(sha) {
  const prevSha = readLastSha();
  const diff = fetchDiff(prevSha, sha);
  // Advance the pointer regardless, so the next deploy diffs from this one even
  // if this build's diff/LLM hiccuped (avoids an ever-growing range).
  writeLastSha(sha);
  if (!diff || !diff.files.length) {
    log('smoke: no diff files (base=' + (prevSha || 'none') + ') — skipping checklist');
    return null;
  }
  const areas = deriveSmokeAreas(diff.files);
  let items = llmChecklist(diff.commits, diff.files, areas);
  const usedLlm = !!(items && items.length);
  if (!usedLlm) items = deterministicChecklist(areas);
  if (!items.length) return null;
  const baseNote = prevSha ? ` (mudou desde ${String(prevSha).slice(0, 7)})` : '';
  log(`smoke: ${items.length} item(s), ${areas.length} area(s), source=${usedLlm ? 'llm' : 'map'}`);
  return ['', `🧪 Vale testar manualmente${baseNote}:`, ...items.map((i) => '• ' + i)].join('\n');
}

// ─── Telegram relay (best-effort, never throws) ──────────────────────
// The `openclaw` CLI sends via its locally-configured gateway. If
// OPENCLAW_GATEWAY_URL is present in the env (it is, in the skill .env), the CLI
// refuses to use it without explicit --token/--password ("gateway url override
// requires explicit credentials"). We strip that override so the CLI falls back
// to its own openclaw.json gateway + creds, which is the path that actually
// delivers. PATH is pinned so the CLI is found under pm2.
function sendTelegram(msg) {
  try {
    const env = { ...process.env, PATH: '/home/openclaw/.npm-global/bin:' + (process.env.PATH || '') };
    delete env.OPENCLAW_GATEWAY_URL;
    execFileSync('openclaw', ['message', 'send', '--channel', 'telegram',
      '--target', DEPLOY_TELEGRAM_GROUP, '--message', msg],
      { timeout: 15000, stdio: 'pipe', env });
    log('telegram sent →', DEPLOY_TELEGRAM_GROUP);
    return true;
  } catch (e) {
    log('telegram send failed:', e.message);
    return false;
  }
}

// ─── WhatsApp relay via support-copilot (best-effort, never throws) ──
// Mirrors next/lib/services/whatsapp-notifier.ts postMessageToConversation:
//   POST /api/support/conversations/{id}/messages?brandId=<brand>
//   headers: x-api-secret, x-brand-id ; body: { body, source }
async function sendWhatsApp(text) {
  if (DRY_WHATSAPP) {
    log('[DRY_WHATSAPP] WOULD POST to group conv=' + ALERTS_CONVERSATION_ID + ':\n' + text);
    return { sent: false, dry: true };
  }
  if (!MONITOR_API_SECRET) {
    log('whatsapp relay skipped: MONITOR_API_SECRET unset');
    return { sent: false, reason: 'misconfigured' };
  }
  const url = new URL(
    `/api/support/conversations/${encodeURIComponent(ALERTS_CONVERSATION_ID)}/messages`,
    SUPPORT_BASE,
  );
  url.searchParams.set('brandId', ALERTS_BRAND);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-brand-id': ALERTS_BRAND,
        'x-api-secret': MONITOR_API_SECRET,
      },
      body: JSON.stringify({ body: text, source: MESSAGE_SOURCE }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`whatsapp relay POST ${res.status} conv=${ALERTS_CONVERSATION_ID}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    const json = await res.json().catch(() => null);
    log('whatsapp relay accepted, messageId=' + (json && json.id));
    return { sent: true, messageId: json && json.id };
  } catch (e) {
    log('whatsapp relay unreachable:', e.message);
    return { sent: false, reason: 'gateway_unavailable' };
  } finally {
    clearTimeout(t);
  }
}

// ─── Deploy-watch trigger (event-driven; no sha inference) ──

/**
 * Open the post-deploy watch window (T+0 announcement, +15min/+1h/+2h digests,
 * failure-spike alerts) for this deployment.
 *
 * Until now the ONLY caller of this endpoint was the polling trigger
 * (nextjs-deploy-trigger.js), which INFERS a deploy from a change in the sha
 * reported by /api/version. That inference is what opened a phantom 2h watch on
 * 2026-07-21 when /api/version blipped. Firing here instead means the window is
 * opened by the real Vercel event, carrying the real git sha from the payload.
 *
 * Fires on `deployment.promoted`, NOT on `deployment.succeeded`: succeeded only
 * means the build finished, and while production is pinned by an instant
 * rollback a new build can succeed WITHOUT ever being promoted. Promotion is the
 * moment production traffic actually moves — which is what the polling trigger
 * was approximating by watching the live /api/version.
 *
 * The endpoint is idempotent on the sha, so the polling trigger's later POST for
 * the same sha answers duplicate:true and does NOT re-announce — it stays a
 * harmless backstop for when this box misses a delivery. Best-effort: never
 * throws, runs after the 200.
 */
async function startDeployWatch(e) {
  if (!ENABLE_WATCH_START) return;
  if (!MONITOR_API_SECRET) {
    log('deploy-watch start skipped: MONITOR_API_SECRET unset');
    return;
  }
  // Same shape guard the endpoint's own trigger uses — never post a non-sha as a
  // watch id, which is exactly what the phantom watch was.
  if (!SHA_RE.test(String(e.sha || ''))) {
    log(`deploy-watch start skipped: payload sha not usable (${e.sha7})`);
    return;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${DASHBOARD_URL}/api/deploy-watch/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-secret': MONITOR_API_SECRET },
      body: JSON.stringify({
        sha: e.sha,
        deployedAt: new Date().toISOString(),
        environment: 'production',
      }),
      signal: ctrl.signal,
    });
    const txt = await r.text().catch(() => '');
    log(`deploy-watch start sha=${e.sha7} -> ${r.status} ${elide(txt, 160)}`);
  } catch (err) {
    log('deploy-watch start failed:', err && err.message);
  } finally {
    clearTimeout(t);
  }
}

// ─── Relay both channels (after the 200, never blocks the response) ──
async function relay(e) {
  let text = formatMessage(e);
  // On a PRODUCTION promotion, append a diff-derived manual smoke checklist.
  // Never blocks the 200 (relay runs in setImmediate) and never throws into it.
  if (ENABLE_SMOKE && isProductionPromotion(e) && SHA_RE.test(String(e.sha || ''))) {
    try {
      const block = await buildSmokeChecklist(e.sha);
      if (block) text += '\n' + block;
    } catch (err) { log('smoke checklist error:', err && err.message); }
  }
  log(`relaying ${e.type} sha=${e.sha7} target=${e.target}`);
  // WhatsApp-only (Telegram dropped per team decision 2026-06-22).
  await sendWhatsApp(text).catch(err => log('whatsapp relay threw:', err && err.message));
}

// ─── HTTP server ─────────────────────────────────────────────────────
function handle(req, res) {
  // Health check.
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/vercel-deploy-hook/health')) {
    // X-Service lets scripts/check-ports.js tell WHICH process owns this socket.
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Service': 'vercel-deploy-hook' });
    res.end(JSON.stringify({ ok: true, service: 'vercel-deploy-hook', secretConfigured: !!WEBHOOK_SECRET }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  if (req.url !== '/vercel-deploy-hook' && req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body = '';
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_PAYLOAD_SIZE) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('end', () => {
    if (aborted) return;

    // 1) Verify signature FIRST — fail closed.
    const sig = req.headers['x-vercel-signature'];
    const v = verifySignature(body, sig);
    if (!v.ok) {
      log(`reject (${v.code}): ${v.reason} from ${req.socket.remoteAddress}`);
      res.writeHead(v.code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: v.reason }));
      return;
    }

    // 2) Parse.
    let evt;
    try {
      evt = JSON.parse(body);
    } catch (err) {
      log('bad json:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    const e = extractEvent(evt);

    // 3) Ignore non-deploy events and other projects — but 200 so Vercel doesn't retry.
    if (!RELEVANT_TYPES.has(e.type)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ignored: 'event_type', type: e.type || null }));
      return;
    }
    if (e.projectId && e.projectId !== VERCEL_PROJECT_ID) {
      log(`ignored other project ${e.projectId} (${e.type})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ignored: 'other_project' }));
      return;
    }

    // 4) Respond 200 FAST, relay AFTER (best-effort) so a downstream hiccup never
    //    triggers a Vercel retry.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, type: e.type, sha: e.sha7, target: e.target }));

    setImmediate(() => {
      // Open the watch window on the real promotion event (see startDeployWatch).
      // Independent of the relay: a WhatsApp hiccup must not cost us the watch,
      // and a failed watch must not cost us the notification.
      if (isProductionPromotion(e)) {
        startDeployWatch(e).catch(err => log('deploy-watch start threw:', err && err.message));
      }
      relay(e).catch(err => log('relay error:', err && err.message));
    });
  });

  req.on('error', (err) => log('request error:', err.message));
}

// ─── Self-test (no WhatsApp group send) ──────────────────────────────
// Builds a locally-signed sample deployment.promoted payload, runs the full
// signature→parse→format path, asserts a wrong signature is rejected, and prints
// the formatted text for both promoted and error. Telegram is OPTIONAL (only
// when --telegram is passed) so the default self-test sends NOTHING anywhere.
function selftest() {
  const assert = (cond, msg) => { if (!cond) { console.error('SELFTEST FAIL:', msg); process.exit(1); } };
  const secret = WEBHOOK_SECRET || 'selftest-secret';
  // Temporarily ensure verifySignature has a secret to test the accept path.
  const savedSecret = process.env.VERCEL_WEBHOOK_SECRET;
  process.env.VERCEL_WEBHOOK_SECRET = secret;
  // Re-bind the module-level constant via a local verifier (WEBHOOK_SECRET was
  // captured at load; recompute here for the test).
  const sign = (raw) => crypto.createHmac('sha1', secret).update(raw).digest('hex');
  const localVerify = (raw, sig) => {
    if (!secret) return false;
    if (!sig) return false;
    const a = Buffer.from(String(sig).toLowerCase());
    const b = Buffer.from(sign(raw).toLowerCase());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const promoted = {
    id: 'evt_selftest_1', type: 'deployment.promoted', createdAt: Date.now(),
    payload: {
      project: { id: VERCEL_PROJECT_ID },
      target: 'production',
      deployment: {
        id: 'dpl_selftestabc', url: 'turbo-station-abc123.vercel.app',
        meta: {
          githubCommitSha: 'a4e4743f1234567890abcdef',
          githubCommitMessage: 'fix(deps): pin firebase-admin to ^13.8.0 to stop jose@6 ESM require crash',
          githubCommitRef: 'master',
        },
      },
      links: { deployment: 'https://vercel.com/turbo/turbo-station/dpl_selftestabc' },
    },
  };
  const errored = JSON.parse(JSON.stringify(promoted));
  errored.id = 'evt_selftest_2';
  errored.type = 'deployment.error';
  errored.payload.deployment.meta.githubCommitMessage = 'feat(thing): a change that failed to build';

  const rawP = JSON.stringify(promoted);
  const rawE = JSON.stringify(errored);

  // Accept correct signature.
  assert(localVerify(rawP, sign(rawP)) === true, 'correct signature should be accepted');
  // Reject wrong signature.
  assert(localVerify(rawP, sign(rawP + 'tamper')) === false, 'wrong signature must be rejected');
  // Reject missing signature.
  assert(localVerify(rawP, '') === false, 'missing signature must be rejected');

  const eP = extractEvent(promoted);
  const eE = extractEvent(errored);
  assert(eP.type === 'deployment.promoted', 'type parse promoted');
  assert(eP.sha7 === 'a4e4743', 'sha7 parse: got ' + eP.sha7);
  assert(eP.target === 'production', 'target parse');
  assert(eP.projectId === VERCEL_PROJECT_ID, 'project id parse');
  assert(RELEVANT_TYPES.has(eP.type), 'promoted is relevant');
  // Other-project event must be ignored.
  const other = JSON.parse(JSON.stringify(promoted));
  other.payload.project.id = 'prj_someone_else';
  const eO = extractEvent(other);
  assert(eO.projectId !== VERCEL_PROJECT_ID, 'other project detected');

  process.env.VERCEL_WEBHOOK_SECRET = savedSecret;

  console.log('\n===== SELFTEST: signature accept/reject =====');
  console.log('  correct signature  → ACCEPTED ✅');
  console.log('  tampered signature → REJECTED ✅');
  console.log('  missing signature  → REJECTED ✅');
  console.log('  other-project event → IGNORED ✅');
  console.log('\n===== Formatted WhatsApp/Telegram text (deployment.promoted, production) =====');
  console.log(formatMessage(eP));
  console.log('\n===== Formatted WhatsApp/Telegram text (deployment.error) =====');
  console.log(formatMessage(eE));

  // ── Smoke-checklist derivation (offline: no gh / no LLM) ──
  const sampleFiles = [
    'next/app/api/recharge/stop-transaction/route.ts',
    'next/lib/services/coupon.ts',
    'mobile/lib/checkout/checkout_store.dart',
    'ocpp_server/handlers/start_transaction.py',
    'next/app/dashboard/settings/page.tsx',
    'firestore.rules',
    'docs/internal/architecture/recharge.md',
  ];
  const sAreas = deriveSmokeAreas(sampleFiles);
  const sKeys = sAreas.map((a) => a.key);
  assert(sKeys.includes('payments'), 'smoke: payments area from recharge route');
  assert(sKeys.includes('coupon'), 'smoke: coupon area detected');
  assert(sKeys.includes('ocpp'), 'smoke: ocpp area from start_transaction');
  assert(sKeys.includes('mobile'), 'smoke: mobile area detected');
  assert(sKeys.includes('rules'), 'smoke: firestore.rules detected');
  // "recharge" must NOT be misread as charging (no bare "charg" token).
  assert(deriveSmokeAreas(['next/app/api/recharge/route.ts']).map((a) => a.key).indexOf('ocpp') === -1,
    'smoke: recharge is NOT tagged ocpp');
  const sList = deterministicChecklist(sAreas);
  assert(sList.length > 0 && sList.length <= SMOKE_MAX, 'smoke: checklist non-empty & capped');
  assert(deterministicChecklist([]).length === 1, 'smoke: empty areas → single generic fallback');
  assert(readLastSha === readLastSha && SHA_RE.test('a4e4743'), 'smoke: SHA_RE accepts short sha');
  assert(!SHA_RE.test('a4e4743; rm -rf /'), 'smoke: SHA_RE rejects injection');

  console.log('\n===== SELFTEST: smoke-checklist derivation (offline) =====');
  console.log('  areas detected:', sKeys.join(', '));
  console.log('  deterministic checklist:');
  console.log(sList.map((i) => '    • ' + i).join('\n'));
  console.log('  recharge-only → ocpp excluded ✅, injection sha rejected ✅');

  console.log('\n(no message was sent to WhatsApp; default self-test sends nothing)');

  if (process.argv.includes('--telegram')) {
    const line = '🧪 [vercel-deploy-hook] selftest — Telegram path OK (' + new Date().toISOString() + '). Ignore.';
    console.log('\nSending ONE test line to TELEGRAM only (safe channel)…');
    const ok = sendTelegram(line);
    console.log(ok ? 'Telegram test line sent ✅' : 'Telegram test line FAILED ❌');
  }
  console.log('\nSELFTEST PASSED ✅');
  process.exit(0);
}

// ─── Smoke preview (live gh + LLM, NO WhatsApp, does NOT touch the pointer) ──
// Usage: node vercel-deploy-hook.js --smoke-preview --head <sha> [--base <sha>]
// Exercises the real diff + checklist path for debugging without side effects.
function smokePreview() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const head = arg('--head');
  const base = arg('--base');
  if (!head || !SHA_RE.test(head)) {
    console.error('smoke-preview: pass --head <sha> (40/7-hex). Optional --base <sha>.');
    process.exit(1);
  }
  console.log(`[smoke-preview] base=${base || '(none)'} head=${head} repo=${REPO_SLUG}`);
  const diff = fetchDiff(base, head);
  if (!diff) { console.error('smoke-preview: diff fetch failed'); process.exit(1); }
  console.log(`[smoke-preview] ${diff.files.length} files, ${diff.commits.length} commits`);
  const areas = deriveSmokeAreas(diff.files);
  console.log('[smoke-preview] areas:', areas.map((a) => a.key).join(', ') || '(none)');
  console.log('\n----- deterministic checklist -----');
  console.log(deterministicChecklist(areas).map((i) => '• ' + i).join('\n'));
  console.log('\n----- LLM checklist (live openclaw agent) -----');
  const llm = llmChecklist(diff.commits, diff.files, areas);
  console.log(llm ? llm.map((i) => '• ' + i).join('\n') : '(LLM unavailable — would fall back to deterministic)');
  process.exit(0);
}

// ─── Main ────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  selftest();
} else if (process.argv.includes('--smoke-preview')) {
  smokePreview();
} else {
  const server = http.createServer(handle);
  process.on('SIGTERM', () => { log('SIGTERM — closing'); server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { log('SIGINT — closing'); server.close(() => process.exit(0)); });
  // Loopback bind only — nginx is the sole public entry.
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${PORT}`);
    log(`endpoint: POST /vercel-deploy-hook  health: GET /health`);
    log(`signature verification: ${WEBHOOK_SECRET ? 'ENABLED' : 'DISABLED (fail-closed — all events rejected 503)'}`);
    log(`project filter: ${VERCEL_PROJECT_ID}`);
    log(`whatsapp: ${DRY_WHATSAPP ? 'DRY (logs only)' : 'support-copilot ' + SUPPORT_BASE + ' conv=' + ALERTS_CONVERSATION_ID}`);
    log(`telegram: ${DEPLOY_TELEGRAM_GROUP}`);
    log(`smoke checklist: ${ENABLE_SMOKE ? 'ON' : 'OFF'} (prod promotions only; llm=${ENABLE_SMOKE_LLM ? 'on' : 'off'}; repo=${REPO_SLUG}; base-file=${LAST_SHA_FILE})`);
  });
}
