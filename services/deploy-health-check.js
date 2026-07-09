#!/usr/bin/env node
/**
 * Deploy Health Check — Adaptive post-deploy 5xx spike detector
 *
 * Skill: deploy-monitor (workspace-ops/skills/deploy-monitor/SKILL.md)
 *
 * Phases:
 *   🔴 Intensive  (0–5 min)   → agent ramps 20s → 40s → 60s → 120s, critical alerts
 *   🟡 Moderate   (5–30 min)  → agent every 5 min, warning alerts
 *   🟢 Stable     (30min+)    → agent every 15 min until 2h, then OFF
 *
 * Usage:
 *   node deploy-health-check.js                # normal check (runs every 20 min via cron)
 *   node deploy-health-check.js --deploy-start # activate deploy monitoring
 *   node deploy-health-check.js --deploy-stop  # deactivate deploy monitoring
 *   node deploy-health-check.js --baseline     # show metrics (dry run)
 *   node deploy-health-check.js --force        # send report even if healthy
 *   node deploy-health-check.js --status       # show current deploy state
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Config ─────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'db', 'vercel.db');
const STATE_PATH = path.join(__dirname, '..', 'db', 'deploy-health-state.json');
const CRON_PATH = '/home/openclaw/.openclaw/cron/jobs.json';
const DEPLOY_TELEGRAM_GROUP = process.env.DEPLOY_TELEGRAM_GROUP || 'telegram:-5215167228';

// Agent cron job ID (must match jobs.json)
const AGENT_CRON_ID = '2e4b1e4b-d252-41bd-b705-8ece63a2ad89';

// Phase boundaries (ms)
const INTENSIVE_END_MS = 5 * 60 * 1000;      // first 5 min
const MODERATE_END_MS = 30 * 60 * 1000;      // 5–30 min
const STABLE_AGENT_END_MS = 2 * 60 * 60 * 1000; // 30 min–2h

// Thresholds
const WINDOW_MINUTES = 5;
const BASELINE_MINUTES = 30;
const MIN_5XX_ALERT = 3;
const SPIKE_RATIO = 3;
const COOLDOWN_MS = 10 * 60 * 1000;

// ─── State management ───────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      deployActive: false,
      deployStartMs: 0,
      lastAlertMs: 0,
      lastAlertRoutes: [],
      currentPhase: 'stable',
      lastPhaseTransition: 0
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Phase management ───────────────────────────────────────────────
function getPhase(state) {
  if (!state.deployActive) return 'stable';
  const elapsed = Date.now() - state.deployStartMs;
  if (elapsed < INTENSIVE_END_MS) return 'intensive';
  if (elapsed < MODERATE_END_MS) return 'moderate';
  if (elapsed < STABLE_AGENT_END_MS) return 'stable';
  return 'complete'; // auto-deactivate
}

function getPhaseEmoji(phase) {
  return { intensive: '🔴', moderate: '🟡', stable: '🟢', complete: '⚪' }[phase] || '🟢';
}

function getElapsedStr(state) {
  if (!state.deployActive) return 'N/A';
  const elapsed = Date.now() - state.deployStartMs;
  const min = Math.floor(elapsed / 60000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

// ─── Cron job management ────────────────────────────────────────────
function updateAgentCron(enabled, everyMs) {
  try {
    const cronData = JSON.parse(fs.readFileSync(CRON_PATH, 'utf8'));
    const job = cronData.jobs.find(j => j.id === AGENT_CRON_ID);
    if (!job) {
      console.error('[deploy-health] Agent cron job not found in jobs.json');
      return false;
    }

    let changed = false;

    if (job.enabled !== enabled) {
      job.enabled = enabled;
      changed = true;
    }
    if (everyMs && job.schedule.everyMs !== everyMs) {
      job.schedule.everyMs = everyMs;
      job.schedule.anchorMs = Date.now();
      changed = true;
    }

    if (changed) {
      job.updatedAtMs = Date.now();
      // Reset state on change so it picks up immediately
      job.state = { consecutiveErrors: 0 };
      fs.writeFileSync(CRON_PATH, JSON.stringify(cronData, null, 2));
      console.log(`[deploy-health] Agent cron updated: enabled=${enabled}, every=${everyMs ? (everyMs/1000) + 's' : 'unchanged'}`);
    }

    return true;
  } catch (err) {
    console.error('[deploy-health] Failed to update agent cron:', err.message);
    return false;
  }
}

function getAdaptiveIntervalMs(state, now = Date.now()) {
  if (!state.deployActive) return null;
  const elapsed = now - state.deployStartMs;

  if (elapsed < 60 * 1000) return 20 * 1000;       // 0–1 min
  if (elapsed < 3 * 60 * 1000) return 40 * 1000;   // 1–3 min
  if (elapsed < 5 * 60 * 1000) return 60 * 1000;   // 3–5 min
  if (elapsed < 30 * 60 * 1000) return 2 * 60 * 1000; // 5–30 min
  if (elapsed < STABLE_AGENT_END_MS) return 15 * 60 * 1000; // 30 min–2h
  return null;
}

// ─── Telegram messaging ─────────────────────────────────────────────
function sendTelegram(msg) {
  try {
    // Escape for shell
    const escaped = msg.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    execSync(
      `openclaw message send --channel telegram --target "${DEPLOY_TELEGRAM_GROUP}" --message "${escaped}"`,
      { timeout: 15000, stdio: 'pipe' }
    );
    return true;
  } catch (err) {
    console.error('[deploy-health] Failed to send telegram:', err.message);
    return false;
  }
}

// ─── DB queries ─────────────────────────────────────────────────────
function queryMetrics(db, now) {
  const windowStart = now - WINDOW_MINUTES * 60 * 1000;
  const baselineStart = now - BASELINE_MINUTES * 60 * 1000;

  // Recent 5xx
  const recentRows = db.prepare(`
    SELECT status_code, endpoint, COUNT(*) as cnt
    FROM vercel_logs
    WHERE timestamp >= ? AND status_code >= 500
    GROUP BY status_code, endpoint
    ORDER BY cnt DESC LIMIT 20
  `).all(windowStart);

  const recent5xxTotal = recentRows.reduce((s, r) => s + r.cnt, 0);

  // Total requests in window
  const recentTotal = db.prepare(`
    SELECT COUNT(*) as cnt FROM vercel_logs
    WHERE timestamp >= ? AND status_code IS NOT NULL
  `).get(windowStart).cnt;

  // Baseline 5xx (excluding recent window)
  const baseline5xx = db.prepare(`
    SELECT COUNT(*) as cnt FROM vercel_logs
    WHERE timestamp >= ? AND timestamp < ? AND status_code >= 500
  `).get(baselineStart, windowStart).cnt;

  const baselineTotal = db.prepare(`
    SELECT COUNT(*) as cnt FROM vercel_logs
    WHERE timestamp >= ? AND timestamp < ? AND status_code IS NOT NULL
  `).get(baselineStart, windowStart).cnt;

  // Rates per minute
  const baselineMinutes = BASELINE_MINUTES - WINDOW_MINUTES;
  const baselineRatePerMin = baselineMinutes > 0 ? baseline5xx / baselineMinutes : 0;
  const recentRatePerMin = WINDOW_MINUTES > 0 ? recent5xxTotal / WINDOW_MINUTES : 0;

  // Slow routes
  const slowRoutes = db.prepare(`
    SELECT endpoint, AVG(duration_ms) as avg_ms, COUNT(*) as cnt
    FROM vercel_logs
    WHERE timestamp >= ? AND duration_ms IS NOT NULL AND duration_ms > 3000
    GROUP BY endpoint HAVING cnt >= 2
    ORDER BY avg_ms DESC LIMIT 5
  `).all(windowStart);

  // Status distribution (for richer messages)
  const statusDist = db.prepare(`
    SELECT
      CASE WHEN status_code < 300 THEN '2xx'
           WHEN status_code < 400 THEN '3xx'
           WHEN status_code < 500 THEN '4xx'
           ELSE '5xx' END as category,
      COUNT(*) as cnt
    FROM vercel_logs
    WHERE timestamp >= ? AND status_code IS NOT NULL
    GROUP BY category ORDER BY category
  `).all(windowStart);

  const errorRate = recentTotal > 0 ? ((recent5xxTotal / recentTotal) * 100).toFixed(2) : '0.00';

  const isSpike = recent5xxTotal >= MIN_5XX_ALERT &&
                  (baselineRatePerMin === 0 || recentRatePerMin >= baselineRatePerMin * SPIKE_RATIO);

  return {
    recentRows, recent5xxTotal, recentTotal, errorRate,
    baseline5xx, baselineTotal, baselineRatePerMin, recentRatePerMin,
    slowRoutes, statusDist, isSpike
  };
}

// ─── Message builders (phase-aware) ─────────────────────────────────
function buildMessage(metrics, phase, state) {
  const { recentRows, recent5xxTotal, recentTotal, errorRate,
          baselineRatePerMin, recentRatePerMin, slowRoutes, statusDist, isSpike } = metrics;

  const elapsed = getElapsedStr(state);
  const emoji = getPhaseEmoji(phase);

  if (phase === 'intensive') {
    // 🔴 CRITICAL — maximum detail, immediate action needed
    const routeList = recentRows.slice(0, 8)
      .map(r => `  • ${r.endpoint || '?'} → ${r.status_code} (${r.cnt}x)`)
      .join('\n');

    const slowList = slowRoutes.length > 0
      ? '\n\n🐢 Slow routes (>3s):\n' + slowRoutes
          .map(r => `  • ${r.endpoint} → avg ${Math.round(r.avg_ms)}ms (${r.cnt}x)`)
          .join('\n')
      : '';

    const distStr = statusDist.map(d => `${d.category}:${d.cnt}`).join(' | ');

    return [
      `🚨 DEPLOY ALERT — ${emoji} INTENSIVE PHASE`,
      `⏱ Deploy +${elapsed}`,
      ``,
      `📊 Last ${WINDOW_MINUTES}min: ${recent5xxTotal} errors / ${recentTotal} requests (${errorRate}%)`,
      `📈 Baseline: ${baselineRatePerMin.toFixed(1)}/min → Now: ${recentRatePerMin.toFixed(1)}/min`,
      `📋 Distribution: ${distStr}`,
      ``,
      recent5xxTotal > 0 ? `🔴 Failing routes:\n${routeList}` : '✅ No 5xx errors detected',
      slowList,
      ``,
      `🕐 ${new Date().toISOString()}`
    ].join('\n');
  }

  if (phase === 'moderate') {
    // 🟡 WARNING — trend analysis, less urgency
    const routeList = recentRows.slice(0, 5)
      .map(r => `  • ${r.endpoint || '?'} → ${r.status_code} (${r.cnt}x)`)
      .join('\n');

    const distStr = statusDist.map(d => `${d.category}:${d.cnt}`).join(' | ');

    return [
      `⚠️ DEPLOY MONITOR — ${emoji} MODERATE PHASE`,
      `⏱ Deploy +${elapsed}`,
      ``,
      `📊 ${recent5xxTotal} errors / ${recentTotal} req (${errorRate}%) — baseline: ${baselineRatePerMin.toFixed(1)}/min`,
      `📋 ${distStr}`,
      recent5xxTotal > 0 ? `\n🟡 Affected:\n${routeList}` : '\n✅ All routes healthy',
      ``,
      `🕐 ${new Date().toISOString()}`
    ].join('\n');
  }

  // 🟢 STABLE — concise summary, only on spike
  if (!isSpike && recent5xxTotal === 0) return null; // silent when healthy

  const routeList = recentRows.slice(0, 3)
    .map(r => `${r.endpoint || '?'} (${r.status_code}: ${r.cnt}x)`)
    .join(', ');

  return [
    `📊 VERCEL — ${recent5xxTotal} errors / ${recentTotal} req (${errorRate}%)`,
    recent5xxTotal > 0 ? `Routes: ${routeList}` : '✅ Healthy',
    `🕐 ${new Date().toISOString()}`
  ].join('\n');
}

// ─── Commands ───────────────────────────────────────────────────────
function handleDeployStart() {
  const state = loadState();
  const now = Date.now();
  state.deployActive = true;
  state.deployStartMs = now;
  state.currentPhase = 'intensive';
  state.lastPhaseTransition = now;
  state.lastAlertMs = 0;
  saveState(state);

  const initialEveryMs = getAdaptiveIntervalMs(state, now) || 20 * 1000;
  updateAgentCron(true, initialEveryMs);

  const msg = [
    '🚀 Deploy monitoring ACTIVATED',
    '',
    '📋 Schedule:',
    '  🔴 0–1min: agent every 20s',
    '  🔴 1–3min: agent every 40s',
    '  🔴 3–5min: agent every 60s',
    '  🟡 5–30min: agent every 2min',
    '  🟢 30min–2h: agent every 15min',
    '  ⚪ 2h+: agent OFF (script only)',
    '  ⚡ Immediate check on activation',
    '  📊 Script: every 20min (always on)',
    '',
    `🕐 ${new Date(now).toISOString()}`
  ].join('\n');

  sendTelegram(msg);
  console.log('[deploy-health] Deploy monitoring activated.');

  try {
    execSync(`node "${__filename}" --force`, { stdio: 'inherit', timeout: 30000 });
    console.log('[deploy-health] Immediate health check executed.');
  } catch (err) {
    console.error('[deploy-health] Immediate health check failed:', err.message);
  }
}

function handleDeployStop() {
  const state = loadState();
  const wasActive = state.deployActive;
  const elapsed = getElapsedStr(state);

  state.deployActive = false;
  state.currentPhase = 'stable';
  saveState(state);

  // Disable agent cron
  updateAgentCron(false, null);

  if (wasActive) {
    sendTelegram(`🏁 Deploy monitoring DEACTIVATED after ${elapsed}\n🕐 ${new Date().toISOString()}`);
  }

  console.log('[deploy-health] Deploy monitoring deactivated.');
}

function handleStatus() {
  const state = loadState();
  const phase = getPhase(state);
  const elapsed = getElapsedStr(state);

  console.log(JSON.stringify({
    deployActive: state.deployActive,
    currentPhase: phase,
    elapsed,
    deployStartMs: state.deployStartMs,
    lastAlertMs: state.lastAlertMs,
    deployStartTime: state.deployStartMs ? new Date(state.deployStartMs).toISOString() : 'N/A'
  }, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  // Handle commands
  if (args.includes('--deploy-start')) return handleDeployStart();
  if (args.includes('--deploy-stop')) return handleDeployStop();
  if (args.includes('--status')) return handleStatus();

  const dryRun = args.includes('--baseline');
  const force = args.includes('--force');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`[deploy-health] DB not found: ${DB_PATH}`);
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const now = Date.now();
  const state = loadState();

  // ─── Phase transition management ────────────────────────────────
  const previousPhase = state.currentPhase;
  const currentPhase = getPhase(state);

  if (state.deployActive && currentPhase !== previousPhase) {
    state.currentPhase = currentPhase;
    state.lastPhaseTransition = now;
    saveState(state);

    if (currentPhase === 'moderate') {
      updateAgentCron(true, getAdaptiveIntervalMs(state, now));
      sendTelegram(`🟡 Deploy phase → MODERATE (agent now every 2min)\n⏱ Deploy +${getElapsedStr(state)}`);
      console.log('[deploy-health] Transitioned to moderate phase.');
    } else if (currentPhase === 'stable') {
      updateAgentCron(true, getAdaptiveIntervalMs(state, now));
      sendTelegram(`🟢 Deploy phase → STABLE (agent now every 15min)\n⏱ Deploy +${getElapsedStr(state)}`);
      console.log('[deploy-health] Transitioned to stable phase.');
    } else if (currentPhase === 'complete' && previousPhase !== 'complete') {
      state.deployActive = false;
      saveState(state);
      updateAgentCron(false, null);
      sendTelegram(`⚪ Deploy monitoring window complete (agent OFF, script continues every 20min)\n⏱ Deploy +${getElapsedStr({ ...state, deployActive: true })}`);
      console.log('[deploy-health] Monitoring window completed. Agent cron disabled.');
    }
  }

  const desiredIntervalMs = getAdaptiveIntervalMs(state, now);
  if (state.deployActive && desiredIntervalMs) {
    updateAgentCron(true, desiredIntervalMs);
  }

  // ─── Query metrics ──────────────────────────────────────────────
  const metrics = queryMetrics(db, now);
  db.close();

  if (dryRun) {
    console.log(JSON.stringify({
      phase: currentPhase,
      deployActive: state.deployActive,
      elapsed: getElapsedStr(state),
      ...metrics,
      recentRows: metrics.recentRows.slice(0, 5).map(r => `${r.endpoint} (${r.status_code}: ${r.cnt}x)`),
      slowRoutes: metrics.slowRoutes.map(r => `${r.endpoint} (avg ${Math.round(r.avg_ms)}ms)`)
    }, null, 2));
    return;
  }

  // ─── Decide whether to alert ───────────────────────────────────
  const shouldAlert = metrics.isSpike || force ||
    (state.deployActive && currentPhase === 'intensive'); // always report during intensive

  if (!shouldAlert && !state.deployActive) {
    console.log(`[deploy-health] OK — 5xx: ${metrics.recent5xxTotal}/${metrics.recentTotal} (${metrics.errorRate}%)`);
    return;
  }

  // Cooldown check (skip during intensive phase — always report there)
  if (!force && currentPhase !== 'intensive' && (now - state.lastAlertMs < COOLDOWN_MS)) {
    console.log('[deploy-health] In cooldown. Skipping alert.');
    return;
  }

  // ─── Build and send message ─────────────────────────────────────
  const msg = buildMessage(metrics, currentPhase, state);

  if (msg) {
    if (sendTelegram(msg)) {
      console.log(`[deploy-health] Alert sent (phase: ${currentPhase}).`);
      state.lastAlertMs = now;
      state.lastAlertRoutes = metrics.recentRows.slice(0, 5).map(r => r.endpoint);
      saveState(state);
    }
  } else {
    console.log(`[deploy-health] OK — 5xx: ${metrics.recent5xxTotal}/${metrics.recentTotal} (${metrics.errorRate}%), phase: ${currentPhase}`);
  }
}

main();
