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
 * The actuator (rollbackToTarget) is fully written but DORMANT. It needs BOTH:
 *   (a) a kill-switch ON — prod Firestore `feature_flags/auto_rollback`
 *       {enabled:true} if a prod firebase-admin SA is on the box, ELSE a local
 *       file flag `<skill>/auto-rollback.enabled` must EXIST; AND
 *   (b) env `VERCEL_ROLLBACK_TOKEN` set (a Vercel token with rollback scope).
 * With neither present it can never call the Vercel API — it stays shadow-only.
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
const { execFileSync } = require('child_process');

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
const DEPLOY_TELEGRAM_GROUP =
  process.env.DEPLOY_TELEGRAM_GROUP || process.env.ALERT_TELEGRAM_GROUP || 'telegram:-5102620169';

const POLL_INTERVAL_MS = Number(process.env.ROLLBACK_POLL_MS || 30 * 1000); // detector cadence
const WINDOW_MS = Number(process.env.ROLLBACK_WINDOW_MS || 90 * 1000);      // rolling detection window
const HEIGHTENED_WINDOW_MS = Number(process.env.ROLLBACK_HEIGHTENED_MS || 10 * 60 * 1000); // watch first 10 min after cutover
const PRE_CUTOVER_WINDOW_MS = 5 * 60 * 1000;                                // baseline window before cutover

// Critical detection (ALL must hold within the heightened window)
const CRIT_RATIO = Number(process.env.ROLLBACK_CRIT_RATIO || 0.5);          // 5xx / total
const CRIT_5XX_COUNT = Number(process.env.ROLLBACK_CRIT_5XX || 10);         // absolute 5xx floor
const CRIT_TOTAL_FLOOR = Number(process.env.ROLLBACK_TOTAL_FLOOR || 20);    // sample-size floor

// Attribution
const PRE_CUTOVER_ELEVATED_RATIO = 0.3; // if 5xx ratio already this high BEFORE cutover -> upstream, not the deploy
const MIN_DISTINCT_5XX_ENDPOINTS = 3;   // universal across >= 3 endpoints
// A "dependency-free" endpoint whose failure strongly implicates the deploy itself
const DEP_FREE_ENDPOINTS = ['/api/version'];
// Endpoints that commonly 5xx from UPSTREAM deps (Firebase/Pagar.me/OCPP webhooks).
// If the 5xx are CONFINED to these AND /api/version is fine -> upstream, not the deploy.
const UPSTREAM_PRONE_PREFIXES = ['/api/webhook/', '/api/payment', '/api/pagarme', '/api/nfse'];

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
      lastShadowAlertSha: null // don't spam shadow alerts for the same bad deploy
    };
  }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

