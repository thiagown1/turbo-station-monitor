#!/usr/bin/env node
const assert = require('assert');

const {
  classifyOcppEventType,
  normalizeLogger,
  extractChargerId,
} = require('./smart-collector');

function run() {
  // Classification improvements
  assert.equal(
    classifyOcppEventType("TriggerMessage timed out for charger DF260210006"),
    'trigger_message_timeout'
  );

  assert.equal(
    classifyOcppEventType("Ignoring response with unknown unique id: <CallResult ...>"),
    'trigger_message_timeout'
  );

  assert.equal(
    classifyOcppEventType("StatusNotification from charger AR2512180010 status=Charging"),
    'status_notification_charging'
  );

  assert.equal(
    classifyOcppEventType("StatusNotification from charger AR2512180010 status=Available"),
    'status_notification_available'
  );

  assert.equal(
    classifyOcppEventType("Heartbeat from charger AR2512180010"),
    'heartbeat'
  );

  // Logger normalization
  assert.equal(normalizeLogger('unknown', 'AR2512180010'), 'charger_AR2512180010');
  assert.equal(normalizeLogger(null, 'DF260210006'), 'charger_DF260210006');
  assert.equal(normalizeLogger('charger_AR2510070008', 'AR2510070008'), 'charger_AR2510070008');

  // Charger extraction fallback from message
  assert.equal(
    extractChargerId({ logger: 'unknown', message: 'StatusNotification charge_point AR2512180010' }),
    'AR2512180010'
  );

  console.log('✅ smart-collector classification tests passed');
}

run();
