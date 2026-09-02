'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REQUIRED_MONITOR_PROCESSES,
  DISABLED_MONITOR_PROCESSES,
  validateApprovedDump,
} = require('../services/lib/pm2-topology');
const { reconcilePm2 } = require('../services/lib/pm2-reconciler');

const PM2_BIN = '/home/openclaw/.npm-global/bin/pm2';
const SYSTEMCTL_BIN = '/usr/bin/systemctl';
const SERVICE = 'pm2-openclaw.service';
const NOW = Date.parse('2026-09-02T20:00:00Z');

function socketTable(socketPath) {
  return `Num RefCount Protocol Flags Type St Inode Path\n0001: 00000002 00000000 00010000 0001 01 42 ${socketPath}\n`;
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-reconciler-'));
  const executableDir = path.join(dir, 'apps');
  fs.mkdirSync(executableDir);
  const processSpecs = [
    ...REQUIRED_MONITOR_PROCESSES.map((name) => ({ name, mode: 'online' })),
    { name: 'blog-generator', mode: 'registered' },
    ...DISABLED_MONITOR_PROCESSES.map((name) => ({ name, mode: 'disabled' })),
  ].map((spec) => {
    const execPath = path.join(executableDir, `${spec.name}.js`);
    fs.writeFileSync(execPath, '// fixture\n');
    return { ...spec, execPath };
  });
  const manifestPath = path.join(dir, 'approved-topology.json');
  const dumpPath = path.join(dir, 'dump.pm2');
  const procNetUnixPath = path.join(dir, 'proc-net-unix');
  const socketPath = path.join(dir, 'rpc.sock');
  const lockPath = path.join(dir, 'pm2.lock');
  const statePath = path.join(dir, 'pm2-state.json');
  const manifest = { version: 1, processes: processSpecs };
  const apps = processSpecs.filter(({ mode }) => mode !== 'disabled').map(({ name, mode, execPath }) => ({
    name,
    pm_exec_path: execPath,
    exec_interpreter: 'node',
    pm2_env: {
      status: mode === 'online' ? 'online' : 'stopped',
      unstable_restarts: 0,
      restart_time: 0,
    },
  }));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(dumpPath, JSON.stringify(apps));
  fs.writeFileSync(procNetUnixPath, socketTable(socketPath));
  return {
    dir,
    manifest,
    apps,
    manifestPath,
    dumpPath,
    procNetUnixPath,
    socketPath,
    lockPath,
    statePath,
  };
}

function options(fixture, overrides = {}) {
  return {
    pm2Bin: PM2_BIN,
    systemctlBin: SYSTEMCTL_BIN,
    systemdUnit: SERVICE,
    repoDir: fixture.dir,
    manifestPath: fixture.manifestPath,
    dumpPath: fixture.dumpPath,
    procNetUnixPath: fixture.procNetUnixPath,
    socketPath: fixture.socketPath,
    lockPath: fixture.lockPath,
    statePath: fixture.statePath,
    now: () => NOW,
    sleepFn: async () => {},
    socketWaitAttempts: 2,
    socketWaitIntervalMs: 1,
    ...overrides,
  };
}

