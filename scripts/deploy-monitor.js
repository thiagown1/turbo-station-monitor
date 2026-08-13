#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { deployMonitor } = require('../services/lib/monitor-auto-deploy');

const repoDir = path.resolve(__dirname, '..');
const logPath = path.join(repoDir, 'logs', 'monitor-deploy.log');
const targetSha = process.argv[2];
const commitMessage = String(process.argv[3] || '').slice(0, 120);
const pusher = String(process.argv[4] || 'unknown').slice(0, 80);
const openClawBin = process.env.OPENCLAW_CLI || '/home/openclaw/.npm-global/bin/openclaw';
const telegramTarget = process.env.MONITOR_DEPLOY_TELEGRAM_TARGET || 'telegram:-5103508388';

fs.mkdirSync(path.dirname(logPath), { recursive: true });

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  fs.appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

function notify(message) {
  return new Promise((resolve) => {
    execFile(openClawBin, [
      'message', 'send', '--channel', 'telegram', '--target', telegramTarget, '--message', message,
    ], { timeout: 15000 }, (error) => {
      if (error) log(`[auto-deploy] notification failed: ${error.message}`);
      resolve();
    });
  });
}

(async () => {
  log(`[auto-deploy] requested ${String(targetSha || '').slice(0, 8)} by ${pusher}: ${commitMessage}`);
  try {
    const result = await deployMonitor({ sha: targetSha, repoDir, log });
    await notify(
      `✅ Turbo Monitor ${result.targetSha.slice(0, 8)} publicado após CI verde. ` +
      `Reiniciados: ${result.services.join(', ') || 'nenhum serviço'}.`
    );
  } catch (error) {
    log(`[auto-deploy] failed: ${error.stack || error.message}`);
    await notify(`❌ Auto-deploy do Turbo Monitor falhou: ${String(error.message).slice(0, 500)}`);
    process.exitCode = 1;
  }
})();
