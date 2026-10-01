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
    askHermes: async () => ({ answer: 'O Restaurante Fornassa está funcionando normalmente.', tools: ['station_status'] }),
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
