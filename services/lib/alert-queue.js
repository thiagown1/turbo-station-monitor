'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

function queueId(alert) {
  if (alert && typeof alert._queueId === 'string' && alert._queueId) return alert._queueId;
  const identity = [
    alert && alert.type,
    alert && alert.severity,
    alert && alert.chargerId,
    alert && alert.timestamp,
    alert && alert.message,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}

function normalizeAlert(alert) {
  return { ...alert, _queueId: queueId(alert) };
}

function readAlertQueue(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Alert queue must contain a JSON array: ${file}`);
  return parsed.filter((item) => item && typeof item === 'object').map(normalizeAlert);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort temp cleanup */ }
  }
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withQueueLock(file, mutate) {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd;

  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring alert queue lock: ${lockFile}`);
      waitSync(LOCK_WAIT_MS);
    }
  }

  try {
    return mutate();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lockFile, { force: true }); } catch { /* next call can recover stale lock */ }
  }
}

function enqueueAlert(file, alert, now = Date.now()) {
  return withQueueLock(file, () => {
    const queue = readAlertQueue(file);
    const duplicate = queue.find((item) =>
      item.chargerId === alert.chargerId &&
      item.type === alert.type &&
      now - new Date(item.timestamp).getTime() < 60 * 60 * 1000
    );
    if (duplicate) return { added: false, queue, alert: duplicate };

    const normalized = normalizeAlert(alert);
    const next = [...queue, normalized];
    atomicWriteJson(file, next);
    return { added: true, queue: next, alert: normalized };
  });
}

function applyQueueDecisions(file, decisions) {
  const byId = decisions instanceof Map ? decisions : new Map(Object.entries(decisions || {}));
  return withQueueLock(file, () => {
    const current = readAlertQueue(file);
    const next = [];
    for (const item of current) {
      const decision = byId.get(queueId(item));
      if (decision && decision.remove) continue;
      next.push(decision && decision.patch ? normalizeAlert({ ...item, ...decision.patch }) : item);
    }
    atomicWriteJson(file, next);
    return next;
  });
}

module.exports = {
  applyQueueDecisions,
  atomicWriteJson,
  enqueueAlert,
  normalizeAlert,
  queueId,
  readAlertQueue,
  withQueueLock,
};
