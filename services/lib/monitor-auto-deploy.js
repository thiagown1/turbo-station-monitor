'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const REPOSITORY = 'thiagown1/turbo-station-monitor';
const ALL_SERVICES = [
  'ocpp-collector',
  'ocpp-alerts',
  'vercel-drain',
  'github-webhook',
  'mobile-telemetry',
  'pagarme-status-webhook',
  'alert-engine',
  'support-copilot',
  'whatsapp-gateway',
];

const SERVICE_RULES = [
  ['services/support-copilot/', ['support-copilot']],
  ['services/whatsapp-gateway/', ['whatsapp-gateway']],
  ['services/smart-collector.js', ['ocpp-collector']],
  ['services/alert-processor.js', ['ocpp-alerts']],
  ['services/vercel-drain.js', ['vercel-drain']],
  ['services/github-webhook.js', ['github-webhook']],
  ['services/mobile-telemetry/', ['mobile-telemetry']],
  ['services/pagarme-status-webhook.js', ['pagarme-status-webhook']],
  ['services/alert-engine.js', ['alert-engine']],
];

const HEALTH_ENDPOINTS = {
  'vercel-drain': 'http://127.0.0.1:3001/health',
  'github-webhook': 'http://127.0.0.1:3002/health',
  'mobile-telemetry': 'http://127.0.0.1:3003/health',
  'support-copilot': 'http://127.0.0.1:3005/health',
};

function assertCommitSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid commit SHA: ${value || '(empty)'}`);
  return sha;
}

function servicesForFiles(files) {
  const normalized = files.map((file) => String(file || '').replace(/\\/g, '/')).filter(Boolean);
  if (normalized.some((file) =>
    file === 'ecosystem.config.js' ||
    file === 'package.json' ||
    file === 'package-lock.json' ||
    file.startsWith('services/lib/')
  )) return new Set(ALL_SERVICES);

  const services = new Set();
  for (const file of normalized) {
    for (const [prefix, names] of SERVICE_RULES) {
      if (file === prefix || file.startsWith(prefix)) names.forEach((name) => services.add(name));
    }
  }
  return services;
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSuccessfulCi({
  sha,
  run = execFilePromise,
  sleepFn = sleep,
  ghBin = process.env.GH_BIN || '/usr/bin/gh',
  attempts = 90,
  intervalMs = 10000,
  log = () => {},
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { stdout } = await run(ghBin, [
      'run', 'list', '--repo', REPOSITORY, '--workflow', 'CI', '--branch', 'main',
      '--event', 'push', '--commit', sha, '--limit', '1', '--json', 'status,conclusion,url',
    ]);
    const runs = JSON.parse(stdout || '[]');
    const latest = runs[0];
    if (latest?.status === 'completed') {
      if (latest.conclusion === 'success') return latest;
      throw new Error(`CI for ${sha.slice(0, 8)} completed with ${latest.conclusion || 'unknown conclusion'}${latest.url ? `: ${latest.url}` : ''}`);
    }
    log(`[auto-deploy] waiting for CI (${attempt}/${attempts})`);
    if (attempt < attempts) await sleepFn(intervalMs);
  }
  throw new Error(`timed out waiting for CI for ${sha.slice(0, 8)}`);
}

function requestHealth(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`${url} returned HTTP ${res.statusCode}`));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
  });
}

async function verifyHealth(services, { check = requestHealth, sleepFn = sleep, attempts = 12 } = {}) {
  for (const service of services) {
    const url = HEALTH_ENDPOINTS[service];
    if (!url) continue;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await check(url);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleepFn(1000);
      }
    }
    if (lastError) throw new Error(`${service} health check failed: ${lastError.message}`);
  }
}

function readStateSha(statePath, fallbackSha, fsImpl = fs) {
  try {
    return assertCommitSha(fsImpl.readFileSync(statePath, 'utf8'));
  } catch {
    return fallbackSha;
  }
}

function acquireLock(lockPath, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fsImpl.openSync(lockPath, 'wx');
    fsImpl.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fsImpl.closeSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const raw = fsImpl.readFileSync(lockPath, 'utf8');
      const pid = Number.parseInt(raw.split(/\r?\n/)[0], 10);
      let running = Number.isInteger(pid) && pid > 0;
      if (running) {
        try { process.kill(pid, 0); } catch (probeError) {
          if (probeError.code === 'ESRCH') running = false;
          else throw probeError;
        }
      }
      if (running) throw new Error(`another monitor deploy is already running (${lockPath}, pid ${pid})`);
      fsImpl.unlinkSync(lockPath);
      return acquireLock(lockPath, fsImpl);
    }
    throw error;
  }
}

async function deployMonitor({
  sha,
  repoDir,
  run = execFilePromise,
  waitForCi = waitForSuccessfulCi,
  checkHealth = verifyHealth,
  fsImpl = fs,
  gitBin = process.env.GIT_BIN || '/usr/bin/git',
  npmBin = process.env.NPM_BIN || '/usr/bin/npm',
  pm2Bin = process.env.PM2_BIN || '/home/openclaw/.npm-global/bin/pm2',
  statePath = path.join(repoDir, 'db', '.monitor-deployed-sha'),
  lockPath = path.join(repoDir, 'db', '.monitor-deploy.lock'),
  log = () => {},
}) {
  const targetSha = assertCommitSha(sha);
  acquireLock(lockPath, fsImpl);
  try {
    await waitForCi({ sha: targetSha, run, log });
    await run(gitBin, ['fetch', '--prune', 'origin', 'main'], { cwd: repoDir });

    const { stdout: remoteOut } = await run(gitBin, ['rev-parse', 'origin/main'], { cwd: repoDir });
    const remoteSha = assertCommitSha(remoteOut);
    if (remoteSha !== targetSha) throw new Error(`origin/main is ${remoteSha.slice(0, 8)}, expected ${targetSha.slice(0, 8)}`);

    const { stdout: dirtyOut } = await run(gitBin, ['status', '--porcelain', '--untracked-files=all'], { cwd: repoDir });
    if (dirtyOut.trim()) {
      const paths = dirtyOut.trim().split(/\r?\n/).slice(0, 8).join(', ');
      throw new Error(`production checkout is dirty; refusing deploy: ${paths}`);
    }

    const { stdout: headOut } = await run(gitBin, ['rev-parse', 'HEAD'], { cwd: repoDir });
    const headSha = assertCommitSha(headOut);
    const deployedSha = readStateSha(statePath, headSha, fsImpl);
    const { stdout: diffOut } = await run(gitBin, ['diff', '--name-only', deployedSha, targetSha], { cwd: repoDir });
    const changedFiles = diffOut.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const services = servicesForFiles(changedFiles);

    if (headSha !== targetSha) {
      await run(gitBin, ['merge', '--ff-only', targetSha], { cwd: repoDir });
    }

    await run(npmBin, ['ci', '--omit=dev'], { cwd: repoDir, timeout: 180000 });
    if (fsImpl.existsSync(path.join(repoDir, 'services', 'support-copilot', 'package-lock.json'))) {
      await run(npmBin, ['ci', '--omit=dev', '--prefix', 'services/support-copilot'], { cwd: repoDir, timeout: 180000 });
    }

    for (const service of services) {
      await run(pm2Bin, ['restart', service, '--update-env'], { cwd: repoDir, timeout: 30000 });
    }
    await checkHealth([...services]);
    await run(pm2Bin, ['save'], { cwd: repoDir, timeout: 30000 });

    fsImpl.writeFileSync(statePath, `${targetSha}\n`, 'utf8');
    log(`[auto-deploy] deployed ${targetSha.slice(0, 8)}; restarted: ${[...services].join(', ') || 'none'}`);
    return { targetSha, deployedSha, changedFiles, services: [...services] };
  } finally {
    try { fsImpl.unlinkSync(lockPath); } catch {}
  }
}

/**
 * Announce a deploy outcome on the channel the team actually reads.
 *
 * This used to shell `openclaw message send --channel telegram`. Telegram was
 * dropped as an alert channel (team decision 2026-06-22) and that transport is
 * not linked on the box, so every notification failed — which meant the
 * auto-deploy failed SILENTLY. On 2026-08-18 three deploys in a row were
 * refused for a dirty checkout (PRs #49, #50, #51 merged and never reached
 * production) and nobody was told; it only surfaced because someone went
 * looking at the log by hand.
 *
 * Same transport as the alert-engine: POST to the support-copilot API, which
 * fans out to WhatsApp via Evolution. Returns { delivered, reason } instead of
 * throwing — a broken notification must never fail a deploy that succeeded.
 * When it cannot deliver, the reason is returned so the caller logs it loudly:
 * an undelivered notification is itself news.
 */
async function notifyDeploy(message, options = {}) {
  const {
    apiBase = process.env.SUPPORT_API_BASE || 'http://127.0.0.1:3005',
    conversationId = process.env.MONITOR_DEPLOY_WHATSAPP_CONV || process.env.ALERT_WHATSAPP_CONV || 'conv_jiuijxjtmnet23i9',
    brandId = process.env.ALERT_WHATSAPP_BRAND || 'turbo',
    secret = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '',
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
  } = options;

  if (!conversationId) return { delivered: false, reason: 'no conversation configured' };
  if (!secret) return { delivered: false, reason: 'SUPPORT_API_SECRET/MONITOR_API_SECRET not set' };
  if (typeof fetchImpl !== 'function') return { delivered: false, reason: 'no fetch implementation' };

  const url = `${apiBase}/api/support/conversations/${encodeURIComponent(conversationId)}/messages`
    + `?brandId=${encodeURIComponent(brandId)}`;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': secret,
        'x-brand-id': brandId,
      },
      body: JSON.stringify({ body: String(message), source: 'system' }),
      signal: controller ? controller.signal : undefined,
    });
    if (!res || !res.ok) return { delivered: false, reason: `support API ${res ? res.status : 'no response'}` };
    return { delivered: true, reason: null };
  } catch (error) {
    return { delivered: false, reason: error && error.message ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  ALL_SERVICES,
  HEALTH_ENDPOINTS,
  assertCommitSha,
  servicesForFiles,
  waitForSuccessfulCi,
  verifyHealth,
  deployMonitor,
  execFilePromise,
  notifyDeploy,
};
