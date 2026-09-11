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
  assert.deepEqual(context.stationHints.filter((hint) => hint.kind === 'name'), [{ kind: 'name', value: 'Lago Norte' }]);
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

test('does not reopen a recently answered natural question for an isolated mention', () => {
  const messages = [
    message('recent-question', '2026-09-10T15:00:00.000Z', 'luan', 'Habibs caiu?'),
    { ...message('recent-answer', '2026-09-10T15:05:00.000Z', 'support', 'Já voltou ao normal.'), direction: 'outbound' },
    message('recent-mention', '2026-09-10T15:20:00.000Z', 'luan', '@Turbo Station Suporte', {
      mentioned_jids_json: JSON.stringify(['bot@s.whatsapp.net']),
    }),
  ];

  const context = reconstructIncidentContext(messages, 'recent-mention');
  assert.equal(context.questionMessageId, 'recent-mention');
  assert.equal(context.contextConfidence, 'low');
  assert.deepEqual(context.stationHints, []);
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

test('recognizes the natural Habibs question from the internal group', () => {
  const context = reconstructIncidentContext([
    message('question', '2026-09-10T15:30:00.000Z', 'luan', 'Habibs desarmou de novo?'),
  ], 'question');

  assert.equal(context.effectiveQuestion, 'Habibs desarmou de novo?');
  assert.equal(context.contextConfidence, 'medium');
  assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
  assert.doesNotMatch(context.ambiguities.join(','), /station_not_identified/);
  assert.ok(context.requestedAspects.includes('current_health'));
});

test('recognizes common natural station-name phrasings', async (t) => {
  const scenarios = [
    ["O Habib's W3 Norte caiu de novo?", "Habib's W3 Norte"],
    ['O carregador do Habibs está offline?', 'Habibs'],
    ['A Livebox parou de comunicar?', 'Livebox'],
    ['Arena caiu de novo?', 'Arena'],
    ['Outback caiu?', 'Outback'],
    ['Confirma pra mim se o Habibs voltou?', 'Habibs'],
    ['Consegue verificar pra gente se a Livebox voltou?', 'Livebox'],
    ['BIG BOX voltou ao normal?', 'BIG BOX'],
    ['Será que o Primor QNM 33 desarmou?', 'Primor QNM 33'],
    ['Habibs ainda está offline?', 'Habibs'],
    ['Habibs já voltou?', 'Habibs'],
    ['Habibs não voltou?', 'Habibs'],
    ['Habibs ainda não voltou?', 'Habibs'],
    ['A estação do Habibs caiu?', 'Habibs'],
    ['Essa estação do Habibs caiu?', 'Habibs'],
    ['Aquele posto do Habibs caiu?', 'Habibs'],
    ['O carregador da estação do Habibs caiu?', 'Habibs'],
    ['O conector da estação do Habibs caiu?', 'Habibs'],
    ['O conector 2 da estação do Habibs caiu?', 'Habibs'],
    ['O carregador 2 do Habibs caiu?', 'Habibs'],
    ['O carregador 2 no Habibs caiu?', 'Habibs'],
    ['O conector A do Habibs caiu?', 'Habibs'],
    ['O conector A na Livebox parou?', 'Livebox'],
    ['O carregador nº 2 do Habibs caiu?', 'Habibs'],
    ['O disjuntor da estação do Habibs desarmou?', 'Habibs'],
    ['A energia da estação do Habibs caiu?', 'Habibs'],
    ['A unidade do Habibs caiu?', 'Habibs'],
    ['Estação: Lago Norte caiu?', 'Lago Norte'],
    ['Estação Lago Norte caiu?', 'Lago Norte'],
    ['Bom dia, pessoal. O Habibs caiu?', 'Habibs'],
    ['Boa tarde pessoal, o Habibs caiu?', 'Habibs'],
    ['Olá, pessoal! O Habibs caiu?', 'Habibs'],
    ['Pessoal, o Habibs caiu?', 'Habibs'],
    ['Gente, o Habibs caiu?', 'Habibs'],
    ['Por favor, o Habibs caiu?', 'Habibs'],
    ['Você sabe se o Habibs voltou?', 'Habibs'],
    ['Vocês conseguem verificar se o Habibs caiu?', 'Habibs'],
    ['Você pode confirmar pra mim se o Habibs voltou?', 'Habibs'],
    ['Vocês confirmam pra gente se o Habibs caiu?', 'Habibs'],
    ['Como está o Habibs?', 'Habibs'],
    ['Como está o Habibs agora?', 'Habibs'],
    ['Como está o Habibs ainda offline?', 'Habibs'],
    ['Está o Habibs online?', 'Habibs'],
    ['Como está o conector 2 da estação do Habibs?', 'Habibs'],
    ['Você sabe como está o Habibs?', 'Habibs'],
    ['Como anda a estação do Habibs?', 'Habibs'],
    ['Vocês sabem como ficou o Habibs?', 'Habibs'],
    ['Alguém sabe se o Habibs voltou?', 'Habibs'],
    ['Se o Habibs voltou?', 'Habibs'],
    ['Não sei se o Habibs voltou?', 'Habibs'],
    ['Habibs, caiu?', 'Habibs'],
    ['Habibs: caiu?', 'Habibs'],
    ['Habibs... caiu?', 'Habibs'],
  ];

  for (const [body, expectedName] of scenarios) {
    await t.test(body, () => {
      const context = reconstructIncidentContext([
        message(`question-${expectedName}`, '2026-09-10T15:30:00.000Z', 'luan', body),
      ], `question-${expectedName}`);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: expectedName }]);
      assert.doesNotMatch(context.ambiguities.join(','), /station_not_identified/);
    });
  }
});

