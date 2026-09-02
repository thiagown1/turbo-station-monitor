'use strict';

const REQUIRED_MONITOR_PROCESSES = Object.freeze([
  'mosim-logtail',
  'ocpp-collector',
  'ocpp-alerts',
  'vercel-drain',
  'github-webhook',
  'mobile-telemetry',
  'pagarme-status-webhook',
  'alert-engine',
  'ai-openclaw-agent',
  'support-copilot',
  'whatsapp-gateway',
]);

function parsePm2Apps(raw, label = 'PM2 inventory') {
  let apps;
  try {
    apps = JSON.parse(String(raw || ''));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(apps) || !apps.length) {
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

function inventoryCounts(apps) {
  const counts = new Map();
  for (const app of apps || []) counts.set(app.name, (counts.get(app.name) || 0) + 1);
  return counts;
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
  parsePm2Apps,
  inventoryCounts,
  parsePm2Inventory,
  assertRequiredInventory,
  hasUnixSocketListener,
};
