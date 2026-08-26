#!/usr/bin/env node
/**
 * auto-rollback-watchdog.js — External 5xx auto-rollback watchdog for the
 * Turbo Station Vercel PRODUCTION deploy.
 *
 *   *** SHADOW MODE BY DEFAULT — DETECT + ALERT ONLY, NEVER ACTS ***
 *
 * Motivating incident (2026-06-22 ~02:34Z): production deploy a4e4743 crashed
 * EVERY route with HTTP 500 for ~19 min (firebase-admin@14 -> jose@6 ESM
 * `require` crash that compiled clean). No automated alert fired; a human
 * rolled back to the previous good deploy (8b92330) ~20 min later.
 *
 * This watchdog reads the EXTERNAL real-time Vercel log feed (db/vercel.db,
 * ingested by the `vercel-drain` pm2 service — keeps working even when the app
 * is fully down) and, when a FRESH deploy goes universally-5xx, would (once
 * armed) roll back to the last-known-good deployment. It ships in SHADOW MODE:
 * it only sends a Telegram "WOULD roll back" alert and logs the decision.
 *
 * The actuator (rollbackToTarget) is DORMANT by default. A direct action needs
 * the explicit catastrophic-auto rollout phase, ROLLBACK_DIRECT_ENABLE=1, the
 * default-OFF kill switch, a Vercel token, deterministic policy eligibility,
 * a strict candidate smoke, and an exact release-safety attestation. Human
 * approval is accepted only as a release-bound, short-lived, one-time receipt
 * from a trusted personal WhatsApp ingress. An LLM never authorizes or calls it.
 * A hard-stop file `<skill>/auto-rollback.disabled` overrides everything.
 *
 * Run:
 *   node services/auto-rollback-watchdog.js            # one detector tick
 *   node services/auto-rollback-watchdog.js --loop     # poll forever (pm2 mode)
 *   node services/auto-rollback-watchdog.js --status    # print state
 *   node services/auto-rollback-watchdog.js --replay <ISO> [--end <ISO>] [--cutover <ISO>]
 *                                                       # offline replay over a DB window
 *   node services/auto-rollback-watchdog.js --dry-telegram   # print alerts, never send
 *
 * Security notes (OWASP/LGPD):
 *   - Read-only against vercel.db; no PII is read or logged (only endpoint
 *     paths + status codes + counts). No request bodies are surfaced.
 *   - Secrets (VERCEL_ROLLBACK_TOKEN) are read from env only, never logged.
 *   - The actuator is gated by a default-OFF kill switch + token presence +
 *     a hard-stop file; shadow mode is the safe default.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROLLOUT_PHASE,
  RECOMMENDATION,
  ACTION,
  normalizeEndpoint,
  normalizeRolloutPhase,
  assessRollback,
  createApprovalProposal,
  validateApprovalConfirmation,
  consumeApprovalProposal,
} = require('./lib/auto-rollback-policy');

// ─── Paths ──────────────────────────────────────────────────────────
const SKILL_DIR = path.join(__dirname, '..');                 // turbo-station-monitor/
const DB_PATH = path.join(SKILL_DIR, 'db', 'vercel.db');
const STATE_PATH = path.join(SKILL_DIR, 'deploy-rollback-state.json');
const DECISION_LOG = path.join(SKILL_DIR, 'logs', 'auto-rollback-decisions.log');
const ENABLE_FLAG = path.join(SKILL_DIR, 'auto-rollback.enabled');   // local kill-switch ON
const DISABLE_FLAG = path.join(SKILL_DIR, 'auto-rollback.disabled'); // local hard-stop
const FIREBASE_SA = '/home/openclaw/.openclaw/credentials/firebase-prod-sa.json'; // prod SA (not present today)

let Database;
try { Database = require('better-sqlite3'); }
catch { Database = require(path.join(SKILL_DIR, 'node_modules', 'better-sqlite3')); }

// ─── Config / thresholds ────────────────────────────────────────────
const BASE = (process.env.DASHBOARD_URL || 'https://www.turbostation.com.br').replace(/\/+$/, '');

const POLL_INTERVAL_MS = Number(process.env.ROLLBACK_POLL_MS || 30 * 1000); // detector cadence
const WINDOW_MS = Number(process.env.ROLLBACK_WINDOW_MS || 90 * 1000);      // rolling detection window
const HEIGHTENED_WINDOW_MS = Number(process.env.ROLLBACK_HEIGHTENED_MS || 10 * 60 * 1000); // watch first 10 min after cutover
const PRE_CUTOVER_WINDOW_MS = 5 * 60 * 1000;                                // baseline window before cutover
const ROLLBACK_ROLLOUT_PHASE = normalizeRolloutPhase(process.env.ROLLBACK_ROLLOUT_PHASE);
const DIRECT_ROLLBACK_ENABLED = process.env.ROLLBACK_DIRECT_ENABLE === '1';
const RELEASE_SAFETY_PATH = process.env.ROLLBACK_RELEASE_SAFETY_PATH || '';

// Guardrails (actuator only — dormant in shadow mode)
const ANTI_FLAP_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between rollback actions
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'prj_dptfUFsPBJ9yg0xVC9Ga05I0eU5m';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || 'team_rIUM7bY14PxLkKmAkVNUUvnu';

// ─── Logging ────────────────────────────────────────────────────────
function log(...a) { console.log(new Date().toISOString(), '[auto-rollback]', ...a); }
function decisionLog(obj) {
  try {
    fs.mkdirSync(path.dirname(DECISION_LOG), { recursive: true });
    fs.appendFileSync(DECISION_LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch (e) { log('decisionLog write failed:', e.message); }
}

// ─── State ──────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch {
    return {
      currentSha: null,        // last seen live sha
      deployStartMs: 0,        // cutover ms of currentSha
      newSha: null,            // sha that went live at cutover
      prevSha: null,           // KNOWN-GOOD rollback target (the sha live BEFORE cutover)
      seeded: false,
      actedForSha: null,       // at-most-once-per-deploy guard
      lastActionMs: 0,         // anti-flap cooldown anchor
      lastActionStatus: null,
      lastShadowAlertSha: null, // don't spam shadow alerts for the same bad deploy
      lastBlockedAlertKey: null,
      pendingProposal: null,
      pendingConfirmation: null,
    };
  }
}
function saveState(s) {
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

// ─── Alerts → team WhatsApp group via the support-copilot relay ──────────────
// Telegram dropped per team decision 2026-06-22; every alert now goes to the
// WhatsApp alerts group through support-copilot (POST /api/support/conversations/
// {id}/messages) — the same path next/lib/services/whatsapp-notifier.ts uses.
const SUPPORT_BASE = process.env.SUPPORT_API_BASE || 'http://127.0.0.1:3005';
const MONITOR_API_SECRET = process.env.MONITOR_API_SECRET || process.env.SUPPORT_API_SECRET || '';
const ALERTS_CONVERSATION_ID = process.env.DEPLOY_HOOK_ALERTS_CONV || 'conv_jiuijxjtmnet23i9';
const ALERTS_BRAND = process.env.DEPLOY_WATCH_ALERTS_BRAND || 'turbo_station';
const PERSONAL_APPROVAL_CONVERSATION_ID = process.env.ROLLBACK_PERSONAL_CONVERSATION_ID || '';
const PERSONAL_APPROVER_JID = process.env.ROLLBACK_PERSONAL_APPROVER_JID || '';
const ALLOWED_APPROVER_IDS = (process.env.ROLLBACK_ALLOWED_APPROVER_IDS || '')
  .split(',').map(v => v.trim()).filter(Boolean);
let DRY_TELEGRAM = false; // dry-run toggle (set by --dry-telegram): log instead of send
async function sendWhatsAppToConversation(text, conversationId) {
  if (DRY_TELEGRAM) { log('[dry-send] WOULD WhatsApp:\n' + text); return true; }
  if (!MONITOR_API_SECRET) { log('whatsapp relay skipped: MONITOR_API_SECRET unset'); return false; }
  if (!conversationId) { log('whatsapp relay skipped: conversation id unset'); return false; }
  const url = new URL(`/api/support/conversations/${encodeURIComponent(conversationId)}/messages`, SUPPORT_BASE);
  url.searchParams.set('brandId', ALERTS_BRAND);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-brand-id': ALERTS_BRAND, 'x-api-secret': MONITOR_API_SECRET },
      body: JSON.stringify({ body: text, source: 'auto-rollback-watchdog' }),
      signal: controller.signal,
    });
    if (!res.ok) { log(`whatsapp relay POST ${res.status} conv=${conversationId}`); return false; }
    log('whatsapp relay accepted'); return true;
  } catch (e) { log('whatsapp relay unreachable:', e.message); return false; }
  finally { clearTimeout(t); }
}

async function sendWhatsApp(text) {
  return sendWhatsAppToConversation(text, ALERTS_CONVERSATION_ID);
}

function personalApprovalDestinationValid() {
  return Boolean(
    PERSONAL_APPROVAL_CONVERSATION_ID &&
    PERSONAL_APPROVAL_CONVERSATION_ID !== ALERTS_CONVERSATION_ID &&
    PERSONAL_APPROVER_JID.endsWith('@s.whatsapp.net') &&
    !PERSONAL_APPROVER_JID.endsWith('@g.us') &&
    ALLOWED_APPROVER_IDS.includes(PERSONAL_APPROVER_JID)
  );
}

async function sendApprovalProposal(text) {
  if (!personalApprovalDestinationValid()) {
    log('approval proposal blocked: personal WhatsApp allowlist is incomplete or points to the alerts conversation');
    return false;
  }
  return sendWhatsAppToConversation(text, PERSONAL_APPROVAL_CONVERSATION_ID);
}

// ─── Deploy detection (poll /api/version, like nextjs-deploy-trigger.js) ──────
async function currentSha() {
  try {
    const r = await fetch(`${BASE}/api/version`, { method: 'GET', redirect: 'manual' });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const sha = j && (j.sha || j.commit || j.gitCommitSha);
      if (sha && String(sha).length >= 4 && String(sha) !== 'unknown') return String(sha);
    }
  } catch { /* app may be down — that itself is a signal, handled by the 5xx feed */ }
  return null;
}

