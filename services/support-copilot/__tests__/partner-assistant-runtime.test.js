const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-assistant-runtime-'));
process.env.SUPPORT_COPILOT_DB_PATH = path.join(tempDir, 'support-copilot.sqlite');
process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
process.env.PARTNER_AGENT_SECRET = 'partner-secret';

const { db } = require('../lib/db');
const {
  buildPrompt,
  claimPartnerAssistantMessage,
  cleanHermesOutput,
  evidenceAnswer,
  deliverDuePartnerAssistantJobs,
  partnerAssistantPolicy,
  redact,
  runPartnerAssistantJob,
} = require('../lib/partner-assistant-runtime');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const SUPPORT_LID = '66435376238593@lid';

function config(overrides = {}) {
  return {
    enabled: true,
    agents: { partnerAssistant: true },
    partnerAssistant: { autoSend: false, allowedConversationIds: ['conv_arena'], mentionJids: [SUPPORT_LID], ...overrides },
  };
}

let seq = 0;
function input(overrides = {}) {
  seq += 1;
  return {
    messageId: `wamid-${seq}`,
    conversationId: 'conv_arena',
    brandId: 'turbo_station',
    groupJid: '120363000000000000@g.us',
    instance: 'turbo_station',
    direction: 'inbound',
    body: '[Leonardo]: @66435376238593 o Fornassa caiu?',
    receivedAt: '2026-09-27T15:00:00.000Z',
    whatsappContext: { mentionedJids: [SUPPORT_LID] },
    ...overrides,
  };
}

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

test('policy requires the master switch, the group allowlist and the partner assistant agent', () => {
  assert.equal(partnerAssistantPolicy(config(), 'conv_arena').autoSend, false);
  assert.equal(partnerAssistantPolicy(config(), 'conv_other'), null);
  assert.equal(partnerAssistantPolicy({ ...config(), enabled: false }, 'conv_arena'), null);
  assert.equal(partnerAssistantPolicy({ ...config(), agents: { partnerAssistant: false } }, 'conv_arena'), null);
  assert.equal(partnerAssistantPolicy({ enabled: true, agents: { partnerAssistant: true } }, 'conv_arena'), null);
});

test('claims only a structured mention of the support number, once per message', () => {
  const msg = input();
  assert.deepEqual(claimPartnerAssistantMessage(msg, config()), { owned: true, fresh: true, autoSend: false });
  assert.deepEqual(claimPartnerAssistantMessage(msg, config()), { owned: true, fresh: false, autoSend: false });

  assert.equal(claimPartnerAssistantMessage(input({ whatsappContext: { mentionedJids: [] } }), config()).owned, false);
  assert.equal(claimPartnerAssistantMessage(input({ direction: 'outbound' }), config()).owned, false);
  assert.equal(claimPartnerAssistantMessage(input({ conversationId: 'conv_other' }), config()).owned, false);
});

