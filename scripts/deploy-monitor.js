#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  deployMonitor,
  notifyDeploy,
  restartServices,
} = require('../services/lib/monitor-auto-deploy');

// Load .env the same way ecosystem.config.js does. Spawned by the webhook this is
// redundant (pm2 already injected it), but a manual run over SSH inherits the
// operator's shell instead — which is why a hand-triggered deploy reported
// "SUPPORT_API_SECRET/MONITOR_API_SECRET not set" and could notify nobody.
// Real environment always wins; this only fills gaps.
(function loadDotenv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
})();

const repoDir = path.resolve(__dirname, '..');
const logPath = path.join(repoDir, 'logs', 'monitor-deploy.log');
const targetSha = process.argv[2];
const commitMessage = String(process.argv[3] || '').slice(0, 120);
const pusher = String(process.argv[4] || 'unknown').slice(0, 80);

fs.mkdirSync(path.dirname(logPath), { recursive: true });

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  fs.appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

async function notify(message) {
  const { delivered, reason } = await notifyDeploy(message);
  // An undelivered notification is itself news: it means the next deploy
  // failure would also go unheard. Log it at the same volume as a deploy error.
  if (!delivered) log(`[auto-deploy] NOTIFICATION UNDELIVERED (${reason}) — mensagem era: ${String(message).slice(0, 200)}`);
}

(async () => {
  log(`[auto-deploy] requested ${String(targetSha || '').slice(0, 8)} by ${pusher}: ${commitMessage}`);
  try {
    const result = await deployMonitor({ sha: targetSha, repoDir, log });
    await notify(
      `✅ Turbo Monitor ${result.targetSha.slice(0, 8)} publicado após CI verde. ` +
      `Reiniciados: ${result.services.join(', ') || 'nenhum serviço'}.`
    );
    // LAST, and only now: restarting the webhook kills this very process (pm2
    // treekill, see SELF_SERVICE). Everything above is already durable — SHA
    // recorded, health checked, notification sent — so dying here costs nothing.
    // The pm2 daemon completes the restart even if we do not survive the call.
    const deferred = result.deferredServices || [];
    if (deferred.length) {
      log(`[auto-deploy] restarting last: ${deferred.join(', ')}`);
      await restartServices(deferred, {
        pm2Bin: process.env.PM2_BIN || '/home/openclaw/.npm-global/bin/pm2',
        repoDir,
      });
    }
  } catch (error) {
    log(`[auto-deploy] failed: ${error.stack || error.message}`);
    await notify(`❌ Auto-deploy do Turbo Monitor falhou: ${String(error.message).slice(0, 500)}`);
    process.exitCode = 1;
  }
})();