test('approved dump requires the curated monitor core and exact readable executable paths', () => {
  const fixture = makeFixture();
  const approved = validateApprovedDump({
    manifestRaw: JSON.stringify(fixture.manifest),
    dumpRaw: JSON.stringify(fixture.apps),
  });
  assert.equal(approved.processes.size, fixture.apps.length + DISABLED_MONITOR_PROCESSES.length);
  assert.equal(approved.requiredOnline.size, REQUIRED_MONITOR_PROCESSES.length);
  assert.deepEqual([...approved.disabled].sort(), [...DISABLED_MONITOR_PROCESSES].sort());

  const stoppedDump = fixture.apps.map((app) => app.name === 'alert-engine'
    ? { ...app, pm2_env: { ...app.pm2_env, status: 'stopped' } }
    : app);
  assert.throws(
    () => validateApprovedDump({
      manifestRaw: JSON.stringify(fixture.manifest),
      dumpRaw: JSON.stringify(stoppedDump),
    }),
    /alert-engine.*stopped/i,
  );

  const incompleteManifest = {
    ...fixture.manifest,
    processes: fixture.manifest.processes.filter((p) => p.name !== 'whatsapp-gateway'),
  };
  assert.throws(
    () => validateApprovedDump({
      manifestRaw: JSON.stringify(incompleteManifest),
      dumpRaw: JSON.stringify(fixture.apps),
    }),
    /manifest.*missing required.*whatsapp-gateway/i,
  );

  const missingDisabledContract = {
    ...fixture.manifest,
    processes: fixture.manifest.processes.filter((p) => p.name !== 'ocpp-alerts'),
  };
  assert.throws(
    () => validateApprovedDump({
      manifestRaw: JSON.stringify(missingDisabledContract),
      dumpRaw: JSON.stringify(fixture.apps),
    }),
    /manifest.*operator-gated.*disabled.*ocpp-alerts/i,
  );

  const activatedWithoutApproval = {
    ...fixture.manifest,
    processes: fixture.manifest.processes.map((p) => p.name === 'cleanup-vercel-db'
      ? { ...p, mode: 'registered' }
      : p),
  };
  assert.throws(
    () => validateApprovedDump({
      manifestRaw: JSON.stringify(activatedWithoutApproval),
      dumpRaw: JSON.stringify(fixture.apps),
    }),
    /manifest.*operator-gated.*disabled.*cleanup-vercel-db/i,
  );

  const mismatched = fixture.apps.map((app) => (
    app.name === 'ocpp-collector' ? { ...app, pm_exec_path: path.join(fixture.dir, 'other.js') } : app
  ));
  assert.throws(
    () => validateApprovedDump({
      manifestRaw: JSON.stringify(fixture.manifest),
      dumpRaw: JSON.stringify(mismatched),
    }),
    /ocpp-collector.*executable path mismatch/i,
  );

  const unsafeDisabledDump = [
    ...fixture.apps,
    {
      name: 'ocpp-alerts',
      pm_exec_path: fixture.manifest.processes.find((p) => p.name === 'ocpp-alerts').execPath,
      exec_interpreter: 'node',
      pm2_env: { status: 'stopped', unstable_restarts: 0, restart_time: 0 },
    },
  ];
  assert.throws(
    () => validateApprovedDump({
      manifestRaw: JSON.stringify(fixture.manifest),
      dumpRaw: JSON.stringify(unsafeDisabledDump),
    }),
    /operator-gated.*must be absent.*ocpp-alerts/i,
  );
});

test('healthy topology performs only a direct absolute-path jlist', async () => {
  const fixture = makeFixture();
  const calls = [];
  const result = await reconcilePm2(options(fixture, {
    run: async (command, args) => {
      calls.push([command, ...args]);
      assert.equal(command, PM2_BIN);
      assert.deepEqual(args, ['jlist']);
      return { stdout: JSON.stringify(fixture.apps) };
    },
  }));
  assert.equal(result.action, 'healthy');
  assert.deepEqual(calls, [[PM2_BIN, 'jlist']]);
});

test('dead daemon is recovered from a validated dump without jlist before the socket exists', async () => {
  const fixture = makeFixture();
  let socketLive = false;
  fs.writeFileSync(fixture.procNetUnixPath, 'Num RefCount Protocol Flags Type St Inode Path\n');
  const calls = [];
  const result = await reconcilePm2(options(fixture, {
    readProcNetUnix: () => socketLive ? socketTable(fixture.socketPath) : '',
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === SYSTEMCTL_BIN) {
        assert.deepEqual(args, ['restart', SERVICE]);
        socketLive = true;
        return { stdout: '' };
      }
      assert.equal(socketLive, true, 'jlist must not run before the replacement RPC socket listens');
      assert.equal(command, PM2_BIN);
      return { stdout: JSON.stringify(fixture.apps) };
    },
  }));
  assert.equal(result.action, 'recovered');
  assert.equal(result.reason, 'daemon-absent');
  assert.deepEqual(calls[0], [SYSTEMCTL_BIN, 'restart', SERVICE]);
  assert.deepEqual(calls[1], [PM2_BIN, 'jlist']);
});

test('check-only reports recovery intent without invoking systemctl', async () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.procNetUnixPath, '');
  let calls = 0;
  const result = await reconcilePm2(options(fixture, {
    checkOnly: true,
    run: async () => { calls += 1; return { stdout: '' }; },
  }));
  assert.equal(result.action, 'would-recover');
  assert.equal(result.reason, 'daemon-absent');
  assert.equal(calls, 0);
});

