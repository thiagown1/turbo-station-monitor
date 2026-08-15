'use strict';

const assert = require('node:assert/strict');
const {
  buildContador,
  classifyInbound,
  parseAgentInstruction,
} = require('../lib/contador');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const config = {
  enabled: true,
  groupConversationId: '120363000000000000@g.us',
  instance: 'turbostation',
  maxToolCalls: 5,
};

test('gate only accepts the configured group and ignores ordinary chatter', () => {
  assert.equal(classifyInbound({
    direction: 'inbound',
    groupJid: 'other@g.us',
    body: 'quais contas faltam?',
  }, config).kind, 'ignored');

  assert.equal(classifyInbound({
    direction: 'inbound',
    groupJid: config.groupConversationId,
    body: 'ok, obrigado',
  }, config).kind, 'ignored');

  assert.equal(classifyInbound({
    direction: 'inbound',
    groupJid: config.groupConversationId,
    body: 'quais contas de energia faltam este mes?',
  }, config).kind, 'query');

  assert.equal(classifyInbound({
    direction: 'inbound',
    groupJid: config.groupConversationId,
    media: { media_type: 'document', mimetype: 'application/pdf; charset=binary' },
  }, config).kind, 'pdf');
});

test('PDF intake forwards the original message id and sends the deterministic reply', async () => {
  const calls = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.from('%PDF-test'),
    intake: async (payload) => {
      calls.push(['intake', payload]);
      return { outcome: 'unresolved_station', draftId: 'rcpt_energy_1', replyMessage: 'De qual estação é essa conta?' };
    },
    sendReply: async (text, event) => calls.push(['reply', text, event.contadorDraftId]),
    runAgent: async () => { throw new Error('agent should not run for PDF intake'); },
    queryTool: async () => { throw new Error('query tool should not run for PDF intake'); },
    loadContext: async () => [],
  });

  const result = await contador.handle({
    kind: 'pdf',
    messageId: 'wamid-123',
    groupJid: config.groupConversationId,
    sender: 'Financeiro',
    media: { mimetype: 'application/pdf', filename: 'conta.pdf', url: '/api/support/media/wamid-123.pdf' },
  });

  assert.equal(result.status, 'sent');
  assert.equal(calls[0][0], 'intake');
  assert.equal(calls[0][1].messageId, 'wamid-123');
  assert.equal(calls[0][1].groupConversationId, config.groupConversationId);
  assert.equal(calls[0][1].contentBase64, Buffer.from('%PDF-test').toString('base64'));
  assert.deepEqual(calls[1], ['reply', 'De qual estação é essa conta?', 'rcpt_energy_1']);
});

test('image bill forwards only the on-box extraction and never reads/sends image bytes', async () => {
  const calls = [];
  const contador = buildContador({
    config,
    readMedia: async () => { throw new Error('image bytes must stay out of the intake payload'); },
    intake: async (payload) => { calls.push(payload); return { outcome: 'registered', replyMessage: 'Foto registrada.' }; },
    sendReply: async (text) => { calls.push(text); },
    runAgent: async () => '',
    queryTool: async () => ({}),
    loadContext: async () => [],
  });

  const result = await contador.handle({
    kind: 'image',
    messageId: 'wamid-image',
    groupJid: config.groupConversationId,
    senderId: '5511999999999',
    media: { mimetype: 'image/jpeg', url: '/api/support/media/wamid-image.jpg' },
    visionExtraction: {
      distributor: 'equatorial_go', uc: '1234', refPeriod: { year: 2026, month: 8 }, dueDate: null,
      kwhNaoCompensado: 812, tarifaNaoCompensada: 0.75, kwhCompensado: null, tarifaScee: null,
      tarifaSemTributosNaoCompensada: null, tarifaSemTributos: null, totalCents: 60900,
    },
  });

  assert.equal(result.status, 'sent');
  assert.equal(calls[0].mimeType, 'image/jpeg');
  assert.equal(calls[0].contentBase64, undefined);
  assert.equal(calls[0].sender, '5511999999999');
  assert.equal(calls[0].extraction.kwhNaoCompensado, 812);
  assert.equal(calls[1], 'Foto registrada.');
});

test('image bill fails closed when the paid classifier produced no extraction', async () => {
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0), intake: async () => { throw new Error('must not call intake'); },
    sendReply: async () => {}, runAgent: async () => '', queryTool: async () => ({}), loadContext: async () => [],
  });
  assert.deepEqual(await contador.handle({ kind: 'image', messageId: 'm', groupJid: config.groupConversationId, media: {} }), {
    status: 'blocked', reason: 'image_extraction_missing',
  });
});

