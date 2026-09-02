'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  parsePm2Apps,
  validateApprovedDump,
  hasUnixSocketListener,
} = require('./pm2-topology');

const DEFAULTS = Object.freeze({
  pm2Bin: '/home/openclaw/.npm-global/bin/pm2',
  systemctlBin: '/usr/bin/systemctl',
  systemdUnit: 'pm2-openclaw.service',
  pm2Home: '/home/openclaw/.pm2',
  repoDir: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
  manifestPath: '/etc/turbo-station-monitor/pm2-recovery.json',
  procNetUnixPath: '/proc/net/unix',
  statePath: '/var/lib/turbo-station-monitor/pm2-reconcile-state.json',
  cooldownMs: 15 * 60_000,
  crashLoopThreshold: 3,
  socketWaitAttempts: 30,
  socketWaitIntervalMs: 1_000,
});

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
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

function acquireMutationLock(lockPath, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  const create = () => {
    const fd = fsImpl.openSync(lockPath, 'wx');
    try {
      fsImpl.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    } finally {
      fsImpl.closeSync(fd);
    }
  };
  try {
    create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid = null;
    try {
      pid = Number.parseInt(fsImpl.readFileSync(lockPath, 'utf8').split(/\r?\n/)[0], 10);
    } catch {}
    let active = Number.isInteger(pid) && pid > 0;
    if (active) {
      try { process.kill(pid, 0); } catch (probeError) {
        if (probeError.code === 'ESRCH') active = false;
        else throw probeError;
      }
    }
    if (active) {
      const locked = new Error(`another PM2 mutation is already running (pid ${pid})`);
      locked.code = 'EPM2LOCKED';
      throw locked;
    }
    fsImpl.unlinkSync(lockPath);
    try {
      create();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') {
        throw new Error('another PM2 mutation acquired the lock concurrently');
      }
      throw retryError;
    }
  }
}

function classifyLiveTopology(liveApps, approved, crashLoopThreshold) {
  const live = new Map();
  const duplicates = [];
  for (const app of liveApps) {
    if (live.has(app.name)) duplicates.push(app.name);
    else live.set(app.name, app);
  }
  const missing = [...approved.processes.values()]
    .filter((spec) => spec.mode !== 'disabled' && !live.has(spec.name))
    .map((spec) => spec.name);
  const unexpected = [...live.keys()].filter((name) => !approved.processes.has(name));
  const pathMismatches = [];
  const notOnline = [];
  const forbiddenDisabled = [];
  const crashLoops = [];
  for (const [name, app] of live) {
    const spec = approved.processes.get(name);
    if (!spec) continue;
    if (app.execPath !== spec.execPath) pathMismatches.push(`${name} (${app.execPath || '(empty)'})`);
    if (spec.mode === 'disabled') {
      forbiddenDisabled.push(`${name} is registered (${app.status})`);
      continue;
    }
    if (spec.mode === 'online' && app.status !== 'online') {
      notOnline.push(`${name} is ${app.status}`);
    }
    if (spec.mode === 'registered' && !['online', 'stopped'].includes(app.status)) {
      notOnline.push(`${name} is ${app.status}`);
    }
    if (app.unstableRestarts >= crashLoopThreshold) {
      crashLoops.push(`${name} has ${app.unstableRestarts} unstable restarts`);
    }
  }
  return { live, missing, unexpected, duplicates, pathMismatches, notOnline, forbiddenDisabled, crashLoops };
}

function assertNoUnsafeLiveState(state) {
  const failures = [
    state.unexpected.length ? `unexpected live PM2 process(es): ${state.unexpected.join(', ')}` : null,
    state.duplicates.length ? `duplicate live PM2 process(es): ${state.duplicates.join(', ')}` : null,
    state.pathMismatches.length ? `live executable path mismatch: ${state.pathMismatches.join(', ')}` : null,
    state.forbiddenDisabled.length ? `operator-gated PM2 process(es) must be absent: ${state.forbiddenDisabled.join(', ')}` : null,
    state.notOnline.length ? state.notOnline.join(', ') : null,
    state.crashLoops.length ? state.crashLoops.join(', ') : null,
  ].filter(Boolean);
  if (failures.length) {
    throw new Error(`${failures.join('; ')}; refusing a full-daemon restart — use targeted recovery`);
  }
}

function lastRecoveryAt(statePath, fsImpl = fs) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
    return Number.isFinite(value.lastRecoveryAt) ? value.lastRecoveryAt : null;
  } catch {
    return null;
  }
}

function writeRecoveryState(statePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fsImpl.renameSync(temporary, statePath);
}