// ─── Metrics from vercel.db (read-only) ──────────────────────────────
function normalizeRouteRows(rows) {
  const byRoute = new Map();
  for (const row of rows || []) {
    const endpoint = normalizeEndpoint(row.endpoint);
    if (!endpoint) continue;
    const merged = byRoute.get(endpoint) || {
      endpoint, total: 0, c5xx: 0, success: 0, first5xxMs: null, last5xxMs: null,
    };
    merged.total += Number(row.total || 0);
    merged.c5xx += Number(row.c5xx || 0);
    merged.success += Number(row.success || 0);
    if (row.first5xxMs != null) {
      merged.first5xxMs = merged.first5xxMs == null
        ? Number(row.first5xxMs)
        : Math.min(merged.first5xxMs, Number(row.first5xxMs));
    }
    if (row.last5xxMs != null) {
      merged.last5xxMs = merged.last5xxMs == null
        ? Number(row.last5xxMs)
        : Math.max(merged.last5xxMs, Number(row.last5xxMs));
    }
    byRoute.set(endpoint, merged);
  }
  return [...byRoute.values()];
}

function normalizeEndpointCounts(rows) {
  const byRoute = new Map();
  for (const row of rows || []) {
    const endpoint = normalizeEndpoint(row.endpoint);
    if (!endpoint) continue;
    byRoute.set(endpoint, (byRoute.get(endpoint) || 0) + Number(row.c || 0));
  }
  return [...byRoute.entries()]
    .map(([endpoint, c]) => ({ endpoint, c }))
    .sort((a, b) => b.c - a.c);
}

