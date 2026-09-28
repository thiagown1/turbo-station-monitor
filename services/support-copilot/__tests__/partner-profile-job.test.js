const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-profile-job-'));
process.env.SUPPORT_COPILOT_DB_PATH = path.join(tempDir, 'support-copilot.sqlite');
process.env.AGENT_EVENT_BASE_URL = 'https://dashboard.test';
process.env.PARTNER_AGENT_SECRET = 'partner-secret';

const { db } = require('../lib/db');
const { SYSTEM_PROMPT, maybeRunDailyPartnerProfiles, transcript, updateGroupProfiles, validateProfile } = require('../lib/partner-profile-job');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-28T09:00:00.000Z'); // 06:00 in Brasília
const ENABLED = { PARTNER_PROFILE_JOB_ENABLED: 'true' };

function link(conversationId, partnerId, name) {
  db.prepare(`INSERT INTO group_partner_links (group_jid, conversation_id, brand_id, partner_id, partner_user_id, partner_name, allowed_tools, enabled, linked_at, updated_at)
      VALUES (?, ?, 'turbo_station', ?, '', ?, '[]', 1, ?, ?)`).run(`${conversationId}@g.us`, conversationId, partnerId, name, NOW.toISOString(), NOW.toISOString());
}

let seq = 0;
function message(conversationId, body, createdAt, direction = 'inbound', sender = 'Leonardo') {
  seq += 1;
  db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, sender_name, created_at)
      VALUES (?, ?, 'turbo_station', ?, 'evolution', ?, ?, ?)`).run(`m${seq}`, conversationId, direction, body, sender, createdAt);
}

function memoryServer(profiles = {}) {
  const calls = [];
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(url, 'https://dashboard.test/api/agents/partner-memory');
    assert.equal(init.headers.Authorization, 'Bearer partner-secret');
    if (body.action === 'read_profiles') {
      return { ok: true, status: 200, json: async () => ({ ok: true, partners: profiles[body.subject.conversationId] || [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, version: 1 }) };
  };
  return { calls, request };
}

test('updates each linked partner from the current profile and only the new messages', async () => {
  link('conv_a', 'p-a1', 'Arena');
  link('conv_a', 'p-a2', 'Damião');
  message('conv_a', '[Leonardo]: o chip do Fornassa ainda sem sinal', '2026-09-27T12:00:00.000Z');
  message('conv_a', 'Vamos trocar o chip amanhã', '2026-09-27T12:05:00.000Z', 'outbound');
  const { calls, request } = memoryServer({
    conv_a: [
      { id: 'p-a1', name: 'Arena', profile: { summary: 'Estável', sections: { momento: 'Operando' } } },
      { id: 'p-a2', name: 'Damião', profile: null },
    ],
  });
  const summarized = [];

  const status = await updateGroupProfiles({ conversation_id: 'conv_a', group_jid: 'conv_a@g.us', brand_id: 'turbo_station' }, {
    request,
    summarize: async (input) => { summarized.push(input); return { summary: `Ficha de ${input.partnerName}`, sections: { dificuldades: 'Chip do Fornassa' } }; },
  }, NOW);

  assert.equal(status, 'ok');
  assert.deepEqual(summarized.map((s) => s.partnerName), ['Arena', 'Damião']);
  assert.deepEqual(summarized[0].current, { summary: 'Estável', sections: { momento: 'Operando' } });
  assert.equal(summarized[1].current, null);
  assert.match(summarized[0].messages, /Leonardo: o chip do Fornassa ainda sem sinal/);
  assert.match(summarized[0].messages, /Turbo Station: Vamos trocar o chip amanhã/);
  const upserts = calls.filter((c) => c.action === 'upsert_profile');
  assert.deepEqual(upserts.map((c) => c.partnerId), ['p-a1', 'p-a2']);
  assert.deepEqual(upserts[0].subject, { type: 'whatsapp_group', conversationId: 'conv_a' });

  // Next run with nothing new does not call the model.
  const again = await updateGroupProfiles({ conversation_id: 'conv_a', group_jid: 'conv_a@g.us', brand_id: 'turbo_station' }, {
    request,
    summarize: async () => { throw new Error('must not be called'); },
  }, NOW);
  assert.equal(again, 'no_new_messages');
});

test('a failed group keeps its watermark so the same messages are retried next time', async () => {
  link('conv_b', 'p-b', 'Patricia');
  message('conv_b', 'estação parou', '2026-09-27T15:00:00.000Z');
  const { request } = memoryServer({ conv_b: [{ id: 'p-b', name: 'Patricia', profile: null }] });

  const failed = await updateGroupProfiles({ conversation_id: 'conv_b', group_jid: 'conv_b@g.us', brand_id: 'turbo_station' }, {
    request, summarize: async () => { throw new Error('model_down'); },
  }, NOW);
  assert.equal(failed, 'failed');
  assert.equal(db.prepare("SELECT last_message_at FROM partner_profile_runs WHERE conversation_id = 'conv_b'").get().last_message_at, null);

  const retried = [];
  const ok = await updateGroupProfiles({ conversation_id: 'conv_b', group_jid: 'conv_b@g.us', brand_id: 'turbo_station' }, {
    request, summarize: async (input) => { retried.push(input.messages); return { summary: 'ok', sections: {} }; },
  }, NOW);
  assert.equal(ok, 'ok');
  assert.match(retried[0], /estação parou/);
});

test('dashboard chat turns feed the profile of their partner, once each', async () => {
  link('conv_d', 'p-d1', 'Arena');
  link('conv_d', 'p-d2', 'Damião');
  const calls = [];
  let turns = [{ question: 'quando cai o repasse?', answer: 'Dia 10.', at: '2026-09-27T14:00:00.000Z' }];
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.action === 'read_profiles') {
      return { ok: true, status: 200, json: async () => ({ ok: true, partners: [
        { id: 'p-d1', name: 'Arena', profile: null, dashboardTurns: turns },
        { id: 'p-d2', name: 'Damião', profile: null, dashboardTurns: [] },
      ] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, version: 1 }) };
  };
  const summarized = [];
  const summarize = async (input) => { summarized.push(input); return { summary: 'ok', sections: {} }; };

  // No group message, but the partner asked in the dashboard: only that partner is updated.
  assert.equal(await updateGroupProfiles({ conversation_id: 'conv_d', group_jid: 'conv_d@g.us', brand_id: 'turbo_station' }, { request, summarize }, NOW), 'ok');
  assert.equal(calls[0].dashboardSince, new Date(NOW.getTime() - 7 * 24 * 60 * 60_000).toISOString());
  assert.deepEqual(summarized.map((s) => s.partnerName), ['Arena']);
  assert.match(summarized[0].messages, /Dashboard.*quando cai o repasse\?.*Dia 10\./);
  assert.deepEqual(calls.filter((c) => c.action === 'upsert_profile').map((c) => c.partnerId), ['p-d1']);

  // The next run asks only for turns after the last one processed.
  turns = [];
  calls.length = 0;
  assert.equal(await updateGroupProfiles({ conversation_id: 'conv_d', group_jid: 'conv_d@g.us', brand_id: 'turbo_station' }, { request, summarize }, NOW), 'no_new_messages');
  assert.equal(calls[0].dashboardSince, '2026-09-27T14:00:00.000Z');
  assert.equal(summarized.length, 1);
});

test('the profile instructions say the partner may read it', () => {
  assert.match(SYSTEM_PROMPT, /parceiro pode ler/i);
});

test('runs at most once per Brasília day, only after 03:00 and only when enabled', async () => {
  const deps = { ...memoryServer(), summarize: async () => ({ summary: 'x', sections: {} }) };

  assert.deepEqual(await maybeRunDailyPartnerProfiles({ ...deps, env: {} }, NOW), { ran: false, reason: 'disabled' });
  assert.deepEqual(await maybeRunDailyPartnerProfiles({ ...deps, env: ENABLED }, new Date('2026-09-28T05:00:00.000Z')), { ran: false, reason: 'too_early' });
  const first = await maybeRunDailyPartnerProfiles({ ...deps, env: ENABLED }, NOW);
  assert.equal(first.ran, true);
  assert.deepEqual(await maybeRunDailyPartnerProfiles({ ...deps, env: ENABLED }, new Date('2026-09-28T20:00:00.000Z')), { ran: false, reason: 'already_ran' });
});

test('model output is validated and stripped of personal data', () => {
  assert.throws(() => validateProfile({ sections: {} }), /profile_without_summary/);
  const profile = validateProfile({
    summary: 'Parceiro ligou do (61) 99999-8888',
    sections: { momento: 'Operando', cpf: '123.456.789-09', dificuldades: 'e-mail joao@exemplo.com' },
  });
  assert.equal(profile.summary, 'Parceiro ligou do [telefone]');
  assert.deepEqual(Object.keys(profile.sections).sort(), ['dificuldades', 'momento']);
  assert.equal(profile.sections.dificuldades, 'e-mail [email]');
});

test('transcript keeps the most recent part of a very busy day', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ direction: 'inbound', sender_name: 'X', body: `${i} ${'a'.repeat(200)}`, created_at: '2026-09-27T12:00:00.000Z' }));
  const text = transcript(rows);
  assert.ok(text.length <= 24_000);
  assert.match(text, /299 a/);
});
