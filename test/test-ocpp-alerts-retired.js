'use strict';

/**
 * ocpp-alerts (services/alert-processor.js) foi aposentado. O smart-collector
 * continua coletando e rastreando eventos, mas não grava mais a fila
 * history/pending_alerts.json, e o ecosystem não sobe mais o processo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HISTORY = path.join(ROOT, 'history');
const QUEUE_FILE = path.join(HISTORY, 'pending_alerts.json');
const STATE_FILES = ['chargers.json', 'transactions.json'].map((f) => path.join(HISTORY, f));

function snapshot(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function restore(file, content) {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
}

test('ecosystem não declara mais o app ocpp-alerts', () => {
  const ecosystem = require('../ecosystem.config.js');
  const names = ecosystem.apps.map((app) => app.name);
  assert.ok(names.includes('ocpp-collector'), 'ocpp-collector deve continuar no ecosystem');
  assert.ok(!names.includes('ocpp-alerts'));
  assert.ok(!ecosystem.apps.some((app) => /alert-processor/.test(app.script)));
});

test('auto-deploy não tenta reiniciar ocpp-alerts', () => {
  const { ALL_SERVICES } = require('../services/lib/monitor-auto-deploy');
  assert.ok(!ALL_SERVICES.includes('ocpp-alerts'));
});

test('smart-collector processa fault/recovery sem gravar pending_alerts.json', (t) => {
  fs.mkdirSync(HISTORY, { recursive: true });
  const queueBefore = snapshot(QUEUE_FILE);
  const stateBefore = STATE_FILES.map(snapshot);
  const collector = require('../services/smart-collector');
  t.after(() => {
    STATE_FILES.forEach((file, i) => restore(file, stateBefore[i]));
    restore(QUEUE_FILE, queueBefore);
    try { collector.db.close(); } catch { /* já fechado */ }
  });

  const chargerId = 'TESTRETIRE0001';
  const base = { level: 'INFO', logger: `charger_${chargerId}` };
  collector.processEntry({
    ...base,
    level: 'WARNING',
    timestamp: '2026-09-25T10:00:00.000Z',
    message: `StatusNotification from charger ${chargerId} status=Faulted error_code=GroundFailure`,
  });

  // Caminho feliz: a coleta continua rastreando o fault.
  assert.equal(collector.tracker.chargers[chargerId]?.status, 'Faulted');

  collector.processEntry({
    ...base,
    timestamp: '2026-09-25T10:05:00.000Z',
    message: `StatusNotification from charger ${chargerId} status=Available`,
  });
  assert.equal(collector.tracker.chargers[chargerId]?.status, 'Available');

  // Borda: nenhum fault/recovery deve criar ou alterar a fila aposentada.
  assert.deepEqual(snapshot(QUEUE_FILE), queueBefore);
});