test('tool loop stops after five calls and asks the agent for an evidence-only final answer', async () => {
  const toolCalls = [];
  const prompts = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => ({}),
    sendReply: async () => {},
    loadContext: async () => [{ direction: 'inbound', body: '[Thiago]: quais contas faltam?' }],
    queryTool: async (tool, params) => {
      toolCalls.push({ tool, params });
      return { pendingCount: 2 };
    },
    runAgent: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length <= 5) return JSON.stringify({ action: 'tool', tool: 'pendencias', params: { year: 2026, month: 8 } });
      return JSON.stringify({ action: 'reply', text: 'Há 2 estações pendentes.' });
    },
  });

  const result = await contador.handle({
    kind: 'query',
    messageId: 'wamid-query',
    groupJid: config.groupConversationId,
    body: 'quais contas de energia faltam?',
  });

  assert.equal(result.status, 'sent');
  assert.equal(toolCalls.length, 5);
  assert.equal(toolCalls[0].tool, 'drafts_abertos');
  assert.match(prompts[0], /protocolo JSON intermediado pelo runtime/i);
  assert.match(prompts[0], /Nunca responda que uma ferramenta permitida está indisponível/i);
  assert.match(prompts.at(-1), /limite de 5 ferramentas/i);
});

test('a quoted operator answer resolves exactly the draft and station selected through tools', async () => {
  const calls = [];
  let agentTurn = 0;
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async (payload) => { calls.push(['intake', payload]); return { outcome: 'registered', replyMessage: 'Conta concluída para Galois.' }; },
    sendReply: async (text) => calls.push(['reply', text]),
    loadContext: async () => [],
    queryTool: async (tool) => {
      calls.push(['tool', tool]);
      if (tool === 'drafts_abertos') return { count: 1, drafts: [{ draftId: 'rcpt_open', missing: ['station'] }] };
      if (tool === 'estacoes') return { stations: [{ id: 'station-galois', name: 'Galois' }] };
      return {};
    },
    runAgent: async (prompt) => {
      agentTurn += 1;
      if (agentTurn === 1) return JSON.stringify({ action: 'tool', tool: 'estacoes', params: {} });
      assert.match(prompt, /"action":"resolve_draft"/);
      return JSON.stringify({ action: 'resolve_draft', draftId: 'rcpt_open', stationId: 'station-galois' });
    },
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'operator-reply-1', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'é do Galois', replyToContador: true,
    quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(calls.find(([kind]) => kind === 'intake')[1], {
    action: 'resolve_draft', messageId: 'operator-reply-1', groupConversationId: config.groupConversationId,
    sender: '5511999999999', draftId: 'rcpt_open', stationId: 'station-galois', fields: undefined,
  });
  assert.deepEqual(calls.at(-1), ['reply', 'Conta concluída para Galois.']);
});

test('a draft write rejects a station id that was not returned by the station tool', async () => {
  const replies = [];
  let intakeCalls = 0;
  let agentTurn = 0;
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => { intakeCalls += 1; return {}; },
    sendReply: async (text, event) => replies.push({ text, event }),
    loadContext: async () => [],
    queryTool: async (tool) => {
      if (tool === 'drafts_abertos') return { count: 1, drafts: [{ draftId: 'rcpt_open', missing: ['station'] }] };
      if (tool === 'estacoes') return { stations: [{ id: 'station-galois', name: 'Galois' }] };
      return {};
    },
    runAgent: async () => {
      agentTurn += 1;
      return agentTurn === 1
        ? JSON.stringify({ action: 'tool', tool: 'estacoes', params: {} })
        : JSON.stringify({ action: 'resolve_draft', draftId: 'rcpt_open', stationId: 'station-hallucinated' });
    },
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'operator-reply-untrusted-station', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'é do Galois', replyToContador: true,
    quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'draft_station_not_verified');
  assert.equal(intakeCalls, 0);
  assert.match(replies[0].text, /confirmar essa estação/i);
  assert.equal(replies[0].event.contadorDraftId, 'rcpt_open');
});