test('partial fresh daemon restarts the systemd unit once and verifies the result', async () => {
  const fixture = makeFixture();
  const calls = [];
  let recovered = false;
  const result = await reconcilePm2(options(fixture, {
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === SYSTEMCTL_BIN) {
        recovered = true;
        return { stdout: '' };
      }
      return {
        stdout: JSON.stringify(recovered ? fixture.apps : fixture.apps.slice(0, -1)),
      };
    },
  }));
  assert.equal(result.action, 'recovered');
  assert.equal(result.reason, 'partial-topology');
  assert.equal(calls.filter((call) => call[0] === SYSTEMCTL_BIN).length, 1);
});

test('invalid dump, unexpected apps, errored apps and crash loops fail without full-daemon restart', async () => {
  const cases = [
    {
      name: 'unexpected',
      apps: (f) => [...f.apps, { name: 'ad-hoc', pm_exec_path: '/tmp/ad-hoc', pm2_env: { status: 'online' } }],
      pattern: /unexpected live PM2/i,
    },
    {
      name: 'errored',
      apps: (f) => f.apps.map((app) => app.name === 'alert-engine'
        ? { ...app, pm2_env: { ...app.pm2_env, status: 'errored' } }
        : app),
      pattern: /alert-engine.*errored/i,
    },
    {
      name: 'registered cron errored',
      apps: (f) => f.apps.map((app) => app.name === 'blog-generator'
        ? { ...app, pm2_env: { ...app.pm2_env, status: 'errored' } }
        : app),
      pattern: /blog-generator.*errored/i,
    },
    {
      name: 'disabled process unexpectedly registered',
      apps: (f) => [...f.apps, {
        name: 'cleanup-vercel-db',
        pm_exec_path: f.manifest.processes.find((p) => p.name === 'cleanup-vercel-db').execPath,
        pm2_env: { status: 'stopped', unstable_restarts: 0, restart_time: 0 },
      }],
      pattern: /operator-gated.*must be absent.*cleanup-vercel-db/i,
    },
    {
      name: 'crash-loop',
      apps: (f) => f.apps.map((app) => app.name === 'support-copilot'
        ? { ...app, pm2_env: { ...app.pm2_env, unstable_restarts: 3 } }
        : app),
      pattern: /support-copilot.*unstable restarts/i,
    },
  ];

  for (const scenario of cases) {
    const fixture = makeFixture();
    let systemctlCalls = 0;
    await assert.rejects(
      reconcilePm2(options(fixture, {
        run: async (command) => {
          if (command === SYSTEMCTL_BIN) systemctlCalls += 1;
          return { stdout: JSON.stringify(scenario.apps(fixture)) };
        },
      })),
      scenario.pattern,
      scenario.name,
    );
    assert.equal(systemctlCalls, 0, `${scenario.name} must not restart the whole daemon`);
  }

  const invalid = makeFixture();
  fs.writeFileSync(invalid.dumpPath, '[]');
  let anyCalls = 0;
  await assert.rejects(
    reconcilePm2(options(invalid, { run: async () => { anyCalls += 1; return { stdout: '' }; } })),
    /persisted PM2 inventory is empty/i,
  );
  assert.equal(anyCalls, 0, 'invalid dump is rejected before PM2 or systemctl');
});

test('active lock serializes recovery and cooldown prevents restart storms', async () => {
  const locked = makeFixture();
  fs.writeFileSync(locked.lockPath, `${process.pid}\nactive\n`);
  await assert.rejects(
    reconcilePm2(options(locked, { run: async () => ({ stdout: '' }) })),
    /another PM2 mutation is already running/i,
  );

  const cooling = makeFixture();
  fs.writeFileSync(cooling.procNetUnixPath, '');
  fs.writeFileSync(cooling.statePath, JSON.stringify({ lastRecoveryAt: NOW - 60_000 }));
  let systemctlCalls = 0;
  await assert.rejects(
    reconcilePm2(options(cooling, {
      cooldownMs: 15 * 60_000,
      run: async (command) => {
        if (command === SYSTEMCTL_BIN) systemctlCalls += 1;
        return { stdout: '' };
      },
    })),
    /cooldown/i,
  );
  assert.equal(systemctlCalls, 0);
});
