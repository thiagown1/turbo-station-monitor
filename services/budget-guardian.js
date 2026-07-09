#!/usr/bin/env node
/**
 * Budget Guardian — Automated Codex Quota Monitor + Model Swapper
 *
 * Runs on cron (every 15min) to:
 * 1. Check real Codex quotas (main + Spark) via API
 * 2. Auto-swap heartbeat models BEFORE Spark hits its limit
 * 3. Log usage history for trend analysis
 * 4. Alert on Telegram when budget thresholds are crossed
 *
 * When Spark 5h > 60% used → swap heartbeats back to gpt-5.3-codex
 * When Spark recovers < 30% used → swap back to Spark
 *
 * Usage:
 *   node budget-guardian.js          # Run once (cron mode)
 *   node budget-guardian.js --dry    # Show what would happen without applying
 *   node budget-guardian.js --status # Quick status check
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OPENCLAW_JSON = '/home/openclaw/.openclaw/openclaw.json';
const AUTH_PROFILES = '/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json';
const DATA_DIR = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/data';
const USAGE_LOG = path.join(DATA_DIR, 'usage-history.jsonl');
const GUARDIAN_STATE = path.join(DATA_DIR, 'guardian-state.json');

// Model IDs
const SPARK_MODEL = 'openai-codex/gpt-5.3-codex-spark';
const FALLBACK_MODEL = 'openai-codex/gpt-5.3-codex';

// Thresholds — swap BEFORE hitting limits
const SPARK_SWAP_AWAY_PCT = 90;   // Swap away from Spark when 5h > 90% used (10% left)
const SPARK_SWAP_BACK_PCT = 30;   // Swap back to Spark when 5h < 30% used
const MAIN_WARN_5H_PCT = 70;     // Warn when main 5h > 70%
const MAIN_PAUSE_5H_PCT = 90;    // Pause when main 5h > 90%
const MAIN_WARN_WEEKLY_PCT = 80; // Warn when weekly > 80%

// Telegram alert config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = '-5103508388'; // Dev group

/**
 * Read Codex OAuth token
 */
function getToken() {
  try {
    const d = JSON.parse(fs.readFileSync(AUTH_PROFILES, 'utf-8'));
    return d.profiles?.['openai-codex:default']?.access || '';
  } catch { return ''; }
}

/**
 * Fetch Codex usage from API
 */
function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'chatgpt.com',
      path: '/backend-api/wham/usage',
      method: 'GET',
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'CodexBar',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse usage into simple object
 */
function parseUsage(data) {
  const main5h = data.rate_limit?.primary_window?.used_percent || 0;
  const mainWeekly = data.rate_limit?.secondary_window?.used_percent || 0;
  const codeReview = data.code_review_rate_limit?.primary_window?.used_percent || 0;

  let spark5h = 0, sparkWeekly = 0;
  for (const al of data.additional_rate_limits || []) {
    if (al.limit_name?.includes('Spark')) {
      spark5h = al.rate_limit?.primary_window?.used_percent || 0;
      sparkWeekly = al.rate_limit?.secondary_window?.used_percent || 0;
    }
  }

  return {
    plan: data.plan_type,
    main: { h5: main5h, weekly: mainWeekly },
    spark: { h5: spark5h, weekly: sparkWeekly },
    codeReview,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Read current guardian state
 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(GUARDIAN_STATE, 'utf-8'));
  } catch {
    return { currentHeartbeatModel: SPARK_MODEL, lastSwap: null, swapReason: '', lastRun: null };
  }
}

/**
 * Save guardian state
 */
function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GUARDIAN_STATE, JSON.stringify(state, null, 2));
}

/**
 * Append to usage history log
 */
function logUsage(usage) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(USAGE_LOG, JSON.stringify(usage) + '\n');
}

/**
 * Get current heartbeat model from openclaw.json
 */
function getCurrentHeartbeatModel() {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf-8'));
    return config.agents?.defaults?.heartbeat?.model || FALLBACK_MODEL;
  } catch { return FALLBACK_MODEL; }
}

/**
 * Swap heartbeat model in openclaw.json for all agents
 */
function swapHeartbeatModel(newModel, dryRun = false) {
  const config = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf-8'));
  const oldModel = getCurrentHeartbeatModel();

  if (oldModel === newModel) {
    return { swapped: false, reason: 'Already using target model' };
  }

  if (dryRun) {
    return { swapped: false, dryRun: true, from: oldModel, to: newModel };
  }

  // Swap in defaults
  if (config.agents?.defaults?.heartbeat) {
    config.agents.defaults.heartbeat.model = newModel;
  }

  // Swap in all agent profiles that use the old heartbeat model
  for (const agent of config.agents?.list || []) {
    if (agent.heartbeat?.model === oldModel) {
      agent.heartbeat.model = newModel;
    }
  }

  fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(config, null, 2));

  // Restart gateway to pick up changes
  try {
    execSync('openclaw gateway restart 2>&1', { timeout: 15000 });
  } catch (err) {
    console.error(`  ⚠️  Gateway restart failed: ${err.message}`);
  }

  return { swapped: true, from: oldModel, to: newModel };
}

/**
 * Send Telegram alert
 */