async function reconcilePm2(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const dumpPath = o.dumpPath || path.join(o.pm2Home, 'dump.pm2');
  const socketPath = o.socketPath || path.join(o.pm2Home, 'rpc.sock');
  const lockPath = o.lockPath || path.join(o.repoDir, 'db', '.monitor-deploy.lock');
  const fsImpl = o.fsImpl || fs;
  const run = o.run || execFilePromise;
  const sleepFn = o.sleepFn || sleep;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const readProcNetUnix = o.readProcNetUnix
    || (() => fsImpl.readFileSync(o.procNetUnixPath, 'utf8'));

  if (!path.isAbsolute(o.pm2Bin) || !path.isAbsolute(o.systemctlBin)) {
    throw new Error('PM2 and systemctl executables must use absolute paths');
  }
  if (!/^[A-Za-z0-9@_.-]+\.service$/.test(o.systemdUnit)) {
    throw new Error(`invalid PM2 systemd unit: ${o.systemdUnit}`);
  }

  acquireMutationLock(lockPath, fsImpl);
  try {
    const manifestRaw = fsImpl.readFileSync(o.manifestPath, 'utf8');
    const dumpRaw = fsImpl.readFileSync(dumpPath, 'utf8');
    const approved = validateApprovedDump({
      manifestRaw,
      dumpRaw,
      pathProbe: o.pathProbe,
      fsImpl,
    });

    const readLive = async () => {
      const { stdout } = await run(o.pm2Bin, ['jlist'], { cwd: o.repoDir, timeout: 30_000 });
      return parsePm2Apps(stdout, 'live PM2 inventory', { allowEmpty: true });
    };

    const recover = async (reason) => {
      if (o.checkOnly) {
        return { action: 'would-recover', reason, checked: approved.processes.size };
      }
      const previous = lastRecoveryAt(o.statePath, fsImpl);
      const timestamp = now();
      if (previous !== null && timestamp - previous < o.cooldownMs) {
        throw new Error(`PM2 recovery cooldown active after ${new Date(previous).toISOString()}; refusing restart storm`);
      }

      // Close the validation-to-action window: a concurrent pm2 save must not
      // swap in an unreviewed dump after the first validation.
      const currentDumpRaw = fsImpl.readFileSync(dumpPath, 'utf8');
      const currentApproved = validateApprovedDump({
        manifestRaw,
        dumpRaw: currentDumpRaw,
        pathProbe: o.pathProbe,
        fsImpl,
      });
      if (currentApproved.dumpFingerprint !== approved.dumpFingerprint) {
        throw new Error('persisted PM2 inventory changed during reconciliation; refusing systemd restart');
      }

      await run(o.systemctlBin, ['restart', o.systemdUnit], { timeout: 60_000 });
      writeRecoveryState(o.statePath, { lastRecoveryAt: timestamp, reason }, fsImpl);

      let listening = false;
      for (let attempt = 1; attempt <= o.socketWaitAttempts; attempt += 1) {
        listening = hasUnixSocketListener(readProcNetUnix(), socketPath);
        if (listening) break;
        if (attempt < o.socketWaitAttempts) await sleepFn(o.socketWaitIntervalMs);
      }
      if (!listening) throw new Error(`PM2 RPC socket did not listen at ${socketPath} after systemd restart`);

      const postApps = await readLive();
      const post = classifyLiveTopology(postApps, approved, o.crashLoopThreshold);
      assertNoUnsafeLiveState(post);
      if (post.missing.length) {
        throw new Error(`PM2 recovery remained incomplete; missing: ${post.missing.join(', ')}`);
      }
      return { action: 'recovered', reason, checked: approved.processes.size };
    };

    if (!hasUnixSocketListener(readProcNetUnix(), socketPath)) {
      return recover('daemon-absent');
    }

    const liveApps = await readLive();
    const state = classifyLiveTopology(liveApps, approved, o.crashLoopThreshold);
    assertNoUnsafeLiveState(state);
    if (state.missing.length) return recover('partial-topology');
    return { action: 'healthy', reason: null, checked: approved.processes.size };
  } finally {
    try { fsImpl.unlinkSync(lockPath); } catch {}
  }
}

function integerEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  try {
    const result = await reconcilePm2({
      pm2Bin: process.env.PM2_BIN || DEFAULTS.pm2Bin,
      systemctlBin: process.env.PM2_SYSTEMCTL_BIN || DEFAULTS.systemctlBin,
      systemdUnit: process.env.PM2_SYSTEMD_UNIT || DEFAULTS.systemdUnit,
      pm2Home: process.env.PM2_HOME || DEFAULTS.pm2Home,
      repoDir: process.env.MONITOR_REPO_DIR || DEFAULTS.repoDir,
      manifestPath: process.env.PM2_RECOVERY_MANIFEST || DEFAULTS.manifestPath,
      dumpPath: process.env.PM2_DUMP_PATH,
      lockPath: process.env.PM2_RECONCILE_LOCK,
      statePath: process.env.PM2_RECONCILE_STATE || DEFAULTS.statePath,
      cooldownMs: integerEnv(process.env.PM2_RECONCILE_COOLDOWN_MS, DEFAULTS.cooldownMs),
      crashLoopThreshold: integerEnv(process.env.PM2_CRASH_LOOP_THRESHOLD, DEFAULTS.crashLoopThreshold),
      checkOnly: process.argv.includes('--check-only') || process.env.PM2_RECONCILE_CHECK_ONLY === '1',
    });
    console.log(JSON.stringify({ event: 'pm2-reconcile', ...result }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pm2-reconcile-failed',
      error: error && error.message ? error.message : String(error),
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULTS,
  acquireMutationLock,
  classifyLiveTopology,
  reconcilePm2,
};