test('prompt carries the question and recent group context without personal data', () => {
  const msg = input({ body: '[Leonardo]: @66435376238593 meu cpf é 123.456.789-09, o Fornassa caiu?' });
  claimPartnerAssistantMessage(msg, config());
  db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, sender_name, created_at)
      VALUES ('m-ctx', 'conv_arena', 'turbo_station', 'inbound', 'evolution', '[Paty]: me liga no (61) 99999-8888', 'Paty', '2026-09-27T14:30:00.000Z')`).run();
  const job = db.prepare('SELECT * FROM partner_assistant_jobs WHERE message_id = ?').get(msg.messageId);

  const prompt = buildPrompt(job, JSON.parse(job.payload_json));

  assert.match(prompt, /o Fornassa caiu\?/);
  assert.match(prompt, /Paty: me liga no \[telefone\]/);
  assert.doesNotMatch(prompt, /123\.456|99999-8888|66435376238593/);
});

test('shadow mode proposes the reply for human review instead of sending it', async () => {
  const msg = input();
  claimPartnerAssistantMessage(msg, config());
  const requests = [];
  let sent = false;

  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: 'O Restaurante Fornassa está funcionando normalmente.', tools: ['station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: { version: 1, tool: 'station_status', text: 'O Restaurante Fornassa está funcionando normalmente.' } }] }),
    sendText: async () => { sent = true; return { key: { id: 'x' } }; },
    request: async (url, init) => { requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return okResponse({ ok: true, reviewId: 'review-1' }); },
  });

  assert.deepEqual(result, { status: 'review', reviewId: 'review-1' });
  assert.equal(sent, false);
  assert.equal(requests[0].url, 'https://dashboard.test/api/agents/partner-memory');
  assert.equal(requests[0].auth, 'Bearer partner-secret');
  assert.equal(requests[0].body.action, 'propose_reply');
  assert.deepEqual(requests[0].body.subject, { type: 'whatsapp_group', conversationId: 'conv_arena' });
  assert.equal(requests[0].body.reply.answer, 'O Restaurante Fornassa está funcionando normalmente.');
  assert.equal(requests[0].body.reply.sourceMessageId, msg.messageId);
  assert.equal(db.prepare('SELECT status, review_id FROM partner_assistant_jobs WHERE message_id = ?').get(msg.messageId).review_id, 'review-1');
});

test('autoSend delivers through the gateway, stores the outbound message and records the interaction', async () => {
  const msg = input();
  claimPartnerAssistantMessage(msg, config({ autoSend: true }));
  const requests = [];

  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: 'Está funcionando.', tools: [] }),
    sendText: async (instance, jid, text) => { assert.equal(jid, msg.groupJid); assert.equal(text, 'Está funcionando.'); return { key: { id: 'out-1' } }; },
    request: async (url, init) => { requests.push(JSON.parse(init.body)); return okResponse({ ok: true, id: 'int-1' }); },
  });

  assert.deepEqual(result, { status: 'sent' });
  assert.equal(requests[0].action, 'record_interaction');
  assert.equal(requests[0].interaction.outcome, 'answered');
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE external_message_id = 'out-1' AND source = 'partner-assistant'").get());
});

test('a delivered answer is never resent when recording the interaction fails', async () => {
  const msg = input();
  claimPartnerAssistantMessage(msg, config({ autoSend: true }));
  let sends = 0;

  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: 'Ok.', tools: [] }),
    sendText: async () => { sends += 1; return { key: { id: `out-${sends}-${msg.messageId}` } }; },
    request: async () => ({ ok: false, status: 503, json: async () => ({ error: 'down' }) }),
  });

  assert.equal(result.status, 'sent');
  assert.equal(await deliverDuePartnerAssistantJobs({ sendText: async () => { sends += 1; return { key: { id: 'again' } }; } }), 0);
  assert.equal(sends, 1);
});

test('failures are retried and give up after the attempt budget', async () => {
  const msg = input();
  claimPartnerAssistantMessage(msg, config());
  const failing = { askHermes: async () => { throw new Error('hermes_exit_1'); } };

  assert.equal((await runPartnerAssistantJob(msg.messageId, failing)).status, 'retry');
  db.prepare("UPDATE partner_assistant_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE message_id = ?").run(msg.messageId);
  assert.equal((await runPartnerAssistantJob(msg.messageId, failing)).status, 'retry');
  db.prepare("UPDATE partner_assistant_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE message_id = ?").run(msg.messageId);
  assert.equal((await runPartnerAssistantJob(msg.messageId, failing)).status, 'failed');
  assert.equal((await runPartnerAssistantJob(msg.messageId, failing)).status, 'skipped');
});

test('an empty model answer is a failure, not a blank message to the partner', async () => {
  const msg = input();
  claimPartnerAssistantMessage(msg, config({ autoSend: true }));
  let sent = false;

  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: '', tools: [] }),
    sendText: async () => { sent = true; return { key: { id: 'x' } }; },
  });

  assert.equal(result.status, 'retry');
  assert.equal(sent, false);
});

test('helpers strip CLI noise and personal data', () => {
  assert.equal(cleanHermesOutput('\n  ⚠ tirith security scanner\nWarning: Unknown toolsets: x\nsession_id: 123\nResposta final\n'), 'Resposta final');
  assert.equal(redact('fale com joao@exemplo.com'), 'fale com [email]');
});

// Single source of truth for the prompt format: the Python eval runner
// (hermes/profiles/parceiro/eval/run_eval.py build_prompt) is tested against the
// same fixture, so the eval cannot drift from what production sends to Hermes.
const PROMPT_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'hermes', 'profiles', 'parceiro', 'eval', 'prompt_fixture.json'), 'utf8'));

test('temporal replay keeps the question clock and excludes future context before limiting rows', () => {
  const conversationId = 'conv_temporalreplay';
  const insert = db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, sender_name, created_at)
    VALUES (?, ?, 'turbo_station', 'inbound', 'evolution', ?, 'Parceiro', ?)`);
  insert.run('clock-before', conversationId, 'Estação sem comunicação.', '2026-10-06T21:00:00.000Z');
  for (let i = 0; i < 20; i++) insert.run(`clock-future-${i}`, conversationId, 'FUTURE_RETURN', `2026-10-07T00:18:${String(i).padStart(2, '0')}.000Z`);
  const prompt = buildPrompt({ conversation_id: conversationId, message_id: 'clock-question' }, {
    question: 'Já voltou?', receivedAt: '2026-10-06T22:18:00.000Z',
  });
  assert.match(prompt, /06\/10\/2026 19h18 \(Brasília\)/);
  assert.match(prompt, /06\/10\/2026 18h00/);
  assert.match(prompt, /Estação sem comunicação/);
  assert.doesNotMatch(prompt, /FUTURE_RETURN/);
});

