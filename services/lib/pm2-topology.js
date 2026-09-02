'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REQUIRED_MONITOR_PROCESSES = Object.freeze([
  'mosim-logtail',
  'ocpp-collector',
  'vercel-drain',
  'github-webhook',
  'mobile-telemetry',
  'pagarme-status-webhook',
  'alert-engine',
  'ai-openclaw-agent',
  'support-copilot',
  'whatsapp-gateway',
]);

// These entries have destructive or externally visible side effects. They are
// part of the reviewed manifest so their executable path is explicit, but a
// safe reboot dump/live daemon must not contain them until an operator changes
// the manifest mode as part of a separately approved activation.
const DISABLED_MONITOR_PROCESSES = Object.freeze([
  'cleanup-vercel-db',
  'ocpp-alerts',
]);

function parsePm2Apps(raw, label = 'PM2 inventory', { allowEmpty = false } = {}) {
  let apps;
  try {
    apps = JSON.parse(String(raw || ''));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(apps) || (!allowEmpty && !apps.length)) {
    throw new Error(`${label} is empty; refusing to trust or persist the PM2 topology`);
  }

  return apps.map((app, index) => {
    const env = app && typeof app.pm2_env === 'object' ? app.pm2_env : {};
    const name = String(app?.name || env.name || '').trim();
    if (!name) throw new Error(`${label} contains an unnamed process at index ${index}`);
    return {
      raw: app,
      name,
      status: String(env.status || app?.status || 'unknown'),
      restartTime: Number.isFinite(env.restart_time) ? env.restart_time : null,
      unstableRestarts: Number.isFinite(env.unstable_restarts) ? env.unstable_restarts : 0,
      execPath: String(app?.pm_exec_path || env.pm_exec_path || '').trim(),
      interpreter: String(app?.exec_interpreter || env.exec_interpreter || '').trim(),
    };
  });
}

function parseRecoveryManifest(raw) {
  let manifest;
  try {
    manifest = JSON.parse(String(raw || ''));
  } catch (error) {
    throw new Error(`PM2 recovery manifest returned invalid JSON: ${error.message}`);
  }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.processes) || !manifest.processes.length) {
    throw new Error('PM2 recovery manifest must have version 1 and a non-empty processes array');
  }

  const processes = new Map();
  for (const [index, value] of manifest.processes.entries()) {
    const name = String(value?.name || '').trim();
    const mode = String(value?.mode || '').trim();
    const execPath = String(value?.execPath || '').trim();
    if (!name) throw new Error(`PM2 recovery manifest process ${index} has no name`);
    if (processes.has(name)) throw new Error(`PM2 recovery manifest contains duplicate process ${name}`);
    if (!['online', 'registered', 'disabled'].includes(mode)) {
      throw new Error(`PM2 recovery manifest process ${name} has invalid mode ${mode || '(empty)'}`);
    }
    if (!path.isAbsolute(execPath)) {
      throw new Error(`PM2 recovery manifest process ${name} needs an absolute executable path`);
    }
    processes.set(name, { name, mode, execPath });
  }

  const missingCore = REQUIRED_MONITOR_PROCESSES.filter((name) => {
    const spec = processes.get(name);
    return !spec || spec.mode !== 'online';
  });
  if (missingCore.length) {
    throw new Error(`PM2 recovery manifest is missing required online monitor process(es): ${missingCore.join(', ')}`);
  }
  const unsafeDisabled = DISABLED_MONITOR_PROCESSES.filter((name) => {
    const spec = processes.get(name);
    return !spec || spec.mode !== 'disabled';
  });
  if (unsafeDisabled.length) {
    throw new Error(`PM2 recovery manifest must keep operator-gated process(es) disabled: ${unsafeDisabled.join(', ')}`);
  }
  return processes;
}

function defaultPathProbe(execPath, { executable = false, fsImpl = fs } = {}) {
  const stat = fsImpl.statSync(execPath);
  if (!stat.isFile()) throw new Error('not a regular file');
  fsImpl.accessSync(execPath, fs.constants.R_OK);
  if (executable) fsImpl.accessSync(execPath, fs.constants.X_OK);
  return true;
}

/**
 * Validate the exact, operator-curated reboot inventory before systemd is ever
 * allowed to resurrect it. The manifest is deliberately external/root-owned in
 * production; dump.pm2 may contain environment values and is never logged.
 */
