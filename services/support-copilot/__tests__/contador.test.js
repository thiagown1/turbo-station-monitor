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
});

test('PDF intake forwards the original message id and sends the deterministic reply', async () => {
  const calls = [];
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.from('%PDF-test'),
    intake: async (payload) => {
      calls.push(['intake', payload]);
      return { outcome: 'registered', replyMessage: 'Conta registrada para Galois.' };
    },
    sendReply: async (text) => calls.push(['reply', text]),
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
  assert.deepEqual(calls[1], ['reply', 'Conta registrada para Galois.']);
});

test('image bill is held safely because the upstream intake only accepts PDF', async () => {
  let sent = false;
  const contador = buildContador({
    config,
    readMedia: async () => Buffer.from('image'),
    intake: async () => { throw new Error('must not send an image to the PDF-only endpoint'); },
    sendReply: async () => { sent = true; },
    runAgent: async () => '',
    queryTool: async () => ({}),
    loadContext: async () => [],
  });

  const result = await contador.handle({
    kind: 'image',
    messageId: 'wamid-image',
    groupJid: config.groupConversationId,
    media: { mimetype: 'image/jpeg', url: '/api/support/media/wamid-image.jpg' },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'image_intake_not_supported');
  assert.equal(sent, false);
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

test('agent instructions reject unknown tools and malformed replies', () => {
  assert.deepEqual(parseAgentInstruction('{"action":"tool","tool":"drop_database","params":{}}'), { action: 'invalid' });
  assert.deepEqual(parseAgentInstruction('not json'), { action: 'invalid' });
  assert.deepEqual(parseAgentInstruction('{"action":"reply","text":"Tudo certo."}'), { action: 'reply', text: 'Tudo certo.' });
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