function queryWindow(db, fromMs, toMs) {
  const total = db.prepare(
    'SELECT COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code IS NOT NULL'
  ).get(fromMs, toMs).c;
  const c5xx = db.prepare(
    'SELECT COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code>=500'
  ).get(fromMs, toMs).c;
  const rawEndpoints = db.prepare(
    'SELECT endpoint, COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code>=500 ' +
    'AND endpoint IS NOT NULL GROUP BY endpoint ORDER BY c DESC'
  ).all(fromMs, toMs);
  // /api/version specific: count 200 vs (500 or null) to detect "version endpoint broken/flipping"
  const verRows = db.prepare(
    "SELECT status_code, COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? " +
    "AND endpoint LIKE '%/api/version%' GROUP BY status_code"
  ).all(fromMs, toMs);
  const rawRouteRows = db.prepare(
    'SELECT endpoint, COUNT(*) total, ' +
    'SUM(CASE WHEN status_code>=500 THEN 1 ELSE 0 END) c5xx, ' +
    'SUM(CASE WHEN status_code>=200 AND status_code<400 THEN 1 ELSE 0 END) success, ' +
    'MIN(CASE WHEN status_code>=500 THEN timestamp ELSE NULL END) first5xxMs, ' +
    'MAX(CASE WHEN status_code>=500 THEN timestamp ELSE NULL END) last5xxMs ' +
    'FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code IS NOT NULL ' +
    'AND endpoint IS NOT NULL GROUP BY endpoint'
  ).all(fromMs, toMs);
  const endpoints = normalizeEndpointCounts(rawEndpoints);
  const routeRows = normalizeRouteRows(rawRouteRows);
  return { total, c5xx, ratio: total ? c5xx / total : 0, endpoints, verRows, routeRows };
}

function versionHealth(verRows) {
  let ok = 0, bad = 0;
  for (const r of verRows) {
    if (r.status_code === 200) ok += r.c;
    else if (r.status_code === null || r.status_code >= 500) bad += r.c;
  }
  return { ok, bad, broken: bad > 0 && bad >= ok }; // broken/flipping if >=half of version hits are bad
}

// ─── The core detector + attribution test ────────────────────────────
// The policy is deterministic. An optional intelligent agent may summarize the
// evidence, but its output is never an input to action authorization.
function evaluate(db, nowMs, state, readiness = {}) {
  const winFrom = state.deployStartMs
    ? Math.max(nowMs - WINDOW_MS, state.deployStartMs)
    : nowMs - WINDOW_MS;
  const m = queryWindow(db, winFrom, nowMs);
  const pre = state.deployStartMs
    ? queryWindow(db, state.deployStartMs - PRE_CUTOVER_WINDOW_MS, state.deployStartMs)
    : { total: 0, c5xx: 0, ratio: 0, routeRows: [] };
  const vh = versionHealth(m.verRows);
  const policy = assessRollback({
    nowMs,
    rolloutPhase: ROLLBACK_ROLLOUT_PHASE,
    deploy: {
      newSha: state.newSha,
      previousSha: state.prevSha,
      currentSha: state.currentSha,
      cutoverMs: state.deployStartMs,
    },
    baseline: pre.routeRows || [],
    post: m.routeRows || [],
    aggregate: { total: m.total, c5xx: m.c5xx, distinct5xxEndpoints: m.endpoints.length },
    rollbackCandidate: readiness.rollbackCandidate || {},
    changeSafety: readiness.changeSafety || {},
    guardrails: readiness.guardrails || {},
  });

  return {
    ...policy,
    critical: policy.recommendation !== RECOMMENDATION.OBSERVE,
    attributed: policy.recommendation === RECOMMENDATION.ROLLBACK_RECOMMENDED,
    evidence: {
      windowSec: Math.round(WINDOW_MS / 1000),
      total: m.total,
      c5xx: m.c5xx,
      ratio: Number(m.ratio.toFixed(3)),
      distinctEndpoints: m.endpoints.length,
      topEndpoints: m.endpoints.slice(0, 8).map(e => `${e.endpoint} (${e.c})`),
      preCutoverRatio: Number(pre.ratio.toFixed(3)),
      preCutover5xx: pre.c5xx,
      versionHealth: vh,
      routeClasses: (m.routeRows || [])
        .filter(row => Number(row.c5xx || 0) > 0)
        .slice(0, 12)
        .map(row => ({ endpoint: row.endpoint, c5xx: row.c5xx, total: row.total })),
    },
  };
}