function validateApprovedDump({
  manifestRaw,
  dumpRaw,
  pathProbe = defaultPathProbe,
  fsImpl = fs,
} = {}) {
  const processes = parseRecoveryManifest(manifestRaw);
  const apps = parsePm2Apps(dumpRaw, 'persisted PM2 inventory');
  const byName = new Map();
  for (const app of apps) {
    if (byName.has(app.name)) {
      throw new Error(`persisted PM2 inventory contains duplicate process ${app.name}`);
    }
    byName.set(app.name, app);
  }

  const missing = [...processes.values()]
    .filter((spec) => spec.mode !== 'disabled' && !byName.has(spec.name))
    .map((spec) => spec.name);
  const unexpected = [...byName.keys()].filter((name) => !processes.has(name));
  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `missing approved process(es): ${missing.join(', ')}` : null,
      unexpected.length ? `unapproved process(es): ${unexpected.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`persisted PM2 inventory does not match the recovery manifest (${details})`);
  }

  const forbiddenDisabled = [];
  for (const [name, spec] of processes) {
    const app = byName.get(name);
    if (spec.mode === 'disabled' && app) {
      forbiddenDisabled.push(`${name} is registered (${app.status})`);
      continue;
    }
    if (app && (!app.execPath || app.execPath !== spec.execPath)) {
      throw new Error(
        `${name} executable path mismatch: dump=${app.execPath || '(empty)'}, approved=${spec.execPath}`,
      );
    }
    try {
      pathProbe(spec.execPath, { executable: app?.interpreter === 'none', fsImpl });
    } catch (error) {
      throw new Error(`${name} executable path is unavailable or unsafe: ${error.message}`);
    }
  }
  if (forbiddenDisabled.length) {
    throw new Error(`persisted PM2 inventory contains operator-gated process(es) that must be absent: ${forbiddenDisabled.join(', ')}`);
  }

  const requiredOnline = [...processes.values()]
    .filter((processSpec) => processSpec.mode === 'online')
    .map((processSpec) => processSpec.name);
  const registeredOnly = [...processes.values()]
    .filter((processSpec) => processSpec.mode === 'registered')
    .map((processSpec) => processSpec.name);
  assertProcessStatuses(apps, {
    requiredOnline,
    registeredOnly,
    label: 'persisted PM2 inventory',
  });

  return {
    processes,
    requiredOnline: new Set(requiredOnline),
    registeredOnly: new Set(registeredOnly),
    disabled: new Set([...processes.values()]
      .filter((processSpec) => processSpec.mode === 'disabled')
      .map((processSpec) => processSpec.name)),
    dumpApps: apps,
    dumpFingerprint: crypto.createHash('sha256').update(String(dumpRaw)).digest('hex'),
  };
}

function inventoryCounts(apps) {
  const counts = new Map();
  for (const app of apps || []) counts.set(app.name, (counts.get(app.name) || 0) + 1);
  return counts;
}

function assertProcessStatuses(apps, {
  requiredOnline = [],
  registeredOnly = [],
  disabledAbsent = [],
  label = 'PM2 inventory',
} = {}) {
  const modes = new Map([
    ...requiredOnline.map((name) => [name, new Set(['online'])]),
    ...registeredOnly.map((name) => [name, new Set(['online', 'stopped'])]),
  ]);
  const forbidden = new Set(disabledAbsent);
  const invalid = [];
  for (const app of apps || []) {
    if (forbidden.has(app.name)) {
      invalid.push(`${app.name} is registered (${app.status}) but must be absent`);
      continue;
    }
    const allowed = modes.get(app.name);
    if (allowed && !allowed.has(app.status)) invalid.push(`${app.name} is ${app.status}`);
  }
  if (invalid.length) {
    throw new Error(`${label} has unsafe required process status: ${invalid.join(', ')}`);
  }
  return apps;
}

function parsePm2Inventory(raw, label) {
  return inventoryCounts(parsePm2Apps(raw, label));
}

function assertRequiredInventory(counts, {
  required = REQUIRED_MONITOR_PROCESSES,
  label = 'PM2 inventory',
} = {}) {
  const missing = [...new Set(required || [])]
    .filter((name) => (counts.get(name) || 0) < 1);
  if (missing.length) {
    throw new Error(`${label} is missing required monitor process(es): ${missing.join(', ')}`);
  }
  return counts;
}

function hasUnixSocketListener(procNetUnix, socketPath) {
  const expected = String(socketPath || '').trim();
  if (!expected) return false;
  return String(procNetUnix || '').split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 8
      && fields[3] === '00010000'
      && fields[4] === '0001'
      && fields[5] === '01'
      && fields[7] === expected;
  });
}

module.exports = {
  REQUIRED_MONITOR_PROCESSES,
  DISABLED_MONITOR_PROCESSES,
  parsePm2Apps,
  parseRecoveryManifest,
  validateApprovedDump,
  defaultPathProbe,
  inventoryCounts,
  assertProcessStatuses,
  parsePm2Inventory,
  assertRequiredInventory,
  hasUnixSocketListener,
};