test('a partial draft resolution keeps draft metadata on the next prompt', async () => {
  const replies = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => ({
      outcome: 'unrecognized',
      status: 'missing_info',
      draftId: 'rcpt_open',
      replyMessage: 'Qual foi a tarifa da distribuidora?',
    }),
    sendReply: async (text, event) => replies.push({ text, event }),
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open', missing: ['tariff'] }] }),
    runAgent: async () => JSON.stringify({
      action: 'resolve_draft',
      draftId: 'rcpt_open',
      fields: { kwhNaoCompensado: 812 },
    }),
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-partial', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'distribuidora: 812 kWh', replyToContador: true,
    quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'sent');
  assert.equal(result.outcome, 'unrecognized');
  assert.equal(replies[0].event.contadorDraftId, 'rcpt_open');
});

test('draft writes require a quoted reply even if the model asks to resolve', async () => {
  const replies = [];
  const contador = buildContador({
    config, readMedia: async () => Buffer.alloc(0), intake: async () => { throw new Error('must not write'); },
    sendReply: async (text) => replies.push(text), loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({ action: 'resolve_draft', draftId: 'rcpt_open', stationId: 'station-galois' }),
  });
  const result = await contador.handle({ kind: 'query', messageId: 'm', groupJid: config.groupConversationId, body: 'Galois' });
  assert.equal(result.reason, 'draft_reply_not_quoted');
  assert.match(replies[0], /responda citando/i);
});

test('draft writes reject a quote that belongs to another Contador message', async () => {
  const replies = [];
  const contador = buildContador({
    config, readMedia: async () => Buffer.alloc(0), intake: async () => { throw new Error('must not write'); },
    sendReply: async (text) => replies.push(text), loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({ action: 'resolve_draft', draftId: 'rcpt_open', stationId: 'station-galois' }),
  });
  const result = await contador.handle({
    kind: 'query', messageId: 'm', groupJid: config.groupConversationId, body: 'Galois',
    replyToContador: true, quotedContadorDraftId: 'rcpt_other',
  });
  assert.equal(result.reason, 'draft_reply_mismatch');
  assert.match(replies[0], /responda citando/i);
});

test('a clarification reply preserves the quoted draft authorization for the next turn', async () => {
  const replies = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => { throw new Error('must not write before clarification'); },
    sendReply: async (text, event) => replies.push({ text, event }),
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({
      action: 'reply',
      text: 'Esse valor de kWh pertence à distribuidora ou ao gerador solar?',
    }),
  });

  const result = await contador.handle({
    kind: 'query',
    messageId: 'm-clarify',
    groupJid: config.groupConversationId,
    body: 'foram 812 kWh',
    replyToContador: true,
    quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'sent');
  assert.equal(replies[0].event.contadorDraftId, 'rcpt_open');
});

test('quoted draft replies expose a literal UC and forward only the matching value', async () => {
  const calls = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async (payload) => {
      calls.push(payload);
      return { outcome: 'registered', replyMessage: 'Conta concluída.' };
    },
    sendReply: async () => {},
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async (prompt) => {
      assert.match(prompt, /439785001206/);
      return JSON.stringify({ action: 'resolve_draft', draftId: 'rcpt_open', fields: { uc: '439785001206' } });
    },
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-uc', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'UC 4.397.850.012-06', replyToContador: true,
    quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'sent');
  assert.equal(calls[0].fields.uc, '439785001206');
});

test('quoted draft prompts do not reconstruct unrelated redacted identifiers', async () => {
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => ({ outcome: 'registered', replyMessage: 'Conta concluída.' }),
    sendReply: async () => {},
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async (prompt) => {
      assert.doesNotMatch(prompt, /123\.456\.789-09|12345678909/);
      assert.doesNotMatch(prompt, /12\.345\.678\/0001-90|12345678000190/);
      assert.doesNotMatch(prompt, /99999-9999|62999999999/);
      assert.match(prompt, /439785001206/);
      return JSON.stringify({ action: 'resolve_draft', draftId: 'rcpt_open', fields: { uc: '439785001206' } });
    },
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-private-identifiers', groupJid: config.groupConversationId,
    senderId: '5511999999999',
    body: 'CPF 123.456.789-09; CNPJ 12.345.678/0001-90; telefone (62) 99999-9999; UC 4.397.850.012-06',
    replyToContador: true, quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'sent');
});

test('draft resolution rejects model numbers that were not literal in the quoted reply', async () => {
  const replies = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => { throw new Error('hallucinated value must not reach intake'); },
    sendReply: async (text, event) => replies.push({ text, event }),
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({
      action: 'resolve_draft', draftId: 'rcpt_open', fields: { kwhNaoCompensado: 999 },
    }),
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-kwh', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'foram 812 kWh', replyToContador: true,
    quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.reason, 'draft_fields_not_literal');
  assert.match(replies[0].text, /confirmar esses valores/i);
  assert.equal(replies[0].event.contadorDraftId, 'rcpt_open');
});