function sendAlert(message) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    execSync(`curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -d "chat_id=${TELEGRAM_CHAT_ID}" -d "text=${encodeURIComponent(message)}" -d "parse_mode=Markdown" --max-time 10 2>/dev/null`, { timeout: 15000 });
  } catch { /* ignore send failures */ }
}

/**
 * Main guardian logic
 */
async function run(options = {}) {
  const dryRun = options.dryRun || false;
  const statusOnly = options.statusOnly || false;

  const token = getToken();
  if (!token) {
    console.error('❌ No Codex token found');
    process.exit(1);
  }

  // Fetch real quota
  let usage;
  try {
    const raw = await fetchUsage(token);
    usage = parseUsage(raw);
  } catch (err) {
    console.error(`❌ API error: ${err.message}`);
    process.exit(1);
  }

  // Log usage
  logUsage(usage);

  const state = readState();
  const currentModel = getCurrentHeartbeatModel();
  const actions = [];

  // --- Decision logic ---

  // 1. Spark limit protection
  if (currentModel === SPARK_MODEL && usage.spark.h5 >= SPARK_SWAP_AWAY_PCT) {
    actions.push({
      type: 'swap',
      from: SPARK_MODEL,
      to: FALLBACK_MODEL,
      reason: `Spark 5h at ${usage.spark.h5}% (threshold: ${SPARK_SWAP_AWAY_PCT}%) — swapping to prevent Spark limit bug`,
    });
  } else if (currentModel === SPARK_MODEL && usage.spark.weekly >= SPARK_SWAP_AWAY_PCT) {
    actions.push({
      type: 'swap',
      from: SPARK_MODEL,
      to: FALLBACK_MODEL,
      reason: `Spark weekly at ${usage.spark.weekly}% — swapping to prevent limit bug`,
    });
  }

  // 2. Spark recovery — swap back when safe
  if (currentModel === FALLBACK_MODEL && usage.spark.h5 <= SPARK_SWAP_BACK_PCT && usage.spark.weekly <= SPARK_SWAP_BACK_PCT) {
    actions.push({
      type: 'swap',
      from: FALLBACK_MODEL,
      to: SPARK_MODEL,
      reason: `Spark recovered: 5h=${usage.spark.h5}%, weekly=${usage.spark.weekly}% — swapping back to save main quota`,
    });
  }

  // 3. Main quota warnings
  if (usage.main.h5 >= MAIN_PAUSE_5H_PCT) {
    actions.push({ type: 'alert', level: 'PAUSE', reason: `Main 5h at ${usage.main.h5}% — agents should PAUSE` });
  } else if (usage.main.h5 >= MAIN_WARN_5H_PCT) {
    actions.push({ type: 'alert', level: 'WARN', reason: `Main 5h at ${usage.main.h5}% — approaching limit` });
  }
  if (usage.main.weekly >= MAIN_WARN_WEEKLY_PCT) {
    actions.push({ type: 'alert', level: 'WARN', reason: `Main weekly at ${usage.main.weekly}% — running low` });
  }

  // --- Output ---

  const statusIcon = actions.some(a => a.level === 'PAUSE') ? '🔴' :
                     actions.some(a => a.type === 'swap' || a.level === 'WARN') ? '🟡' : '🟢';

  if (statusOnly) {
    console.log(`${statusIcon} main[5h:${100 - usage.main.h5}% w:${100 - usage.main.weekly}%] spark[5h:${100 - usage.spark.h5}% w:${100 - usage.spark.weekly}%] hb:${currentModel.split('/')[1]} review:${100 - usage.codeReview}%`);
    return;
  }

  console.log(`[${usage.timestamp}] ${statusIcon} Budget Guardian`);
  console.log(`  Main:   5h=${usage.main.h5}% weekly=${usage.main.weekly}%`);
  console.log(`  Spark:  5h=${usage.spark.h5}% weekly=${usage.spark.weekly}%`);
  console.log(`  Review: ${usage.codeReview}%`);
  console.log(`  HB model: ${currentModel}`);

  if (actions.length === 0) {
    console.log('  ✅ No action needed');
  }

  for (const action of actions) {
    if (action.type === 'swap') {
      console.log(`  🔄 ${action.reason}`);
      if (!dryRun) {
        const result = swapHeartbeatModel(action.to);
        if (result.swapped) {
          console.log(`  ✅ Swapped: ${result.from} → ${result.to}`);
          state.currentHeartbeatModel = action.to;
          state.lastSwap = usage.timestamp;
          state.swapReason = action.reason;
          sendAlert(`🔄 *Budget Guardian*\n${action.reason}\nHeartbeats: \`${result.from}\` → \`${result.to}\``);
        }
      } else {
        console.log(`  (dry run — would swap ${action.from} → ${action.to})`);
      }
    } else if (action.type === 'alert') {
      console.log(`  ⚠️  [${action.level}] ${action.reason}`);
      if (!dryRun && action.level === 'PAUSE') {
        sendAlert(`🔴 *Budget Guardian PAUSE*\n${action.reason}\nAgents should stop new tasks.`);
      }
    }
  }

  // Update state
  state.lastRun = usage.timestamp;
  state.lastUsage = usage;
  saveState(state);
}

// CLI
const args = process.argv.slice(2);
run({
  dryRun: args.includes('--dry'),
  statusOnly: args.includes('--status'),
}).catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
