const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPPORT_DB_PATH = ':memory:';
const { reconstructIncidentContext } = require('../lib/conversation-incident-context');

function message(id, at, sender, body, extra = {}) {
  return {
    id,
    external_message_id: id,
    created_at: at,
    provider_timestamp: at,
    direction: 'inbound',
    sender_id: sender,
    sender_name: sender,
    body: `[${sender}]: ${body}`,
    raw_body: body,
    mentioned_jids_json: '[]',
    is_forwarded: 0,
    ...extra,
  };
}

test('reconstructs the Lago Norte incident and binds a later isolated mention', () => {
  const messages = [
    message('alert-1', '2026-08-22T18:50:49.000Z', 'yves', [
      '🏢 Lago Norte',
      'ID AR2608200012',
      'connectorId: 2',
      'status: Faulted',
      'errorCode: OtherError',
      'vendorErrorCode: 33',
      'info: ACDC Module Error',
      'UTC-3: 22/08/2026, 15:50:49',
    ].join('\n'), { is_forwarded: 1, forwarding_score: 1 }),
    message('alert-2', '2026-08-22T18:58:56.000Z', 'yves', [
      '🏢 Lago Norte',
      'ID AR2608200012',
      'connectorId: 2',
      'status: Faulted',
      'errorCode: UnderVoltage',
      'vendorErrorCode: 31',
      'info: AC Input UnderVoltage',
      'UTC-3: 22/08/2026, 15:58:56',
    ].join('\n'), { is_forwarded: 1, forwarding_score: 1 }),
    message('claim', '2026-08-22T19:13:00.000Z', 'yves', 'é rede do transformador da rua'),
    message('question', '2026-08-23T13:55:00.000Z', 'luan', 'Confirma pra mim se o lago norte voltou ao normal'),
    message('mention', '2026-08-23T15:02:00.000Z', 'luan', '@Turbo Station Suporte', {
      mentioned_jids_json: JSON.stringify(['5511999999999@s.whatsapp.net']),
    }),
  ];

  const context = reconstructIncidentContext(messages, 'mention');
  assert.equal(context.questionMessageId, 'question');
  assert.match(context.effectiveQuestion, /lago norte voltou ao normal/i);
  assert.equal(context.contextConfidence, 'high');
  assert.deepEqual(context.stationHints.filter((hint) => hint.kind === 'id'), [{ kind: 'id', value: 'AR2608200012' }]);
  assert.deepEqual(context.incidentSignals.map((signal) => signal.info), ['ACDC Module Error', 'AC Input UnderVoltage']);
  assert.equal(context.participantClaims[0].verified, false);
  assert.equal(context.participantClaims[0].provenance, 'participant_report');
  assert.ok(context.requestedAspects.includes('recovery'));
});

test('does not reuse a question that received an outbound answer', () => {
  const messages = [
    message('question', '2026-08-23T13:55:00.000Z', 'luan', 'O Lago Norte voltou?'),
    { ...message('answer', '2026-08-23T14:10:00.000Z', 'support', 'Sim, confirmado.'), direction: 'outbound' },
    message('mention', '2026-08-23T15:02:00.000Z', 'luan', '@Turbo Station Suporte', {
      mentioned_jids_json: JSON.stringify(['bot@s.whatsapp.net']),
    }),
  ];
  const context = reconstructIncidentContext(messages, 'mention');
  assert.equal(context.questionMessageId, 'mention');
  assert.equal(context.contextConfidence, 'low');
  assert.ok(context.ambiguities.includes('missing_effective_question'));
});

test('keeps forwarded alerts unverified even when they contain exact OCPP fields', () => {
  const context = reconstructIncidentContext([
    message('alert', '2026-08-22T18:50:49.000Z', 'someone', 'ID AR2608200012 status: Faulted errorCode: UnderVoltage', { is_forwarded: 1 }),
    message('trigger', '2026-08-22T18:55:00.000Z', 'someone', 'Confirma a estação?', { mentioned_jids_json: '["bot"]' }),
  ], 'trigger');
  assert.equal(context.incidentSignals[0].provenance, 'forwarded_alert');
  assert.equal(context.incidentSignals[0].verified, false);
});