test('draft resolution binds each kWh literal to its labeled bill side', async () => {
  let intakeCalls = 0;
  const replies = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => { intakeCalls += 1; return { replyMessage: 'não deveria registrar' }; },
    sendReply: async (text, event) => replies.push({ text, event }),
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({
      action: 'resolve_draft', draftId: 'rcpt_open',
      fields: { kwhNaoCompensado: 650, kwhCompensado: 812 },
    }),
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-swapped-kwh', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'distribuidora: 812 kWh; solar: 650 kWh',
    replyToContador: true, quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.reason, 'draft_fields_not_literal');
  assert.equal(intakeCalls, 0);
  assert.match(replies[0].text, /confirmar esses valores/i);
});

test('draft resolution fails closed when one field has contradictory labeled values', async () => {
  let intakeCalls = 0;
  const replies = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => { intakeCalls += 1; return { replyMessage: 'não deveria registrar' }; },
    sendReply: async (text, event) => replies.push({ text, event }),
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({
      action: 'resolve_draft', draftId: 'rcpt_open', fields: { kwhNaoCompensado: 812 },
    }),
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-contradictory-kwh', groupJid: config.groupConversationId,
    senderId: '5511999999999',
    body: 'distribuidora incorreta: 812 kWh; distribuidora correta: 650 kWh',
    replyToContador: true, quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.reason, 'draft_fields_not_literal');
  assert.equal(intakeCalls, 0);
  assert.match(replies[0].text, /confirmar esses valores/i);
  assert.equal(replies[0].event.contadorDraftId, 'rcpt_open');
});

test('dotted Brazilian kWh rejects the decimal interpretation', async () => {
  let intakeCalls = 0;
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => { intakeCalls += 1; return { replyMessage: 'não deveria registrar' }; },
    sendReply: async () => {},
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({
      action: 'resolve_draft', draftId: 'rcpt_open', fields: { kwhNaoCompensado: 6.173 },
    }),
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-dotted-kwh-rejected', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'distribuidora: 6.173 kWh',
    replyToContador: true, quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.reason, 'draft_fields_not_literal');
  assert.equal(intakeCalls, 0);
});

test('dotted Brazilian kWh authorizes the normalized thousands value', async () => {
  const calls = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async (payload) => { calls.push(payload); return { outcome: 'registered', replyMessage: 'Conta concluída.' }; },
    sendReply: async () => {},
    loadContext: async () => [],
    queryTool: async () => ({ count: 1, drafts: [{ draftId: 'rcpt_open' }] }),
    runAgent: async () => JSON.stringify({
      action: 'resolve_draft', draftId: 'rcpt_open', fields: { kwhNaoCompensado: 6173 },
    }),
  });

  const result = await contador.handle({
    kind: 'query', messageId: 'm-dotted-kwh-accepted', groupJid: config.groupConversationId,
    senderId: '5511999999999', body: 'distribuidora: 6.173 kWh',
    replyToContador: true, quotedContadorDraftId: 'rcpt_open',
  });

  assert.equal(result.status, 'sent');
  assert.equal(calls[0].fields.kwhNaoCompensado, 6173);
});

test('heartbeat stays silent without actionable items and sends once when action is needed', async () => {
  const replies = [];
  const quiet = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => ({}),
    sendReply: async (text) => replies.push(text),
    loadContext: async () => [],
    runAgent: async () => JSON.stringify({ action: 'reply', text: 'Verificar 1 conta que vence amanha.' }),
    queryTool: async (tool) => {
      if (tool === 'contas_a_vencer') return { entries: [], drafts: [], pendingRegistration: { stations: [] } };
      if (tool === 'drafts_abertos') return { count: 0, drafts: [] };
      return { pendingCount: 0, stations: [] };
    },
  });
  assert.deepEqual(await quiet.heartbeat(new Date('2026-08-13T12:00:00Z')), { status: 'silent' });
  assert.equal(replies.length, 0);

  const active = buildContador({
    config,
    readMedia: async () => Buffer.alloc(0),
    intake: async () => ({}),
    sendReply: async (text) => replies.push(text),
    loadContext: async () => [],
    runAgent: async () => JSON.stringify({ action: 'reply', text: 'Verificar 1 conta que vence amanha.' }),
    queryTool: async (tool) => {
      if (tool === 'contas_a_vencer') return { entries: [{ dueDate: '2026-08-14' }], drafts: [], pendingRegistration: { stations: [] } };
      if (tool === 'drafts_abertos') return { count: 0, drafts: [] };
      return { pendingCount: 0, stations: [] };
    },
  });
  assert.equal((await active.heartbeat(new Date('2026-08-13T12:00:00Z'))).status, 'sent');
  assert.deepEqual(replies, ['Verificar 1 conta que vence amanha.']);
});