test('temporal replay rejects an invalid question clock rather than querying unbounded context', () => {
  assert.throws(() => buildPrompt({ conversation_id: 'conv_temporalreplay' }, { question: 'Já voltou?', receivedAt: 'invalid' }), /invalid_question_clock/);
});

PROMPT_FIXTURE.cases.forEach((fixture, index) => {
  test(`prompt format matches the shared eval fixture: ${fixture.name}`, () => {
    const conversationId = `conv_promptfixture${index}`;
    const insert = db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, sender_name, created_at)
        VALUES (?, ?, 'turbo_station', ?, 'evolution', ?, ?, ?)`);
    fixture.context.forEach((message, i) => insert.run(
      `${conversationId}-${i}`, conversationId, message.sender === 'Turbo Station' ? 'outbound' : 'inbound',
      `[${message.sender}]: ${message.text}`, message.sender, message.at));

    const prompt = buildPrompt(
      { conversation_id: conversationId, message_id: `wamid-fixture-${index}` },
      { question: `[Leonardo]: ${fixture.question}`, receivedAt: PROMPT_FIXTURE.receivedAt },
    );

    assert.equal(prompt, fixture.expected);
  });
});

const canonical = { version: 1, tool: 'station_status', text: 'Consulta atual: comunicação recente. Intervalo observado: 7h04. Causa e acionamento não comprovados.' };
test('operational response uses the server contract and discards invented model claims', async () => {
  const msg = input();
  claimPartnerAssistantMessage(msg, config());
  let proposed;
  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: 'Nunca caiu. Foi falta de energia. Já acionei a equipe.', tools: ['station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: canonical }] }),
    request: async (_, init) => { proposed = JSON.parse(init.body); return okResponse({ reviewId: 'guard-review' }); },
  });
  assert.equal(result.status, 'review');
  assert.equal(proposed.reply.answer, canonical.text);
});
test('status without a complete server contract fails closed without sending or retrying the model', async () => {
  for (const contract of [undefined, { ...canonical, version: 2 }, { ...canonical, tool: 'station_usage' }, { ...canonical, text: '' }]) {
    const msg = input(); claimPartnerAssistantMessage(msg, config({ autoSend: true }));
    let effects = 0;
    const result = await runPartnerAssistantJob(msg.messageId, {
      askHermes: async () => ({ answer: 'Está normal.', tools: ['station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: contract }] }),
      sendText: async () => { effects++; }, request: async () => { effects++; },
    });
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'evidence_contract_missing'); assert.equal(effects, 0);
  }
});
test('conflicting status consultations fail closed instead of mixing evidence', async () => {
  const msg = input(); claimPartnerAssistantMessage(msg, config({ autoSend: true }));
  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: 'Normal.', tools: ['station_status'], trace: [
      { tool: 'station_status', ok: true, replyContract: canonical },
      { tool: 'station_status', ok: true, replyContract: { ...canonical, text: 'Outro resultado.' } },
    ] }),
    sendText: async () => { assert.fail('must not send'); },
  });
  assert.equal(result.error, 'evidence_contract_conflict'); assert.equal(result.status, 'failed');
});

test('provider event time determines context order and window despite ingestion delay', () => {
  const conversationId = 'conv_delayedcontext';
  const insert = db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, sender_name, provider_timestamp, created_at) VALUES (?, ?, 'turbo_station', 'inbound', 'evolution', ?, 'Parceiro', ?, ?)`);
  insert.run('event-before', conversationId, 'Earlier provider event', '2026-10-06T20:00:00Z', '2026-10-06T23:00:00Z');
  insert.run('event-later', conversationId, 'Later provider event', '2026-10-06T21:00:00Z', '2026-10-06T20:00:00Z');
  insert.run('event-future', conversationId, 'Future provider event', '2026-10-06T23:00:00Z', '2026-10-06T20:00:00Z');
  insert.run('event-fallback', conversationId, 'Fallback ingestion time', 'invalid', '2026-10-06T21:30:00Z');
  const prompt = buildPrompt({ conversation_id: conversationId, message_id: 'question' }, { question: 'Voltou?', receivedAt: '2026-10-06T22:18:00Z' });
  assert.match(prompt, /17h00.*Earlier provider event/); assert.match(prompt, /18h00.*Later provider event/);
  assert.ok(prompt.indexOf('Earlier provider event') < prompt.indexOf('Later provider event'));
  assert.match(prompt, /18h30.*Fallback ingestion time/); assert.doesNotMatch(prompt, /Future provider event/);
});
test('mixed status and usage preserve both validated responses without model additions', async () => {
  const msg = input({ body: 'Está online e quantas recargas teve hoje?' }); claimPartnerAssistantMessage(msg, config());
  let answer;
  const usage = { version: 1, tool: 'station_usage', text: 'Uso: 3 recargas encerradas.' };
  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: '10 recargas e equipe acionada.', tools: ['station_status', 'station_usage'], trace: [{ tool: 'station_usage', ok: true, replyContract: usage }, { tool: 'station_status', ok: true, replyContract: canonical }] }),
    request: async (_, init) => { answer = JSON.parse(init.body).reply.answer; return okResponse({ reviewId: 'mixed' }); },
  });
  assert.equal(result.status, 'review'); assert.equal(answer, canonical.text + '\n\n' + usage.text);
});

