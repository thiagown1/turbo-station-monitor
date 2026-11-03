'use strict';

/**
 * Human handoff — triggers, ownership, dedupe, notices, resume.
 * All side effects are injected fakes. No network, no WhatsApp, no phone call.
 *
 * Run: node --test services/support-copilot/__tests__/human-handoff.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  HUMAN_OWNED_STATUSES,
  isHumanOwned,
  evaluateHandoff,
  buildHandoffPacket,
  renderCustomerNotice,
  renderInternalNotice,
  requestHandoff,
  resolveHandoff,
  countRecentFailures,
} = require('../lib/human-handoff');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, brand_id TEXT, channel TEXT, customer_phone TEXT, customer_name TEXT,
      status TEXT NOT NULL DEFAULT 'open', assigned_agent_id TEXT, priority TEXT DEFAULT 'normal',
      escalated_at TEXT, escalated_to TEXT, updated_at TEXT
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, brand_id TEXT, conversation_id TEXT, action TEXT, actor_user_id TEXT,
      metadata_json TEXT, created_at TEXT
    );
    CREATE TABLE station_investigation_jobs (
      message_id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT, decision TEXT, last_error TEXT, updated_at TEXT
    );
    CREATE TABLE partner_assistant_jobs (
      message_id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT, last_error TEXT, updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO conversations (id, brand_id, channel, customer_phone, customer_name, status)
              VALUES ('c1','turbo','whatsapp','+5561999990000','Maria','open')`).run();
  return db;
}

function fakes(overrides = {}) {
  const calls = { notify: [], customer: [], resolveOnCall: 0, place: [] };
  return {
    calls,
    notify: async (n) => { calls.notify.push(n); return { ok: true }; },
    sendCustomerNotice: async (n) => { calls.customer.push(n); return { ok: true }; },
    onCall: {
      resolve: async () => { calls.resolveOnCall += 1; return { available: true, contactRef: 'oncall-1' }; },
      place: async (ref, summary) => { calls.place.push({ ref, summary }); return { ok: true }; },
    },
    ...overrides,
  };
}

const baseConv = { id: 'c1', brand_id: 'turbo', channel: 'whatsapp', customer_phone: '+5561999990000', customer_name: 'Maria', status: 'open' };

// ─── Ownership ───────────────────────────────────────────────────────────────

test('assigned and escalated conversations are human-owned; open and closed are not', () => {
  assert.deepEqual([...HUMAN_OWNED_STATUSES].sort(), ['assigned', 'escalated']);
  assert.equal(isHumanOwned({ status: 'assigned' }), true);
  assert.equal(isHumanOwned({ status: 'escalated' }), true);
  assert.equal(isHumanOwned({ status: 'open' }), false);
  assert.equal(isHumanOwned({ status: 'closed' }), false);
  assert.equal(isHumanOwned(null), false);
});

// ─── Triggers ────────────────────────────────────────────────────────────────

test('explicit request for a person escalates', () => {
  const r = evaluateHandoff({ text: 'quero falar com um atendente' });
  assert.equal(r.escalate, true);
  assert.ok(r.reasons.includes('explicit_human_request'));
});

test('asking for a call back escalates as an explicit human request', () => {
  const r = evaluateHandoff({ text: 'pode me ligar?' });
  assert.equal(r.escalate, true);
  assert.ok(r.reasons.includes('explicit_human_request'));
});

test('money and legal topics escalate as risk', () => {
  assert.ok(evaluateHandoff({ text: 'quero reembolso da cobrança duplicada' }).reasons.includes('risk_topic'));
  assert.ok(evaluateHandoff({ text: 'vou chamar o procon' }).reasons.includes('risk_topic'));
});

test('suggestion tags force escalation', () => {
  const r = evaluateHandoff({ text: 'ok', tags: ['lgpd'] });
  assert.equal(r.escalate, true);
  assert.ok(r.reasons.includes('risk_topic'));
});

test('urgency (fire, smoke, shock, stuck cable) is urgent and outranks everything', () => {
  for (const text of ['saiu fumaça do carregador', 'tá pegando fogo', 'levei um choque', 'o cabo ficou preso no carro']) {
    const r = evaluateHandoff({ text });
    assert.equal(r.escalate, true, text);
    assert.equal(r.priority, 'urgent', text);
    assert.equal(r.primary, 'urgent', text);
  }
});

test('urgent beats an explicit request in priority and primary reason', () => {
  const r = evaluateHandoff({ text: 'quero falar com atendente, saiu fumaça' });
  assert.equal(r.priority, 'urgent');
  assert.equal(r.primary, 'urgent');
  assert.ok(r.reasons.includes('explicit_human_request'));
});

test('station not identified or low confidence escalates with normal priority', () => {
  const a = evaluateHandoff({ text: 'o que aconteceu?', signals: { stationIdentified: false } });
  assert.equal(a.escalate, true);
  assert.ok(a.reasons.includes('low_confidence'));
  assert.equal(a.priority, 'normal');
  const b = evaluateHandoff({ text: 'e aí?', signals: { confidence: 'low' } });
  assert.ok(b.reasons.includes('low_confidence'));
  const c = evaluateHandoff({ text: 'e aí?', signals: { blockedReasons: ['station_not_identified'] } });
  assert.ok(c.reasons.includes('low_confidence'));
});

test('out-of-scope requests escalate (action requests stay with a person)', () => {
  const r = evaluateHandoff({ text: 'reinicia o carregador', signals: { outOfScope: true } });
  assert.equal(r.escalate, true);
  assert.ok(r.reasons.includes('out_of_scope'));
});

test('repeated failures escalate only from the threshold on', () => {
  assert.equal(evaluateHandoff({ text: 'oi', signals: { failureCount: 2 } }).escalate, false);
  const r = evaluateHandoff({ text: 'oi', signals: { failureCount: 3 } });
  assert.equal(r.escalate, true);
  assert.ok(r.reasons.includes('repeated_failures'));
  const custom = evaluateHandoff({ text: 'oi', signals: { failureCount: 2 }, policy: { failureThreshold: 2 } });
  assert.equal(custom.escalate, true);
});

test('a plain, answerable message does not escalate', () => {
  const r = evaluateHandoff({ text: 'bom dia, o carregador da Caju Limão está funcionando?', signals: { stationIdentified: true, confidence: 'high' } });
  assert.equal(r.escalate, false);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.priority, 'normal');
});

test('"fogo" inside another word does not trigger urgency', () => {
  assert.equal(evaluateHandoff({ text: 'posto Fogo Alto fica onde?' }).priority, 'normal');
});

// ─── Packet and notices ──────────────────────────────────────────────────────

test('packet carries useful context, truncates long text and masks the phone', () => {
  const evaluation = evaluateHandoff({ text: 'falar com atendente' });
  const packet = buildHandoffPacket({
    conv: baseConv,
    evaluation,
    lastMessage: 'x'.repeat(2000),
    evidence: ['Caju Limão: conectores Available', 'logs: timeout'],
    aiDraft: 'y'.repeat(2000),
    failureCount: 1,
    now: '2026-11-01T10:00:00.000Z',
  });
  assert.equal(packet.conversationId, 'c1');
  assert.equal(packet.phoneMasked, '***0000');
  assert.ok(packet.lastMessage.length <= 501);
  assert.ok(packet.aiDraft.length <= 501);
  assert.deepEqual(packet.evidence, ['Caju Limão: conectores Available', 'logs: timeout']);
  assert.equal(packet.priority, 'normal');
  assert.ok(!JSON.stringify(packet).includes('5561999990000'));
});

test('customer notice says it was forwarded and promises no deadline or channel', () => {
  const normal = renderCustomerNotice({ priority: 'normal' });
  assert.match(normal, /equipe/i);
  assert.doesNotMatch(normal, /\d+\s*(min|minutos|hora|horas)|em breve|já já|ligar|ligaç|telefone|e-?mail|ticket|protocolo/i);
});

test('urgent customer notice adds a public safety instruction, still no deadline or channel', () => {
  const urgent = renderCustomerNotice({ priority: 'urgent' });
  assert.match(urgent, /193/);
  assert.doesNotMatch(urgent, /\d+\s*(min|minutos|hora|horas)|em breve|já já|vamos te ligar|ligaremos/i);
});

test('internal notice shows reason, station, evidence and the last customer message', () => {
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', evidence: ['estação X offline'], now: '2026-11-01T10:00:00.000Z' });
  const text = renderInternalNotice(packet);
  assert.match(text, /URGENTE/);
  assert.match(text, /saiu fumaça/);
  assert.match(text, /estação X offline/);
  assert.doesNotMatch(text, /5561999990000/);
});

// ─── requestHandoff ──────────────────────────────────────────────────────────

test('first handoff takes ownership, audits, notifies the team and the customer once', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'quero falar com atendente', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, now: '2026-11-01T10:00:00.000Z' });
  assert.equal(res.ok, true);
  assert.equal(res.duplicate, false);
  assert.equal(res.notified, true);
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get('c1');
  assert.equal(row.status, 'escalated');
  assert.equal(row.escalated_to, 'team');
  assert.equal(row.escalated_at, '2026-11-01T10:00:00.000Z');
  assert.equal(f.calls.notify.length, 1);
  assert.equal(f.calls.customer.length, 1);
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'support.handoff'").all();
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].metadata_json).reasons, ['explicit_human_request']);
});

test('a second handoff for the same conversation is a no-op: no second notice, no second audit', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  const args = { db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, now: '2026-11-01T10:00:00.000Z' };
  await requestHandoff(args);
  const again = await requestHandoff({ ...args, now: '2026-11-01T10:05:00.000Z' });
  assert.equal(again.duplicate, true);
  assert.equal(f.calls.notify.length, 1);
  assert.equal(f.calls.customer.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'support.handoff'").get().n, 1);
});

test('an already assigned conversation is not re-escalated or re-notified', async () => {
  const db = freshDb();
  db.prepare("UPDATE conversations SET status='assigned', assigned_agent_id='ana' WHERE id='c1'").run();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'atendente por favor' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(res.duplicate, true);
  assert.equal(db.prepare('SELECT status, assigned_agent_id FROM conversations').get().assigned_agent_id, 'ana');
  assert.equal(f.calls.notify.length, 0);
  assert.equal(f.calls.customer.length, 0);
});

test('a decision that does not escalate is refused and changes nothing', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'bom dia' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet: {}, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_escalation_needed');
  assert.equal(db.prepare('SELECT status FROM conversations').get().status, 'open');
  assert.equal(f.calls.notify.length, 0);
});

test('team notify failure keeps ownership (AI stays silent), audits the failure and flags attention', async () => {
  const db = freshDb();
  const f = fakes({ notify: async () => { throw new Error('evolution down'); } });
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(res.ok, true);
  assert.equal(res.notified, false);
  assert.equal(res.needsAttention, true);
  assert.equal(db.prepare('SELECT status FROM conversations').get().status, 'escalated');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'support.handoff_notify_failed'").get().n, 1);
  assert.equal(f.calls.customer.length, 1, 'customer is still told it was forwarded');
});

test('no notify channel configured: ownership is taken, flagged as needs attention, nothing is invented', async () => {
  const db = freshDb();
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet });
  assert.equal(res.ok, true);
  assert.equal(res.notified, false);
  assert.equal(res.needsAttention, true);
  assert.equal(res.customerNotified, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'support.handoff_notify_skipped'").get().n, 1);
});

test('customer notice failure does not break the handoff', async () => {
  const db = freshDb();
  const f = fakes({ sendCustomerNotice: async () => { throw new Error('send failed'); } });
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(res.ok, true);
  assert.equal(res.customerNotified, false);
  assert.equal(res.notified, true);
});

test('priority on the conversation only goes up, never down', async () => {
  const db = freshDb();
  db.prepare("UPDATE conversations SET priority='urgent' WHERE id='c1'").run();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'atendente por favor' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(db.prepare('SELECT priority FROM conversations').get().priority, 'urgent');
});

// ─── On-call port (mock only) ────────────────────────────────────────────────

test('urgent handoff asks the on-call port to place a call and records it', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, onCall: f.onCall });
  assert.equal(res.call.status, 'placed');
  assert.equal(f.calls.place.length, 1);
  assert.equal(f.calls.place[0].ref, 'oncall-1');
  assert.ok(!JSON.stringify(f.calls.place[0].summary).includes('5561999990000'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'support.handoff_call'").get().n, 1);
});

test('non-urgent handoff never calls the on-call port', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, onCall: f.onCall });
  assert.equal(res.call.status, 'not_required');
  assert.equal(f.calls.resolveOnCall, 0);
  assert.equal(f.calls.place.length, 0);
});

test('on-call person unavailable: no call, fallback is the team notice, flagged for attention', async () => {
  const db = freshDb();
  const f = fakes();
  f.onCall.resolve = async () => ({ available: false });
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, onCall: f.onCall });
  assert.equal(res.call.status, 'oncall_unavailable');
  assert.equal(res.needsAttention, true);
  assert.equal(f.calls.place.length, 0);
  assert.equal(f.calls.notify.length, 1);
});

test('call API failure or timeout is contained: ownership kept, failure audited, no retry loop', async () => {
  const db = freshDb();
  const f = fakes();
  f.onCall.place = async () => { throw new Error('provider 503'); };
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, onCall: f.onCall });
  assert.equal(res.ok, true);
  assert.equal(res.call.status, 'call_failed');
  assert.equal(res.needsAttention, true);
  assert.equal(db.prepare('SELECT status FROM conversations').get().status, 'escalated');
  assert.match(db.prepare("SELECT metadata_json FROM audit_log WHERE action = 'support.handoff_call'").get().metadata_json, /call_failed/);
});

test('resolving the on-call person throws: treated as unavailable, no call', async () => {
  const db = freshDb();
  const f = fakes();
  f.onCall.resolve = async () => { throw new Error('directory down'); };
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, onCall: f.onCall });
  assert.equal(res.call.status, 'oncall_unavailable');
  assert.equal(f.calls.place.length, 0);
});

test('no on-call port wired (today): urgent handoff only notifies the team', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(res.call.status, 'not_configured');
  assert.equal(f.calls.notify.length, 1);
});

// ─── Resume ──────────────────────────────────────────────────────────────────

test('resolving returns the conversation to the AI and clears the escalation fields', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  const res = resolveHandoff({ db, conversationId: 'c1', actor: 'ana', now: '2026-11-01T11:00:00.000Z' });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT * FROM conversations').get();
  assert.equal(row.status, 'open');
  assert.equal(row.assigned_agent_id, null);
  assert.equal(row.escalated_at, null);
  assert.equal(row.escalated_to, null);
  assert.equal(db.prepare("SELECT actor_user_id FROM audit_log WHERE action = 'support.handoff_resolved'").get().actor_user_id, 'ana');
});

test('after resolving, a new problem can escalate again (a fresh cycle)', async () => {
  const db = freshDb();
  const f = fakes();
  const evaluation = evaluateHandoff({ text: 'quero falar com atendente' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'x', now: '2026-11-01T10:00:00.000Z' });
  await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  resolveHandoff({ db, conversationId: 'c1', actor: 'ana' });
  const again = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice });
  assert.equal(again.duplicate, false);
  assert.equal(f.calls.notify.length, 2);
});

test('resolving a closed or unknown conversation is refused', () => {
  const db = freshDb();
  db.prepare("UPDATE conversations SET status='closed'").run();
  assert.equal(resolveHandoff({ db, conversationId: 'c1', actor: 'ana' }).ok, false);
  assert.equal(resolveHandoff({ db, conversationId: 'nope', actor: 'ana' }).ok, false);
});

// ─── Failure counter ─────────────────────────────────────────────────────────

test('countRecentFailures counts failed/blocked jobs of the same conversation inside the window', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO station_investigation_jobs (message_id, conversation_id, status, decision, last_error, updated_at) VALUES (?,?,?,?,?,?)');
  ins.run('m1', 'c1', 'failed', null, 'boom', '2026-11-01T09:50:00.000Z');
  ins.run('m2', 'c1', 'review', 'blocked', null, '2026-11-01T09:55:00.000Z');
  ins.run('m3', 'c1', 'sent', 'send', null, '2026-11-01T09:56:00.000Z');
  ins.run('m4', 'c1', 'failed', null, 'old', '2026-10-30T09:00:00.000Z');
  ins.run('m5', 'other', 'failed', null, 'boom', '2026-11-01T09:57:00.000Z');
  db.prepare('INSERT INTO partner_assistant_jobs (message_id, conversation_id, status, last_error, updated_at) VALUES (?,?,?,?,?)')
    .run('p1', 'c1', 'failed', 'boom', '2026-11-01T09:58:00.000Z');
  assert.equal(countRecentFailures(db, 'c1', '2026-11-01T00:00:00.000Z'), 3);
});

test('jobs skipped because a person owns the conversation are not counted as AI failures', () => {
  const db = freshDb();
  db.prepare('INSERT INTO station_investigation_jobs (message_id, conversation_id, status, decision, last_error, updated_at) VALUES (?,?,?,?,?,?)')
    .run('m1', 'c1', 'failed', null, 'human_owned', '2026-11-01T09:50:00.000Z');
  db.prepare('INSERT INTO partner_assistant_jobs (message_id, conversation_id, status, last_error, updated_at) VALUES (?,?,?,?,?)')
    .run('p1', 'c1', 'failed', 'human_owned', '2026-11-01T09:58:00.000Z');
  assert.equal(countRecentFailures(db, 'c1', '2026-11-01T00:00:00.000Z'), 0);
});

test('a call that never answers hits the timeout and is reported as call_failed', async () => {
  const db = freshDb();
  const f = fakes();
  f.onCall.place = () => new Promise(() => {});
  const evaluation = evaluateHandoff({ text: 'saiu fumaça' });
  const packet = buildHandoffPacket({ conv: baseConv, evaluation, lastMessage: 'saiu fumaça', now: '2026-11-01T10:00:00.000Z' });
  const res = await requestHandoff({ db, conv: baseConv, evaluation, packet, notify: f.notify, sendCustomerNotice: f.sendCustomerNotice, onCall: f.onCall, callTimeoutMs: 20 });
  assert.equal(res.call.status, 'call_failed');
  assert.equal(res.needsAttention, true);
});

test('countRecentFailures returns 0 when job tables are missing', () => {
  const db = new Database(':memory:');
  assert.equal(countRecentFailures(db, 'c1', '2026-11-01T00:00:00.000Z'), 0);
});

test('the copilot prompt never promises a call, a time or an unconfigured channel', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'copilot.js'), 'utf8');
  assert.doesNotMatch(src, /te ligar|me confirma o melhor hor[aá]rio|melhor n[uú]mero e hor[aá]rio/i);
  assert.match(src, /NÃO prometa ligação/);
});
