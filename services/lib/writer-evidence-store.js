'use strict';

const fs = require('fs');
const path = require('path');

function blockedTaskIdentity(task) {
  return [
    task.repo || '',
    task.action || '',
    task.prNumber || task.issueNumber || task.number || '',
    task.branch || '',
    task.concurrencyKey || '',
  ].join('|');
}

function sanitizeCoderTaskState({
  currentState,
  currentTasks,
  generatedAt = new Date().toISOString(),
}) {
  const state = currentState && typeof currentState === 'object' ? currentState : {};
  const quarantined = [];
  for (const field of ['queue', 'activeTasks', 'blockedWriterQueue']) {
    if (!Array.isArray(state[field])) continue;
    for (const task of state[field]) {
      if (!task || typeof task !== 'object') continue;
      quarantined.push({
        ...task,
        quarantinedFrom: field,
        blockedReason: task.blockedReason || 'legacy task quarantined; manual repair required',
      });
    }
  }

  const byIdentity = new Map();
  for (const task of [...quarantined, ...(Array.isArray(currentTasks) ? currentTasks : [])]) {
    if (!task || typeof task !== 'object') continue;
    byIdentity.set(blockedTaskIdentity(task), task);
  }

  return {
    taskState: {
      schema: 'v3',
      lastHeartbeat: generatedAt,
      queue: [],
      activeTasks: [],
    },
    evidenceTasks: [...byIdentity.values()],
  };
}

function buildWriterEvidence({ source, tasks, generatedAt = new Date().toISOString() }) {
  return {
    schema: 'writer-repair-evidence/v1',
    source,
    generatedAt,
    executable: false,
    tasks: Array.isArray(tasks) ? tasks : [],
  };
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

function writeWriterEvidence({ filePath, source, tasks, generatedAt }) {
  const evidence = buildWriterEvidence({ source, tasks, generatedAt });
  writeJsonAtomic(filePath, evidence);
  return evidence;
}

module.exports = {
  blockedTaskIdentity,
  buildWriterEvidence,
  sanitizeCoderTaskState,
  writeJsonAtomic,
  writeWriterEvidence,
};