test('mixed unvalidated parts are explicit and oversized composition is blocked', () => {
  const trace = [{ tool: 'station_status', ok: true, replyContract: canonical }];
  const answer = evidenceAnswer({ answer: 'Equipe acionada.', tools: ['station_status', 'knowledge'], trace });
  assert.match(answer, /precisam de revisão humana/); assert.ok(answer.startsWith(canonical.text)); assert.doesNotMatch(answer, /Equipe acionada/);
  assert.throws(() => evidenceAnswer({ tools: ['station_status', 'station_usage'], trace: [
    { tool: 'station_status', ok: true, replyContract: { ...canonical, text: 's'.repeat(4500) } },
    { tool: 'station_usage', ok: true, replyContract: { version: 1, tool: 'station_usage', text: 'u'.repeat(4500) } },
  ] }), /evidence_contract_oversized/);
});

test('status sections compose distinct stations and deduplicate repeated evidence', () => {
  const a = { ...canonical, text: 'A: bico 2, OtherError.', sections: [{ stationId: 'TESTA', text: 'A: bico 2, OtherError.' }] };
  const b = { ...canonical, text: 'B: reativação aceita.', sections: [{ stationId: 'TESTB', text: 'B: reativação aceita.' }] };
  const trace = [a, b, a].map(replyContract => ({ tool: 'station_status', ok: true, replyContract }));
  assert.equal(evidenceAnswer({ tools: ['station_status'], answer: 'Foi falta de energia.', trace }), a.text + '\n\n' + b.text);
  assert.throws(() => evidenceAnswer({ tools: ['station_status'], trace: [...trace, { tool: 'station_status', ok: true, replyContract: { ...a, sections: [{ stationId: 'TESTA', text: 'A: outro resultado.' }] } }] }), /evidence_contract_conflict/);
});