test('monthly summary closes the previous month and stays silent without trusted data', async () => {
  const replies = [];
  const calls = [];
  const active = buildContador({
    config, readMedia: async () => Buffer.alloc(0), intake: async () => ({}), loadContext: async () => [],
    sendReply: async (text) => replies.push(text),
    runAgent: async () => JSON.stringify({ action: 'reply', text: 'Julho fechou com dados conferidos e 1 pendência.' }),
    queryTool: async (tool, params) => {
      calls.push({ tool, params });
      if (tool === 'resumo_contabil') return { totalRevenueCents: 100000, totalCostsCents: 60000 };
      if (tool === 'resumo_energia') return { totalKwh: 0 };
      if (tool === 'pendencias') return { pendingCount: 0 };
      return { count: 0, drafts: [] };
    },
  });
  const result = await active.monthlySummary(new Date('2026-08-03T12:00:00Z'));
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.period, { year: 2026, month: 7 });
  assert.deepEqual(calls[0], { tool: 'resumo_contabil', params: { year: 2026, month: 7 } });
  assert.equal(replies.length, 1);

  const quiet = buildContador({
    config, readMedia: async () => Buffer.alloc(0), intake: async () => ({}), loadContext: async () => [],
    sendReply: async () => { throw new Error('must stay silent'); }, runAgent: async () => { throw new Error('must not call model'); },
    queryTool: async (tool) => tool === 'drafts_abertos' ? { count: 0, drafts: [] } : {},
  });
  assert.equal((await quiet.monthlySummary(new Date('2026-01-03T12:00:00Z'))).status, 'silent');
});

test('monthly summary accepts only explicit silence and retries malformed model output', async () => {
  const buildMonthly = (agentOutput) => buildContador({
    config, readMedia: async () => Buffer.alloc(0), intake: async () => ({}), loadContext: async () => [],
    sendReply: async () => { throw new Error('must not send'); },
    runAgent: async () => agentOutput,
    queryTool: async (tool) => {
      if (tool === 'resumo_contabil') return { totalRevenueCents: 100000 };
      if (tool === 'drafts_abertos') return { count: 0, drafts: [] };
      return {};
    },
  });

  const explicitSilent = buildMonthly(JSON.stringify({ action: 'silent' }));
  assert.equal((await explicitSilent.monthlySummary(new Date('2026-08-03T12:00:00Z'))).status, 'silent');

  const malformed = buildMonthly('not valid JSON');
  await assert.rejects(
    malformed.monthlySummary(new Date('2026-08-03T12:00:00Z')),
    /monthly.*invalid/i,
  );
});

test('agent instructions reject unknown tools and malformed replies', () => {
  assert.deepEqual(parseAgentInstruction('{"action":"tool","tool":"drop_database","params":{}}'), { action: 'invalid' });
  assert.deepEqual(parseAgentInstruction('not json'), { action: 'invalid' });
  assert.deepEqual(parseAgentInstruction('{"action":"reply","text":"Tudo certo."}'), { action: 'reply', text: 'Tudo certo.' });
  assert.deepEqual(
    parseAgentInstruction('{"action":"resolve_draft","draftId":"rcpt_1","stationId":"S1","fields":{"uc":"439785001206","kwhNaoCompensado":812,"hack":true}}'),
    { action: 'resolve_draft', draftId: 'rcpt_1', stationId: 'S1', fields: { uc: '439785001206', kwhNaoCompensado: 812 } },
  );
});

test('model context masks common PII formats', () => {
  const { redactForModel } = require('../lib/contador');
  const redacted = redactForModel('CPF 123.456.789-00, CNPJ 12.345.678/0001-90, fone (62) 99999-9999, a@b.com');
  assert.doesNotMatch(redacted, /123\.456|12\.345|99999|a@b/);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err);
    }
  }
  if (failed) process.exit(1);
  console.log(`\n${tests.length} Contador tests passed.`);
})();
