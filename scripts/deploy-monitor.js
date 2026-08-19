#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { deployMonitor, notifyDeploy } = require('../services/lib/monitor-auto-deploy');

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
  } catch (error) {
    log(`[auto-deploy] failed: ${error.stack || error.message}`);
    await notify(`❌ Auto-deploy do Turbo Monitor falhou: ${String(error.message).slice(0, 500)}`);
    process.exitCode = 1;
  }
})();