test('malformed or mixed legacy and station sections fail closed', () => {
  for (const sections of [[], [{ stationId: '', text: 'x' }], [{ stationId: 'TESTA', text: '' }], [{ stationId: 'TESTA', text: 'a' }, { stationId: 'TESTA', text: 'a' }]]) {
    assert.throws(() => evidenceAnswer({ tools: ['station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: { ...canonical, sections } }] }), /evidence_contract_missing/);
  }
  assert.throws(() => evidenceAnswer({ tools: ['station_status'], trace: [
    { tool: 'station_status', ok: true, replyContract: canonical },
    { tool: 'station_status', ok: true, replyContract: { ...canonical, sections: [{ stationId: 'TESTA', text: 'a' }] } },
  ] }), /evidence_contract_conflict/);
});

test('unresolved references request clarification even when Hermes omits that tool', () => {
  const result = { answer: 'O mesmo erro continua.', tools: ['station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: canonical }] };
  const question = 'Quando você fala em alternar ou mudar, o que muda: o estado do bico, o código de erro ou outro indicador?';
  assert.equal(evidenceAnswer(result, 'O Teste B está com o mesmo erro de sempre, do negócio ficar alternando lá?'), canonical.text + '\n\n' + question);
  assert.equal(evidenceAnswer(result, 'O negócio da estação está falhando?'), canonical.text + '\n\nA qual estação, bico e erro anterior você está se referindo?');
  assert.equal(evidenceAnswer(result, 'O bico 2 alterna entre Available e Faulted?'), canonical.text);
  assert.throws(() => evidenceAnswer({ tools: ['station_status'], trace: [] }, 'O mesmo erro continua?'), /evidence_contract_missing/);
});

test('job supplies the original question to the mandatory clarification guard', async () => {
  const msg = input({ body: '[Parceiro]: O Teste B está com o mesmo erro do negócio alternando?' });
  claimPartnerAssistantMessage(msg, config());
  let proposed;
  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => ({ answer: 'Equipe avisada.', tools: ['station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: canonical }] }),
    request: async (_url, init) => { proposed = JSON.parse(init.body); return okResponse({ ok: true, reviewId: 'clarified-review' }); },
  });
  assert.equal(result.status, 'review');
  assert.match(proposed.reply.answer, /Quando você fala em alternar/);
  assert.doesNotMatch(proposed.reply.answer, /Equipe avisada/);
});

test('ambiguous references preserve a fixed clarification after validated connector facts', () => {
  const question = 'Quando você fala em alternar ou mudar, o que muda: o estado do bico, o código de erro ou outro indicador?';
  const clarification = { tool: 'clarification', args: { kind: 'alternancia' }, ok: true, replyContract: { version: 1, tool: 'clarification', text: question } };
  assert.equal(evidenceAnswer({ tools: ['station_status', 'clarification'], trace: [{ tool: 'station_status', ok: true, replyContract: canonical }, clarification] }), canonical.text + '\n\n' + question);
  assert.equal(evidenceAnswer({ tools: ['clarification'], trace: [clarification], answer: 'Diagnóstico inventado.' }), question);
  assert.throws(() => evidenceAnswer({ tools: ['clarification'], trace: [{ ...clarification, replyContract: { ...clarification.replyContract, text: 'Foi falta de energia?' } }] }), /evidence_contract_missing/);
});

test('untranscribed audio requests text before calling Hermes and does not infer facts from earlier messages', async () => {
  const msg = input({ body: '[Parceiro]: [🎤 Áudio]' });
  claimPartnerAssistantMessage(msg, config());
  let proposed;
  const result = await runPartnerAssistantJob(msg.messageId, {
    askHermes: async () => { assert.fail('unsupported audio must not call the model'); },
    request: async (_, init) => { proposed = JSON.parse(init.body); return okResponse({ reviewId: 'audio' }); },
  });
  assert.equal(result.status, 'review');
  assert.equal(proposed.reply.answer, 'Não consegui transcrever o áudio. Pode mandar a pergunta por texto?');
});

test('mixed requested overview is explicitly unvalidated rather than silently dropped', () => {
  const answer = evidenceAnswer({ answer: 'Texto livre misturando lista e status.', tools: ['partner_overview', 'station_status'], trace: [{ tool: 'station_status', ok: true, replyContract: canonical }] });
  assert.ok(answer.startsWith(canonical.text)); assert.match(answer, /Outras partes da pergunta não foram validadas.*revisão humana/);
});
