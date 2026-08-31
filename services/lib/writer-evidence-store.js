'use strict';

const fs = require('fs');
const path = require('path');

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
  buildWriterEvidence,
  writeJsonAtomic,
  writeWriterEvidence,
};