test('parses every supported station state before the venue', async (t) => {
  const states = [
    'desarmou', 'caiu', 'parou', 'voltou', 'está', 'esta', 'tá', 'ta',
    'ficou', 'segue', 'continua', 'sumiu', 'travou', 'desligou', 'reiniciou',
    'perdeu', 'falhou', 'funciona', 'comunicou', 'anda',
  ];

  for (const [index, state] of states.entries()) {
    await t.test(state, () => {
      const questionId = `state-first-${index}`;
      const context = reconstructIncidentContext([
        message(questionId, '2026-09-10T15:30:00.000Z', 'luan', `Como ${state} o Habibs?`),
      ], questionId);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    });
  }
});

test('accepts modifiers before state-first station questions', async (t) => {
  const scenarios = [
    'Já voltou o Habibs?',
    'Ainda está o Habibs offline?',
    'Hoje caiu o Habibs?',
  ];

  for (const [index, body] of scenarios.entries()) {
    await t.test(body, () => {
      const questionId = `modified-state-first-${index}`;
      const context = reconstructIncidentContext([
        message(questionId, '2026-09-10T15:30:00.000Z', 'luan', body),
      ], questionId);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    });
  }
});

test('strips leading status predicates between a state verb and the venue', async (t) => {
  const scenarios = [
    'Está offline o Habibs?',
    'Continua offline o Habibs?',
    'Segue fora do ar o Habibs?',
    'Ficou sem energia o Habibs?',
    'Está ainda offline o Habibs?',
    'Está com falha o Habibs?',
    'Continua com problema o Habibs?',
    'Ficou com erro o Habibs?',
    'Está dando erro o Habibs?',
    'Parou de comunicar o Habibs?',
    'Perdeu comunicação o Habibs?',
    'Está sem energia no Habibs?',
    'Está sem comunicação na estação do Habibs?',
  ];

  for (const [index, body] of scenarios.entries()) {
    await t.test(body, () => {
      const questionId = `state-first-leading-predicate-${index}`;
      const context = reconstructIncidentContext([
        message(questionId, '2026-09-10T15:30:00.000Z', 'luan', body),
      ], questionId);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    });
  }
});

test('strips past-time tails after state-first station names', async (t) => {
  const scenarios = [
    'Caiu o Habibs ontem?',
    'Caiu o Habibs de manhã?',
  ];

  for (const [index, body] of scenarios.entries()) {
    await t.test(body, () => {
      const questionId = `state-first-past-time-${index}`;
      const context = reconstructIncidentContext([
        message(questionId, '2026-09-10T15:30:00.000Z', 'luan', body),
      ], questionId);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    });
  }
});

test('extracts the natural venue when the structured mention and question share a message', () => {
  const context = reconstructIncidentContext([
    message('trigger', '2026-09-10T15:30:00.000Z', 'luan', '@Turbo Station Suporte Habibs desarmou de novo?', {
      mentioned_jids_json: JSON.stringify(['support-bot@s.whatsapp.net']),
    }),
  ], 'trigger');

  assert.equal(context.effectiveQuestion, 'Habibs desarmou de novo?');
  assert.equal(context.contextConfidence, 'medium');
  assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
});