// ─── Kill-switch resolution (default OFF; shadow mode wins on any ambiguity) ──
function killSwitchOn() {
  // Hard stop overrides everything.
  if (fs.existsSync(DISABLE_FLAG)) return { on: false, source: 'hard-stop file present', hardStop: true };
  // Prefer prod Firestore feature_flags/auto_rollback if a prod SA + firebase-admin are available.
  try {
    if (fs.existsSync(FIREBASE_SA)) {
      // eslint-disable-next-line global-require
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(require(FIREBASE_SA)) });
      }
      // NOTE: synchronous resolution is not possible here; the loop awaits this in armed mode.
      return { on: 'firestore-deferred', source: 'prod firestore (deferred)', admin };
    }
  } catch (e) { log('firestore kill-switch check failed (falling back to file):', e.message); }
  // Local file fallback — must EXIST to arm.
  if (fs.existsSync(ENABLE_FLAG)) return { on: true, source: 'local enable file' };
  return { on: false, source: 'default OFF (no enable file, no prod SA)' };
}

async function resolveFirestoreFlag(admin) {
  try {
    const snap = await admin.firestore().doc('feature_flags/auto_rollback').get();
    if (!snap.exists) return { on: false, source: 'firestore doc missing (default OFF)' };
    const d = snap.data() || {};
    return { on: d.enabled === true, source: `firestore enabled=${d.enabled === true}`, disabledReason: d.disabledReason };
  } catch (e) { return { on: false, source: 'firestore read failed (default OFF): ' + e.message }; }
}

// ════════════════════════════════════════════════════════════════════
// ACTUATOR — fully written, DORMANT. Only ever runs when BOTH the kill
// switch is ON and VERCEL_ROLLBACK_TOKEN is set. NEVER reached in shadow mode.
// ════════════════════════════════════════════════════════════════════
async function vercelFetch(pathname, opts = {}) {
  const token = process.env.VERCEL_ROLLBACK_TOKEN;
  if (!token) throw new Error('VERCEL_ROLLBACK_TOKEN unset — actuator must no-op');
  const sep = pathname.includes('?') ? '&' : '?';
  const url = `${VERCEL_API}${pathname}${sep}teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vercel API ${r.status} ${pathname}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// Select rollback target: newest READY isRollbackCandidate prod deployment whose
// meta.githubCommitSha == capturedPrevSha. Smoke its URL before returning.
async function selectRollbackTarget(prevSha) {
  const data = await vercelFetch(
    `/v7/deployments?projectId=${encodeURIComponent(VERCEL_PROJECT_ID)}&target=production&limit=40`);
  const deployments = data.deployments || [];
  // The captured known-good sha (live before cutover) is authoritative. Match it among
  // successfully-built production deployments; isRollbackCandidate is only a PREFERENCE
  // (its semantics vary across the API), never a hard exclusion that could drop the target.
  const built = deployments.filter(d =>
    d.state === 'READY' || d.readySubstate === 'PROMOTED' || d.readyState === 'READY');
  const matches = built.filter(d => {
    const sha = (d.meta && d.meta.githubCommitSha) || '';
    return sha && (sha.startsWith(prevSha) || prevSha.startsWith(sha));
  });
  let target = matches.find(d => d.isRollbackCandidate === true) || matches[0];
  if (!target) return { target: null, reason: `no READY production deployment matches known-good sha ${prevSha}` };
  // Smoke the candidate's own URL before trusting it. Any inaccessible, non-200,
  // malformed, or SHA-mismatched response is inconclusive and therefore blocks
  // rollback. A post-action smoke must never be the first proof of target health.
  const smokeUrl = target.url ? (target.url.startsWith('http') ? target.url : `https://${target.url}`) : null;
  if (!smokeUrl) return { target: null, reason: `target ${target.uid} has no smokeable deployment URL` };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  try {
    const r = await fetch(`${smokeUrl}/api/version`, { method: 'GET', redirect: 'manual', headers });
    if (r.status !== 200) {
      return { target: null, reason: `target ${target.uid} smoke is inconclusive (${r.status}); exact HTTP 200 is required` };
    }
    const body = await r.json().catch(() => null);
    const smokeSha = body && String(body.sha || body.commit || body.gitCommitSha || '');
    if (!smokeSha || !(smokeSha.startsWith(prevSha) || prevSha.startsWith(smokeSha))) {
      return { target: null, reason: `target ${target.uid} smoke SHA does not match captured previous SHA` };
    }
    return { target, reason: 'ok', smokeStatus: r.status, smokeSha };
  } catch (e) {
    return { target: null, reason: `target ${target.uid} smoke failed closed: ${e.message}` };
  }
}

function loadReleaseSafetyAttestation(state, nowMs = Date.now()) {
  const blocked = {
    candidateConfirmed: false,
    noExternalDependency: false,
    noFinancialAmbiguity: false,
    noIrreversibleActivation: false,
    noMigration: false,
    noRuntimeFlagChange: false,
  };
  if (!RELEASE_SAFETY_PATH) return blocked;
  try {
    const data = JSON.parse(fs.readFileSync(RELEASE_SAFETY_PATH, 'utf8'));
    const createdAtMs = Date.parse(data.createdAt || '');
    const exactRelease = data.releaseSha === state.newSha && data.previousSha === state.prevSha;
    const fresh = Number.isFinite(createdAtMs) && createdAtMs <= nowMs && nowMs - createdAtMs <= HEIGHTENED_WINDOW_MS;
    if (!exactRelease || !fresh) return blocked;
    return {
      candidateConfirmed: data.candidateConfirmed === true,
      noExternalDependency: data.noExternalDependency === true,
      noFinancialAmbiguity: data.noFinancialAmbiguity === true,
      noIrreversibleActivation: data.noIrreversibleActivation === true,
      noMigration: data.noMigration === true,
      noRuntimeFlagChange: data.noRuntimeFlagChange === true,
    };
  } catch (e) {
    log('release safety attestation failed closed:', e.message);
    return blocked;
  }
}