// ─── Alerts → team WhatsApp group via the support-copilot relay ──────────────
// Telegram dropped per team decision 2026-06-22; every alert now goes to the
// WhatsApp alerts group through support-copilot (POST /api/support/conversations/
// {id}/messages) — the same path next/lib/services/whatsapp-notifier.ts uses.
const SUPPORT_BASE = process.env.SUPPORT_API_BASE || 'http://127.0.0.1:3005';
const MONITOR_API_SECRET = process.env.MONITOR_API_SECRET || process.env.SUPPORT_API_SECRET || '';
const ALERTS_CONVERSATION_ID = process.env.DEPLOY_HOOK_ALERTS_CONV || 'conv_jiuijxjtmnet23i9';
const ALERTS_BRAND = process.env.DEPLOY_WATCH_ALERTS_BRAND || 'turbo_station';
let DRY_TELEGRAM = false; // dry-run toggle (set by --dry-telegram): log instead of send
async function sendWhatsApp(text) {
  if (DRY_TELEGRAM) { log('[dry-send] WOULD WhatsApp:\n' + text); return true; }
  if (!MONITOR_API_SECRET) { log('whatsapp relay skipped: MONITOR_API_SECRET unset'); return false; }
  const url = new URL(`/api/support/conversations/${encodeURIComponent(ALERTS_CONVERSATION_ID)}/messages`, SUPPORT_BASE);
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
    if (!res.ok) { log(`whatsapp relay POST ${res.status} conv=${ALERTS_CONVERSATION_ID}`); return false; }
    log('whatsapp relay accepted'); return true;
  } catch (e) { log('whatsapp relay unreachable:', e.message); return false; }
  finally { clearTimeout(t); }
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
function queryWindow(db, fromMs, toMs) {
  const total = db.prepare(
    'SELECT COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code IS NOT NULL'
  ).get(fromMs, toMs).c;
  const c5xx = db.prepare(
    'SELECT COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code>=500'
  ).get(fromMs, toMs).c;
  const endpoints = db.prepare(
    'SELECT endpoint, COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? AND status_code>=500 ' +
    'AND endpoint IS NOT NULL GROUP BY endpoint ORDER BY c DESC'
  ).all(fromMs, toMs);
  // /api/version specific: count 200 vs (500 or null) to detect "version endpoint broken/flipping"
  const verRows = db.prepare(
    "SELECT status_code, COUNT(*) c FROM vercel_logs WHERE timestamp>=? AND timestamp<? " +
    "AND endpoint LIKE '%/api/version%' GROUP BY status_code"
  ).all(fromMs, toMs);
  return { total, c5xx, ratio: total ? c5xx / total : 0, endpoints, verRows };
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
// Returns { critical, attributed, reasons[], evidence{} }
function evaluate(db, nowMs, deployStartMs) {
  const winFrom = nowMs - WINDOW_MS;
  const m = queryWindow(db, winFrom, nowMs);

  const result = {
    critical: false, attributed: false, reasons: [], blockers: [],
    evidence: {
      windowSec: Math.round(WINDOW_MS / 1000),
      total: m.total, c5xx: m.c5xx, ratio: Number(m.ratio.toFixed(3)),
      distinctEndpoints: m.endpoints.length,
      topEndpoints: m.endpoints.slice(0, 8).map(e => `${e.endpoint} (${e.c})`),
    }
  };

  // 1) CRITICAL gate
  result.critical = m.ratio >= CRIT_RATIO && m.c5xx >= CRIT_5XX_COUNT && m.total >= CRIT_TOTAL_FLOOR;
  if (!result.critical) {
    result.reasons.push(`not critical: ratio=${m.ratio.toFixed(2)} 5xx=${m.c5xx} total=${m.total} ` +
      `(need ratio>=${CRIT_RATIO}, 5xx>=${CRIT_5XX_COUNT}, total>=${CRIT_TOTAL_FLOOR})`);
    return result;
  }
  result.reasons.push(`CRITICAL: ${m.c5xx}/${m.total} 5xx (${(m.ratio * 100).toFixed(0)}%) over ${result.evidence.windowSec}s`);

  // 2) Heightened-window gate (only attribute to the deploy in the first ~10 min)
  if (deployStartMs && nowMs - deployStartMs > HEIGHTENED_WINDOW_MS) {
    result.blockers.push(`outside heightened window (deploy +${Math.round((nowMs - deployStartMs) / 60000)}min > ` +
      `${Math.round(HEIGHTENED_WINDOW_MS / 60000)}min) — late surge, not attributing to this deploy`);
  }

  // 3) Attribution (a): surge starts at/after cutover (pre-cutover must be quiet)
  if (deployStartMs) {
    const pre = queryWindow(db, deployStartMs - PRE_CUTOVER_WINDOW_MS, deployStartMs);
    result.evidence.preCutoverRatio = Number(pre.ratio.toFixed(3));
    result.evidence.preCutover5xx = pre.c5xx;
    if (pre.ratio >= PRE_CUTOVER_ELEVATED_RATIO) {
      result.blockers.push(`pre-cutover 5xx already elevated (ratio=${pre.ratio.toFixed(2)}) — upstream, not the deploy`);
    } else {
      result.reasons.push(`pre-cutover clean (ratio=${pre.ratio.toFixed(2)}) — surge began at cutover`);
    }
  } else {
    result.reasons.push('no cutover recorded — treating as standalone critical (cannot attribute to a specific deploy)');
  }

  // 4) Attribution (b)+(c): universal across >=3 endpoints; not confined to upstream-prone routes;
  //    /api/version status is the strongest deploy-broken signal.
  const distinct = m.endpoints.length;
  if (distinct < MIN_DISTINCT_5XX_ENDPOINTS) {
    result.blockers.push(`5xx confined to ${distinct} endpoint(s) (<${MIN_DISTINCT_5XX_ENDPOINTS}) — not universal`);
  } else {
    result.reasons.push(`universal across ${distinct} endpoints`);
  }

  const nonUpstream = m.endpoints.filter(e =>
    !UPSTREAM_PRONE_PREFIXES.some(p => (e.endpoint || '').startsWith(p)));
  const vh = versionHealth(m.verRows);
  const depFreeFailing = m.endpoints.some(e => DEP_FREE_ENDPOINTS.includes(e.endpoint)) || vh.broken;

  result.evidence.versionHealth = vh;
  result.evidence.nonUpstreamFailing = nonUpstream.slice(0, 5).map(e => `${e.endpoint} (${e.c})`);

  if (nonUpstream.length === 0 && !vh.broken) {
    result.blockers.push('5xx CONFINED to webhook/payment routes and /api/version is fine — upstream dep (Firebase/Pagar.me), not the deploy');
  } else if (vh.broken) {
    result.reasons.push(`/api/version itself failing/flipping (ok=${vh.ok} bad=${vh.bad}) — strong deploy-broken signal`);
  } else {
    result.reasons.push(`${nonUpstream.length} non-upstream endpoints failing (incl. dependency-free routes)`);
  }
  if (depFreeFailing) result.reasons.push('dependency-free endpoint among the failures');

  result.attributed = result.critical && result.blockers.length === 0;
  return result;
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
  // Smoke the candidate's own URL before trusting it. Deployment URLs sit behind Vercel
  // Deployment Protection, so send the automation bypass header. A 401/403 means "protected"
  // (cannot verify via the direct URL) — NOT a real failure: proceed on the sha match and let
  // the post-rollback re-smoke of the PUBLIC prod alias be the final check. Only a real 5xx
  // from the deployment aborts (refuse to roll onto a broken target).
  const smokeUrl = target.url ? (target.url.startsWith('http') ? target.url : `https://${target.url}`) : null;
  if (smokeUrl) {
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
    try {
      const r = await fetch(`${smokeUrl}/api/version`, { method: 'GET', redirect: 'manual', headers });
      if (r.status === 401 || r.status === 403) {
        log(`target ${target.uid} smoke ${r.status} (deployment-protection wall; ${bypass ? 'bypass rejected' : 'no bypass secret set'}) — proceeding on sha match, post-rollback re-smoke verifies`);
      } else if (r.status >= 500) {
        return { target: null, reason: `target ${target.uid} smoke FAILED (${r.status}) — refusing to roll onto a broken deployment` };
      }
    } catch (e) { log(`target ${target.uid} smoke error: ${e.message} — proceeding on sha match`); }
  }
  return { target, reason: 'ok' };
}

// DORMANT actuator. Returns a result object; PAGES on every branch.
async function rollbackToTarget(state, evalResult) {
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

  const sel = await selectRollbackTarget(state.prevSha);
  if (!sel.target) {
    await sendWhatsApp(`🚨 auto-rollback ABORTED: ${sel.reason} — MANUAL ROLLBACK REQUIRED for bad deploy ${state.newSha}`);
    return { acted: false, reason: sel.reason };
  }

  // ── Execute the rollback (the only place the Vercel rollback API is called) ──
  await sendWhatsApp(`🔴 AUTO-ROLLBACK EXECUTING: prod ${state.newSha} -> ${state.prevSha} (deployment ${sel.target.uid})`);
  await vercelFetch(`/v1/projects/${VERCEL_PROJECT_ID}/rollback/${sel.target.uid}`, { method: 'POST' });

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

  state.actedForSha = state.newSha;
  state.lastActionMs = Date.now();
  saveState(state);

  await sendWhatsApp(prodOk && flipped
    ? `✅ AUTO-ROLLBACK COMPLETE: prod restored to ${state.prevSha} and /api/version is 200`
    : `⚠️ AUTO-ROLLBACK issued but prod NOT confirmed healthy (flipped=${flipped} smoke=${prodOk}) — INVESTIGATE`);
  return { acted: true, target: sel.target.uid, prodOk, flipped };
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
      saveState(state);
      log(`ARMED: new deploy ${state.prevSha} -> ${state.newSha} at ${new Date(now).toISOString()}`);
      await sendWhatsApp(`🟢 auto-rollback-watchdog ARMED for new prod deploy ${state.newSha} (good target: ${state.prevSha}). Watching 5xx for ${Math.round(HEIGHTENED_WINDOW_MS / 60000)} min.`);
    }
  }

  // 2) Evaluate within the heightened window only.
  const inWindow = state.deployStartMs && now - state.deployStartMs <= HEIGHTENED_WINDOW_MS;
  if (!inWindow) { db.close(); return; }

  const ev = evaluate(db, now, state.deployStartMs);
  db.close();

  if (!ev.critical) { log(`ok — ${ev.reasons[0]}`); return; }

  // CRITICAL: log every critical evaluation.
  decisionLog({ phase: 'critical-eval', newSha: state.newSha, prevSha: state.prevSha, attributed: ev.attributed, reasons: ev.reasons, blockers: ev.blockers, evidence: ev.evidence });

  if (!ev.attributed) {
    log(`CRITICAL but NOT deploy-attributed — blockers: ${ev.blockers.join('; ')}`);
    return; // do not alert/act — likely upstream
  }

  // CRITICAL + attributed → SHADOW alert (once per bad deploy), and (if armed) act.
  const ks = killSwitchOn();
  let armed = false, ksSource = ks.source;
  if (ks.on === true) armed = true;
  else if (ks.on === 'firestore-deferred') { const f = await resolveFirestoreFlag(ks.admin); armed = f.on; ksSource = f.source; }

  const ev5 = ev.evidence;
  const reasonStr = `5xx ${ev5.c5xx}/${ev5.total} (${(ev5.ratio * 100).toFixed(0)}%) over ${ev5.windowSec}s, universal across ${ev5.distinctEndpoints} endpoints` +
    (ev5.versionHealth && ev5.versionHealth.broken ? `, /api/version broken (ok=${ev5.versionHealth.ok} bad=${ev5.versionHealth.bad})` : '') +
    `; top: ${(ev5.topEndpoints || []).slice(0, 4).join(', ')}`;

  if (armed && process.env.VERCEL_ROLLBACK_TOKEN) {
    // ARMED — real action path (NOT reachable in shadow mode: requires enable flag + token).
    log(`ARMED + token present (kill-switch: ${ksSource}) — invoking actuator`);
    decisionLog({ phase: 'actuate', newSha: state.newSha, prevSha: state.prevSha, ksSource, reason: reasonStr });
    const r = await rollbackToTarget(state, ev);
    decisionLog({ phase: 'actuate-result', ...r });
    return;
  }

  // SHADOW MODE — alert "WOULD roll back", never call the API.
  if (state.lastShadowAlertSha === state.newSha) { log('shadow alert already sent for this deploy — skipping'); return; }
  const msg = `🟠 WOULD auto-rollback prod from ${state.newSha} to ${state.prevSha} — reason: ${reasonStr}\n` +
    `(SHADOW MODE — no action taken. kill-switch: ${ksSource}; token: ${process.env.VERCEL_ROLLBACK_TOKEN ? 'set' : 'unset'})`;
  await sendWhatsApp(msg);
  state.lastShadowAlertSha = state.newSha;
  saveState(state);
  decisionLog({ phase: 'shadow-alert', newSha: state.newSha, prevSha: state.prevSha, reason: reasonStr, ksSource, tokenSet: !!process.env.VERCEL_ROLLBACK_TOKEN });
  log('SHADOW alert sent: WOULD roll back ' + state.newSha + ' -> ' + state.prevSha);
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
  for (let t = cutover; t <= end; t += POLL_INTERVAL_MS) {
    if (t - cutover > HEIGHTENED_WINDOW_MS) break;
    const ev = evaluate(db, t, cutover);
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
      mode: (fs.existsSync(ENABLE_FLAG) || fs.existsSync(FIREBASE_SA)) && process.env.VERCEL_ROLLBACK_TOKEN ? 'ARMED-CAPABLE' : 'SHADOW',
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
    log(`watchdog starting in ${process.env.VERCEL_ROLLBACK_TOKEN ? 'TOKEN-PRESENT' : 'SHADOW'} mode; ` +
      `poll=${POLL_INTERVAL_MS / 1000}s window=${WINDOW_MS / 1000}s heightened=${HEIGHTENED_WINDOW_MS / 60000}min ` +
      `crit ratio>=${CRIT_RATIO} 5xx>=${CRIT_5XX_COUNT} total>=${CRIT_TOTAL_FLOOR}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await tick(); } catch (e) { log('tick error:', e.message); }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // single tick
  await tick();
}

main().catch(e => { log('fatal', e && e.message); process.exit(1); });