test('does not invent a station name when the natural question omits the venue', async (t) => {
  const scenarios = [
    'O carregador desarmou de novo?',
    'Consegue verificar se desarmou de novo?',
    'A estação caiu de novo?',
    'A energia caiu de novo?',
    'A alimentação caiu?',
    'O local caiu?',
    'O posto caiu?',
    'A rede caiu?',
    'O disjuntor desarmou?',
    'O sistema caiu?',
    'O servidor caiu?',
    'Qual estação caiu?',
    'Quais estações caíram?',
    'Alguma estação caiu?',
    'Que estação caiu?',
    'Qual estação teve erro?',
    'Alguma estação com falha?',
    'Que estação apresentou problema?',
    'Você sabe qual estação teve erro?',
    'Por que caiu?',
    'Como caiu?',
    'Quando caiu?',
    'Quem caiu?',
    'A estação teve erro?',
    'A estação fica em Lago Norte?',
    'Onde caiu?',
    'Qual carregador caiu?',
    'Alguém sabe se a energia voltou?',
    'Está offline?',
    'Está online?',
    'Ficou sem energia?',
    'Está com falha?',
    'Continua com problema?',
    'Ficou com erro?',
    'Está dando erro?',
    'Parou de comunicar?',
    'Perdeu comunicação?',
    'Como está agora?',
    'Ainda não voltou?',
    'Ainda está offline?',
    'Não voltou?',
    'Já voltou?',
    'Hoje caiu?',
    'De novo caiu?',
    'Está tudo normal?',
    'Tudo voltou?',
    'Esta estação caiu?',
    'Esta estação voltou?',
    'Esta estação está offline?',
    'Essa estação caiu?',
    'Esse carregador caiu?',
    'Aquele posto caiu?',
    'Essa caiu?',
    'Esse parou?',
    'Aquela voltou?',
    'Aqui caiu?',
    'Ali parou?',
    'Lá voltou?',
    'O carregador aqui caiu?',
    'A estação ali parou?',
    'Essa unidade caiu?',
  ];

  for (const [index, body] of scenarios.entries()) {
    await t.test(body, () => {
      const context = reconstructIncidentContext([
        message(`question-${index}`, '2026-09-10T15:30:00.000Z', 'luan', body),
      ], `question-${index}`);

      assert.equal(context.contextConfidence, 'low');
      assert.deepEqual(context.stationHints, []);
      assert.ok(context.ambiguities.includes('station_not_identified'));
    });
  }
});

test('strips every supported equipment prefix before a nested station venue', async (t) => {
  const prefixes = [
    'carregador', 'conector', 'disjuntor', 'energia', 'equipamento',
    'fornecimento', 'internet', 'luz', 'rede', 'servidor', 'sinal', 'sistema',
    'transformador',
  ];

  for (const [index, prefix] of prefixes.entries()) {
    await t.test(prefix, () => {
      const questionId = `equipment-prefix-${index}`;
      const context = reconstructIncidentContext([
        message(questionId, '2026-09-10T15:30:00.000Z', 'luan', `O ${prefix} da estação do Habibs caiu?`),
      ], questionId);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    });
  }
});

test('strips every declared generic prefix before a real station venue', async (t) => {
  const scenarios = [
    'A alimentação da estação do Habibs caiu?',
    'O local da estação do Habibs caiu?',
    'O posto do Habibs caiu?',
  ];

  for (const [index, body] of scenarios.entries()) {
    await t.test(body, () => {
      const questionId = `generic-prefix-${index}`;
      const context = reconstructIncidentContext([
        message(questionId, '2026-09-10T15:30:00.000Z', 'luan', body),
      ], questionId);

      assert.equal(context.contextConfidence, 'medium');
      assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }]);
    });
  }
});

test('does not borrow a natural station name from another participants earlier incident', () => {
  const context = reconstructIncidentContext([
    message('older-incident', '2026-09-10T15:00:00.000Z', 'yves', 'Habibs desarmou?'),
    message('current-question', '2026-09-10T15:30:00.000Z', 'luan', 'Consegue verificar se desarmou de novo?'),
  ], 'current-question');

  assert.equal(context.effectiveQuestion, 'Consegue verificar se desarmou de novo?');
  assert.equal(context.contextConfidence, 'low');
  assert.deepEqual(context.stationHints, []);
  assert.ok(context.ambiguities.includes('station_not_identified'));
});

test('reuses unpunctuated prior questions for every supported station state word', () => {
  const states = ['continua offline', 'segue offline', 'reiniciou', 'comunicou'];

  for (const [index, state] of states.entries()) {
    const questionId = `state-question-${index}`;
    const mentionId = `state-mention-${index}`;
    const context = reconstructIncidentContext([
      message(questionId, '2026-09-10T15:00:00.000Z', 'luan', `Habibs ${state}`),
      message(mentionId, '2026-09-10T15:05:00.000Z', 'luan', '@Turbo Station Suporte', {
        mentioned_jids_json: JSON.stringify(['support-bot@s.whatsapp.net']),
      }),
    ], mentionId);

    assert.equal(context.questionMessageId, questionId, state);
    assert.equal(context.contextConfidence, 'medium', state);
    assert.deepEqual(context.stationHints, [{ kind: 'name', value: 'Habibs' }], state);
  }
});