async function resolveKillSwitch() {
  const ks = killSwitchOn();
  if (ks.on === 'firestore-deferred') return resolveFirestoreFlag(ks.admin);
  return ks;
}

async function buildReadiness(state, nowMs = Date.now()) {
  const ks = await resolveKillSwitch();
  let selection = { target: null, reason: 'VERCEL_ROLLBACK_TOKEN unset; previous candidate cannot be verified' };
  if (process.env.VERCEL_ROLLBACK_TOKEN && state.prevSha) {
    try { selection = await selectRollbackTarget(state.prevSha); }
    catch (e) { selection = { target: null, reason: `rollback candidate lookup failed closed: ${e.message}` }; }
  }
  return {
    selection,
    ks,
    rollbackCandidate: {
      ready: Boolean(selection.target),
      shaMatches: Boolean(selection.target),
      smokeVerified: Boolean(selection.target && selection.smokeStatus === 200 && selection.smokeSha),
      smokeStatus: selection.smokeStatus || null,
      smokeSha: selection.smokeSha || null,
    },
    changeSafety: loadReleaseSafetyAttestation(state, nowMs),
    guardrails: {
      killSwitchAllows: ks.on === true && DIRECT_ROLLBACK_ENABLED,
      dedupeAvailable: true,
      alreadyActedForRelease: state.actedForSha === state.newSha,
      cooldownElapsed: nowMs - (state.lastActionMs || 0) >= ANTI_FLAP_COOLDOWN_MS,
    },
  };
}

// DORMANT actuator. Returns a result object; PAGES on every branch.
async function rollbackToTarget(state, evalResult, authorization, selectedTarget) {
  if (!authorization || !['deterministic-policy', 'trusted-human-confirmation'].includes(authorization.kind)) {
    return { acted: false, reason: 'missing trusted rollback authorization' };
  }
  if (authorization.kind === 'deterministic-policy' &&
      (ROLLBACK_ROLLOUT_PHASE !== ROLLOUT_PHASE.CATASTROPHIC_AUTO || !DIRECT_ROLLBACK_ENABLED ||
       evalResult.action !== ACTION.DIRECT_ROLLBACK_PERMITTED)) {
    return { acted: false, reason: 'direct rollback phase or deterministic eligibility is not active' };
  }
  // ── Guardrail: hard stop ──
  if (fs.existsSync(DISABLE_FLAG)) { await sendWhatsApp('🛑 auto-rollback ABORTED: hard-stop file present'); return { acted: false, reason: 'hard-stop' }; }
  // ── Guardrail: token must be present ──
  if (!process.env.VERCEL_ROLLBACK_TOKEN) return { acted: false, reason: 'no VERCEL_ROLLBACK_TOKEN (shadow)' };
  // ── Guardrail: at-most-once per deploy ──
  if (state.actedForSha === state.newSha) return { acted: false, reason: 'already acted for this deploy' };
  // ── Guardrail: anti-flap cooldown ──
  if (Date.now() - (state.lastActionMs || 0) < ANTI_FLAP_COOLDOWN_MS) {
    await sendWhatsApp('⏳ auto-rollback in cooldown — skipping action'); return { acted: false, reason: 'cooldown' };
  }
  // ── Need a known-good target ──
  if (!state.prevSha) { await sendWhatsApp('🚨 auto-rollback: no known-good prevSha captured — manual rollback required'); return { acted: false, reason: 'no prevSha' }; }

  const sel = selectedTarget ? { target: selectedTarget, reason: 'pre-verified' } : await selectRollbackTarget(state.prevSha);
  if (!sel.target) {
    await sendWhatsApp(`🚨 auto-rollback ABORTED: ${sel.reason} — MANUAL ROLLBACK REQUIRED for bad deploy ${state.newSha}`);
    return { acted: false, reason: sel.reason };
  }

  // Consume the per-release action before the external side effect. A crash or
  // ambiguous network response must require investigation, never a blind retry.
  state.actedForSha = state.newSha;
  state.lastActionMs = Date.now();
  state.lastActionStatus = 'issuing';
  saveState(state);

  // ── Execute the rollback (the only place the Vercel rollback API is called) ──
  await sendWhatsApp(`🔴 AUTO-ROLLBACK EXECUTING: prod ${state.newSha} -> ${state.prevSha} (deployment ${sel.target.uid})`);
  try {
    await vercelFetch(`/v1/projects/${VERCEL_PROJECT_ID}/rollback/${sel.target.uid}`, { method: 'POST' });
  } catch (e) {
    state.lastActionStatus = 'issuance-unknown';
    saveState(state);
    await sendWhatsApp(`⚠️ AUTO-ROLLBACK não pôde ser confirmado após a chamada à Vercel para ${state.newSha}. ` +
      'A tentativa foi consumida e não será repetida automaticamente. INVESTIGAR.');
    return { acted: false, ambiguous: true, reason: e.message };
  }

  // ── Poll for completion (current sha should flip back to prevSha) ──
  let flipped = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const live = await currentSha();
    if (live && state.prevSha.startsWith(live.slice(0, 7))) { flipped = true; break; }
    if (live && live.startsWith(state.prevSha.slice(0, 7))) { flipped = true; break; }
  }

  // ── Re-smoke prod ──
  let prodOk = false;
  try { const r = await fetch(`${BASE}/api/version`, { redirect: 'manual' }); prodOk = r.ok; } catch { /* */ }

  state.lastActionStatus = prodOk && flipped ? 'confirmed' : 'issued-unverified';
  saveState(state);

  await sendWhatsApp(prodOk && flipped
    ? `✅ AUTO-ROLLBACK COMPLETE: prod restored to ${state.prevSha} and /api/version is 200`
    : `⚠️ AUTO-ROLLBACK issued but prod NOT confirmed healthy (flipped=${flipped} smoke=${prodOk}) — INVESTIGATE`);
  return { acted: true, target: sel.target.uid, prodOk, flipped };
}

function reasonString(ev) {
  const e = ev.evidence || {};
  return `class=${ev.failureClass}; 5xx ${e.c5xx || 0}/${e.total || 0} (${Math.round((e.ratio || 0) * 100)}%) over ${e.windowSec || 0}s; ` +
    `top=${(e.topEndpoints || []).slice(0, 4).join(', ') || 'none'}; reasons=${(ev.reasons || []).join('; ')}`;
}

function rollbackIsReversible(readiness) {
  const safety = readiness.changeSafety || {};
  return safety.noIrreversibleActivation === true && safety.noMigration === true && safety.noRuntimeFlagChange === true;
}

function readinessBlocksBeforeAction(rolloutPhase, readiness = {}) {
  if (normalizeRolloutPhase(rolloutPhase) === ROLLOUT_PHASE.SHADOW) return false;
  return !readiness.selection?.target || !rollbackIsReversible(readiness);
}

function pendingConfirmationEvaluation(state = {}, nowMs = Date.now()) {
  const proposal = state.pendingProposal;
  if (!state.pendingConfirmation || !proposal) return null;
  if (
    proposal.status !== 'pending'
    || proposal.releaseSha !== state.newSha
    || proposal.targetSha !== state.prevSha
  ) return null;
  if (!Number.isFinite(Number(proposal.expiresAtMs)) || nowMs > Number(proposal.expiresAtMs)) return null;
  const evaluation = proposal.evaluation;
  return evaluation?.critical === true ? evaluation : null;
}

function formatApprovalProposal(proposal, reasonStr) {
  const expiresAt = new Date(proposal.expiresAtMs).toISOString();
  return `🔶 PROPOSTA DE ROLLBACK ${proposal.id}\n` +
    `Release atual: ${proposal.releaseSha}\nCandidato anterior verificado: ${proposal.targetSha}\n` +
    `Evidência: ${reasonStr}\nExpira: ${expiresAt}\n` +
    'Para autorizar, responda na conversa pessoal com todos os campos abaixo:\n' +
    `Ação: CONFIRM_ROLLBACK\nID: ${proposal.id}\nNonce: ${proposal.nonce}\n` +
    `Release: ${proposal.releaseSha}\nDestino: ${proposal.targetSha}\n` +
    'Uso único; grupos não são aceitos.';
}

async function alertBlockedOnce(state, ev, detail, deps = {}) {
  const send = deps.send || sendWhatsApp;
  const persist = deps.persist || saveState;
  const audit = deps.audit || decisionLog;
  const key = `${state.newSha}:${ev.failureClass}:${detail}`;
  if (state.lastBlockedAlertKey === key) return;
  const delivered = await send(`🚨 deploy-watch: ${ev.failureClass} em ${state.newSha}. Rollback automático NÃO apropriado. ` +
    `${detail}. Evidência: ${reasonString(ev)}. Ação: investigar.`);
  audit({
    phase: 'alert-investigate', newSha: state.newSha, prevSha: state.prevSha,
    failureClass: ev.failureClass, detail, evidence: ev.evidence, delivered,
  });
  if (!delivered) return;
  state.lastBlockedAlertKey = key;
  persist(state);
}

// ─── One detector tick ───────────────────────────────────────────────
async function tick() {
  if (!fs.existsSync(DB_PATH)) { log('vercel.db not found:', DB_PATH); return; }
  const db = new Database(DB_PATH, { readonly: true });
  const state = loadState();
  const now = Date.now();

  // 1) Arm on a new deploy: poll /api/version, fire on sha change, capture prevSha.
  const live = await currentSha();
  if (live) {
    if (!state.seeded) {
      state.currentSha = live; state.seeded = true; saveState(state);
      log(`seeded currentSha=${live} (no arm)`);
    } else if (live !== state.currentSha) {
      state.prevSha = state.currentSha;   // KNOWN-GOOD = what was live before the flip
      state.newSha = live;
      state.currentSha = live;
      state.deployStartMs = now;
      state.actedForSha = null;
      state.lastShadowAlertSha = null;
      state.lastBlockedAlertKey = null;
      state.pendingProposal = null;
      state.pendingConfirmation = null;
      saveState(state);
      log(`WATCH ACTIVE: new deploy ${state.prevSha} -> ${state.newSha} phase=${ROLLBACK_ROLLOUT_PHASE}`);
      await sendWhatsApp(`🟢 auto-rollback-watchdog observando o novo deploy ${state.newSha} por ${Math.round(HEIGHTENED_WINDOW_MS / 60000)} min. ` +
        `Fase=${ROLLBACK_ROLLOUT_PHASE}; rollback direto=${DIRECT_ROLLBACK_ENABLED ? 'configurado, ainda sujeito a todos os gates' : 'DESATIVADO'}. ` +
        `Esta mensagem confirma monitoramento, não execução automática.`);
    }
  }

  // 2) Evaluate within the heightened window only.
  const inWindow = state.deployStartMs && now - state.deployStartMs <= HEIGHTENED_WINDOW_MS;
  if (!inWindow) { db.close(); return; }

  let ev = evaluate(db, now, state);
  const resumedEvaluation = !ev.critical ? pendingConfirmationEvaluation(state, now) : null;
  if (resumedEvaluation) {
    ev = resumedEvaluation;
    decisionLog({
      phase: 'pending-confirmation-resumed', proposalId: state.pendingProposal.id,
      newSha: state.newSha, prevSha: state.prevSha,
    });
  }

  if (!ev.critical) { db.close(); log(`ok — ${ev.reasons[0]}`); return; }

  // CRITICAL: log every critical evaluation.
  decisionLog({ phase: 'critical-eval', rolloutPhase: ROLLBACK_ROLLOUT_PHASE, newSha: state.newSha, prevSha: state.prevSha, recommendation: ev.recommendation, failureClass: ev.failureClass, reasons: ev.reasons, blockers: ev.blockers, evidence: ev.evidence });

  if (ev.recommendation === RECOMMENDATION.ALERT_INVESTIGATE) {
    db.close();
    const detail = (ev.blockers || []).join('; ') || 'critical route is externally or financially ambiguous';
    log(`CRITICAL but rollback blocked — ${detail}`);
    await alertBlockedOnce(state, ev, detail);
    return;
  }

  // A rollback recommendation is not enough: verify the previous deployment,
  // smoke its own URL, load the exact release safety attestation, and re-run the
  // deterministic policy with guardrail evidence.
  const readiness = await buildReadiness(state, now);
  if (!resumedEvaluation) ev = evaluate(db, now, state, readiness);
  db.close();
  const reasonStr = reasonString(ev);
  decisionLog({
    phase: 'readiness-eval', rolloutPhase: ROLLBACK_ROLLOUT_PHASE,
    newSha: state.newSha, prevSha: state.prevSha, recommendation: ev.recommendation,
    failureClass: ev.failureClass, action: ev.action, directEligibility: ev.directEligibility,
    candidateReason: readiness.selection.reason, killSwitchSource: readiness.ks.source,
  });

  if (ev.recommendation === RECOMMENDATION.ALERT_INVESTIGATE) {
    const detail = (ev.blockers || []).join('; ') || 'rollback guardrail requires manual investigation';
    await alertBlockedOnce(state, ev, detail);
    return;
  }

  if (readinessBlocksBeforeAction(ROLLBACK_ROLLOUT_PHASE, readiness)) {
    const detail = !readiness.selection.target
      ? `candidato anterior não verificável: ${readiness.selection.reason}`
      : 'release sem atestado verificável de ausência de migração, flag ou ativação irreversível';
    await alertBlockedOnce(state, ev, detail);
    return;
  }

  if (ev.action === ACTION.DIRECT_ROLLBACK_PERMITTED) {
    log(`deterministic catastrophic policy permits direct rollback (kill-switch: ${readiness.ks.source})`);
    decisionLog({ phase: 'actuate', authorization: 'deterministic-policy', newSha: state.newSha, prevSha: state.prevSha, reason: reasonStr });
    const r = await rollbackToTarget(state, ev, { kind: 'deterministic-policy' }, readiness.selection.target);
    decisionLog({ phase: 'actuate-result', ...r });
    return;
  }

  if (ROLLBACK_ROLLOUT_PHASE === ROLLOUT_PHASE.SHADOW) {
    if (state.lastShadowAlertSha === state.newSha) { log('shadow report already sent for this deploy — skipping'); return; }
    const msg = `🟠 SHADOW: rollback recomendado para ${state.newSha} -> ${state.prevSha}, mas nenhuma ação foi autorizada. ` +
      `Evidência: ${reasonStr}. Elegibilidade direta=${ev.directEligibility.eligible}; ` +
      `bloqueios=${(ev.directEligibility.blockers || []).join('; ') || 'nenhum'}.`;
    await sendWhatsApp(msg);
    state.lastShadowAlertSha = state.newSha;
    saveState(state);
    decisionLog({ phase: 'shadow-report', newSha: state.newSha, prevSha: state.prevSha, reason: reasonStr, directEligibility: ev.directEligibility });
    return;
  }

  // Approval-required is also the fallback for every non-minimal class in the
  // future catastrophic-auto phase. Only a trusted WhatsApp ingress may attach
  // pendingConfirmation; the agent/LLM never writes or consumes authorization.
  if (!state.pendingProposal || state.pendingProposal.releaseSha !== state.newSha || state.pendingProposal.expiresAtMs <= now) {
    state.pendingProposal = createApprovalProposal({ releaseSha: state.newSha, targetSha: state.prevSha, nowMs: now });
    state.pendingProposal.evaluation = JSON.parse(JSON.stringify(ev));
    state.pendingConfirmation = null;
    saveState(state);
  }

  if (state.pendingConfirmation) {
    const validation = validateApprovalConfirmation(state.pendingProposal, state.pendingConfirmation, {
      allowedSenderIds: ALLOWED_APPROVER_IDS,
      personalConversationId: PERSONAL_APPROVAL_CONVERSATION_ID,
      personalApproverJid: PERSONAL_APPROVER_JID,
    }, now);
    if (validation.ok) {
      state.pendingProposal = consumeApprovalProposal(state.pendingProposal, state.pendingConfirmation, now);
      state.pendingConfirmation = null;
      saveState(state); // consume before the external side effect (one-time)
      decisionLog({ phase: 'human-approval-consumed', proposalId: state.pendingProposal.id, newSha: state.newSha, prevSha: state.prevSha });
      const r = await rollbackToTarget(state, ev, { kind: 'trusted-human-confirmation', proposalId: state.pendingProposal.id }, readiness.selection.target);
      decisionLog({ phase: 'actuate-result', authorization: 'trusted-human-confirmation', ...r });
      return;
    }
    decisionLog({ phase: 'human-approval-rejected', proposalId: state.pendingProposal.id, blockers: validation.blockers });
  }

  if (state.lastShadowAlertSha === state.newSha) { log('approval proposal already sent for this deploy — skipping'); return; }
  const expiresAt = new Date(state.pendingProposal.expiresAtMs).toISOString();
  const proposalText = formatApprovalProposal(state.pendingProposal, reasonStr);
  const sent = await sendApprovalProposal(proposalText);
  if (!sent) {
    await alertBlockedOnce(state, ev, 'proposta não enviada: destino pessoal allowlisted ou transporte confirmado indisponível');
    return;
  }
  state.lastShadowAlertSha = state.newSha;
  saveState(state);
  decisionLog({ phase: 'approval-proposal-sent', proposalId: state.pendingProposal.id, newSha: state.newSha, prevSha: state.prevSha, expiresAt });
}

// ─── Offline replay (verification) ───────────────────────────────────
// Walks a historical window minute-by-minute (poll cadence) and reports the
// FIRST tick that would have classified CRITICAL + deploy-attributed.
function replay(startISO, endISO, cutoverISO, dbPathOverride) {
  const db = new Database(dbPathOverride || DB_PATH, { readonly: true });
  const start = Date.parse(startISO);
  const end = endISO ? Date.parse(endISO) : start + 20 * 60 * 1000;
  const cutover = cutoverISO ? Date.parse(cutoverISO) : start;
  log(`REPLAY window ${new Date(start).toISOString()} .. ${new Date(end).toISOString()} | cutover ${new Date(cutover).toISOString()}`);
  let firstFire = null;
  const fires = [];
  const replayState = {
    newSha: 'replay-new-sha', prevSha: 'replay-previous-sha', currentSha: 'replay-new-sha',
    deployStartMs: cutover,
  };
  for (let t = cutover; t <= end; t += POLL_INTERVAL_MS) {
    if (t - cutover > HEIGHTENED_WINDOW_MS) break;
    const ev = evaluate(db, t, replayState);
    if (ev.critical) {
      const tag = ev.attributed ? 'CRITICAL+ATTRIBUTED (WOULD ROLL BACK)' : `CRITICAL but blocked: ${ev.blockers.join('; ')}`;
      log(`  ${new Date(t).toISOString()} ${tag} | ${ev.reasons.join(' | ')}`);
      if (ev.attributed) { fires.push(t); if (!firstFire) firstFire = { t, ev }; }
    }
  }
  db.close();
  if (firstFire) {
    log(`✅ REPLAY RESULT: WOULD HAVE FIRED at ${new Date(firstFire.t).toISOString()} ` +
      `(+${Math.round((firstFire.t - cutover) / 1000)}s after cutover). Attributed fires: ${fires.length}`);
    log('   evidence: ' + JSON.stringify(firstFire.ev.evidence));
  } else {
    log('❌ REPLAY RESULT: no attributed-critical tick in window (would NOT fire)');
  }
  return firstFire;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  DRY_TELEGRAM = args.includes('--dry-telegram');

  if (args.includes('--status')) {
    const s = loadState();
    console.log(JSON.stringify({
      ...s,
      deployStartTime: s.deployStartMs ? new Date(s.deployStartMs).toISOString() : null,
      killSwitch: killSwitchOn().source,
      tokenSet: !!process.env.VERCEL_ROLLBACK_TOKEN,
      rolloutPhase: ROLLBACK_ROLLOUT_PHASE,
      directEnable: DIRECT_ROLLBACK_ENABLED,
      personalApprovalDestinationValid: personalApprovalDestinationValid(),
      mode: ROLLBACK_ROLLOUT_PHASE === ROLLOUT_PHASE.SHADOW ? 'SHADOW' : 'FAIL-CLOSED-PENDING-GATES',
    }, null, 2));
    return;
  }

  if (args.includes('--replay')) {
    const i = args.indexOf('--replay');
    const startISO = args[i + 1];
    const endISO = args.includes('--end') ? args[args.indexOf('--end') + 1] : null;
    const cutISO = args.includes('--cutover') ? args[args.indexOf('--cutover') + 1] : startISO;
    const dbOverride = args.includes('--replay-db') ? args[args.indexOf('--replay-db') + 1] : null;
    if (!startISO) { console.error('usage: --replay <startISO> [--end <ISO>] [--cutover <ISO>] [--replay-db <path>]'); process.exit(1); }
    replay(startISO, endISO, cutISO, dbOverride);
    return;
  }

  if (args.includes('--loop')) {
    log(`watchdog starting phase=${ROLLBACK_ROLLOUT_PHASE} directEnable=${DIRECT_ROLLBACK_ENABLED}; ` +
      `poll=${POLL_INTERVAL_MS / 1000}s window=${WINDOW_MS / 1000}s heightened=${HEIGHTENED_WINDOW_MS / 60000}min; ` +
      'thresholds are defined by the deterministic route policy');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await tick(); } catch (e) { log('tick error:', e.message); }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // single tick
  await tick();
}

if (require.main === module) {
  main().catch(e => { log('fatal', e && e.message); process.exit(1); });
}

module.exports = {
  evaluate,
  alertBlockedOnce,
  readinessBlocksBeforeAction,
  pendingConfirmationEvaluation,
  formatApprovalProposal,
};
