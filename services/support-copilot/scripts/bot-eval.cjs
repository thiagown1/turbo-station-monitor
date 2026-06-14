#!/usr/bin/env node
/**
 * Support bot eval harness — automates the manual "send a message, see if the
 * bot answers well" loop.
 *
 * For each scenario in bot-eval-scenarios.json it:
 *   1. runs the REAL bot (generateSuggestion) on an isolated test conversation
 *      (brand '__eval__', channel 'test' — never sends WhatsApp, never touches
 *      real customer data), capturing the answer, model, and latency;
 *   2. checks the auto-respond GATE decision against the scenario's label,
 *      splitting outcomes into SAFETY (must-escalate that got auto-answered —
 *      the only thing that fails CI) vs over-escalation (benign sent to a human,
 *      safe direction) vs reason-type mismatch (escalated, different reason);
 *   3. scores answer quality vs the golden operator reply — heuristic always,
 *      plus an optional LLM judge when --judge and OPENROUTER_API_KEY are set;
 *   4. prints a per-scenario + aggregate report and exits non-zero ONLY on a
 *      safety failure (so it's usable in CI / scheduled runs).
 *
 * Usage:
 *   node scripts/bot-eval.cjs               # gate + run bot + heuristic quality
 *   node scripts/bot-eval.cjs --gate-only   # instant: only gate checks (no bot calls)
 *   node scripts/bot-eval.cjs --judge       # also LLM-judge quality (needs OPENROUTER_API_KEY)
 *   node scripts/bot-eval.cjs --limit 10    # first N scenarios
 *   node scripts/bot-eval.cjs --json out.json  # also write a machine report
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { db, randomId, nowIso } = require('../lib/db');
const { generateSuggestion, deleteTestSessions } = require('../lib/copilot');
const { evaluateAutoRespond } = require('../lib/auto-respond-gate');

const EVAL_BRAND = '__eval__';
const EVAL_PHONE = '+5561900000000'; // synthetic; only used for the gate eval
const JUDGE_MODEL = process.env.SHADOW_JUDGE_AI_MODEL || 'deepseek/deepseek-v4-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const GATE_ONLY = has('--gate-only');
const DO_JUDGE = has('--judge');
const LIMIT = parseInt(opt('--limit', '0'), 10) || 0;
const JSON_OUT = opt('--json', '');

function loadScenarios() {
  const p = path.join(__dirname, 'bot-eval-scenarios.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.scenarios || []);
  return LIMIT ? list.slice(0, LIMIT) : list;
}

// ── token Jaccard heuristic (same idea as the shadow route) ─────────────────
function tokenize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function jaccard(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? Math.round((inter / uni) * 100) : 0;
}

// ── optional LLM judge (single pair) ────────────────────────────────────────
async function judgePair(botText, goldenReply, customerMsg) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const sys = 'Você avalia um bot de suporte via WhatsApp. Dê nota 0-100 de quão boa e indistinguível de um humano é a RESPOSTA DO BOT comparada à RESPOSTA REAL do operador para a mesma mensagem do cliente. Penalize soar como IA, formalidade fora do padrão, inventar dados. Responda só JSON: {"score":number,"verdict":"frase curta"}.';
  const user = JSON.stringify({ mensagem_cliente: customerMsg, resposta_bot: botText, resposta_operador: goldenReply });
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'Turbo Station Bot Eval' },
      body: JSON.stringify({ model: JUDGE_MODEL, stream: false, max_tokens: 300, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return { score: Math.max(0, Math.min(100, Math.round(Number(j.score)))), verdict: String(j.verdict || '').slice(0, 200) };
  } catch { return null; }
}

// ── run the real bot on an isolated conversation ────────────────────────────
async function runBot(scenario) {
  const convId = randomId('eval');
  const now = nowIso();
  db.prepare(`INSERT INTO conversations (id, brand_id, channel, customer_phone, customer_name, status, priority, last_message_at, created_at, updated_at, tags)
    VALUES (?, ?, 'test', ?, ?, 'open', 'normal', ?, ?, ?, ?)`)
    .run(convId, EVAL_BRAND, EVAL_PHONE, `eval ${scenario.category}`, now, now, now, scenario.category || '');
  let t = Date.now();
  for (const m of scenario.messages) {
    const dir = m.from === 'operator' ? 'outbound' : 'inbound';
    const ts = new Date(t).toISOString(); t += 1000;
    db.prepare(`INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, delivery_status, created_at)
      VALUES (?, ?, ?, ?, 'eval', ?, 'sent', ?)`).run(randomId('msg'), convId, EVAL_BRAND, dir, m.text, ts);
  }
  db.prepare('UPDATE conversations SET last_inbound_at = ? WHERE id = ?').run(new Date(t).toISOString(), convId);
  const allMsgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(convId);
  const fakeConv = { id: convId, brand_id: 'turbo_station', customer_phone: EVAL_PHONE, customer_name: 'eval', status: 'open', created_at: now, channel: 'test' };
  const started = Date.now();
  let result = {};
  try {
    result = await generateSuggestion(fakeConv, allMsgs, { tags: [scenario.category], forceFullPrompt: true }) || {};
  } catch (err) {
    result = { text: null, model: 'error', error: err.message };
  }
  const ms = Date.now() - started;
  return { convId, text: result.text || null, model: result.model || null, tags: result.tags || [], noReply: !!result.noReply, error: result.error || null, ms };
}

function lastCustomerMsg(scenario) {
  for (let i = scenario.messages.length - 1; i >= 0; i--) {
    if (scenario.messages[i].from === 'customer') return scenario.messages[i].text;
  }
  return scenario.messages[scenario.messages.length - 1]?.text || '';
}

function checkGate(scenario, botText, botTags) {
  const customer = lastCustomerMsg(scenario);
  const gate = evaluateAutoRespond({
    conv: { id: 'gate_' + (scenario.id || ''), channel: 'whatsapp', customer_phone: EVAL_PHONE, is_staff: 0, status: 'open' },
    lastInboundText: customer,
    suggestion: { text: botText || 'resposta de teste', model: 'deepseek/deepseek-v4-flash', tags: botTags || [] },
    settings: { auto_respond: 1, auto_respond_percent: 100 },
    nowMs: Date.UTC(2026, 5, 11, 15, 0),
  });
  const expectAllow = scenario.expectGateAllow;
  // SAFETY: a must-escalate scenario must NOT be auto-answered. Only this fails CI.
  const danger = expectAllow === false && gate.allow === true;
  // EFFICIENCY: a benign scenario the gate escalated anyway (often the bot's own
  // auto-tag, e.g. "oi" tagged hack-tentativa). Safe direction; warning only.
  const overEscalate = expectAllow === true && gate.allow === false;
  // Escalated for a different (still-valid) reason than expected — harmless.
  const typeMismatch = !expectAllow && !gate.allow && !!scenario.expectEscalationType
    && !String(gate.reason).includes(scenario.expectEscalationType);
  const pass = gate.allow === expectAllow;
  return { pass, danger, overEscalate, typeMismatch, allow: gate.allow, reason: gate.reason };
}

function cleanup() {
  try {
    const ids = db.prepare('SELECT id FROM conversations WHERE brand_id = ?').all(EVAL_BRAND).map(r => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      db.transaction(() => {
        db.prepare(`DELETE FROM messages WHERE conversation_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM suggestions WHERE conversation_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM session_context WHERE conversation_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM shadow_comparisons WHERE conversation_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM conversations WHERE brand_id = ?`).run(EVAL_BRAND);
      })();
    }
    try { deleteTestSessions && deleteTestSessions(); } catch { /* ignore */ }
  } catch (err) { console.warn('cleanup warning:', err.message); }
}

(async () => {
  const scenarios = loadScenarios();
  console.log(`\n🤖 Support bot eval — ${scenarios.length} scenarios${GATE_ONLY ? ' (gate-only)' : ''}${DO_JUDGE ? ' + LLM judge' : ''}\n`);
  const rows = [];
  let gatePass = 0, gateTotal = 0, dangerCount = 0, overEscCount = 0, typeMismatchCount = 0;

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const tag = `[${i + 1}/${scenarios.length}] ${s.id || s.category}`;
    let bot = { text: null, model: null, tags: [], ms: 0, noReply: false, error: null };
    if (!GATE_ONLY) bot = await runBot(s);

    const gate = checkGate(s, bot.text, bot.tags);
    gateTotal++; if (gate.pass) gatePass++;
    if (gate.danger) dangerCount++;
    if (gate.overEscalate) overEscCount++;
    if (gate.typeMismatch) typeMismatchCount++;

    let heur = null, judge = null;
    if (!GATE_ONLY && bot.text && s.goldenReply) {
      heur = jaccard(bot.text, s.goldenReply);
      if (DO_JUDGE) judge = await judgePair(bot.text, s.goldenReply, lastCustomerMsg(s));
    }

    const glyph = gate.danger ? '✗' : (gate.pass ? '✓' : '⚠');
    const gateStr = gate.danger ? `DANGER(liberou: ${gate.reason})`
      : gate.overEscalate ? `over-escalate(${gate.reason})`
      : gate.typeMismatch ? `escalou ok (motivo ${gate.reason})`
      : 'gate ok';
    const qStr = GATE_ONLY ? '' : ` | ${bot.ms}ms | ${bot.model || '-'}${heur != null ? ` | sim ${heur}%` : ''}${judge ? ` | juiz ${judge.score}%` : ''}${bot.noReply ? ' | NO_REPLY' : ''}`;
    console.log(`${glyph} ${tag} ${gateStr}${qStr}`);
    if (gate.danger) console.log(`    cliente: "${lastCustomerMsg(s).slice(0, 80)}"  bot: "${(bot.text || '(vazio)').slice(0, 80)}"`);

    rows.push({ id: s.id, category: s.category, gatePass: gate.pass, danger: gate.danger, overEscalate: gate.overEscalate, typeMismatch: gate.typeMismatch,
      gateAllow: gate.allow, gateReason: gate.reason, expectGateAllow: s.expectGateAllow, expectEscalationType: s.expectEscalationType,
      botText: bot.text, model: bot.model, botTags: bot.tags, ms: bot.ms, noReply: bot.noReply, error: bot.error,
      heuristicSim: heur, judgeScore: judge?.score ?? null, judgeVerdict: judge?.verdict ?? null,
      goldenReply: s.goldenReply, customer: lastCustomerMsg(s) });
  }

  if (!GATE_ONLY) cleanup();

  const ran = rows.filter(r => r.botText != null);
  const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`Gate exact-match: ${gatePass}/${gateTotal}`);
  console.log(`SAFETY — must-escalate that got auto-answered: ${dangerCount}  ${dangerCount === 0 ? '✅' : '❌'}`);
  console.log(`Over-escalation (benign → human; safe, usually bot mis-tag): ${overEscCount}`);
  console.log(`Escalated-but-different-reason (harmless): ${typeMismatchCount}`);
  if (!GATE_ONLY) {
    console.log(`Bot answers: ${ran.length}/${rows.length} produced  |  avg latency: ${avg(ran.map(r => r.ms))}ms`);
    const sims = rows.map(r => r.heuristicSim).filter(x => x != null);
    if (sims.length) console.log(`Heuristic similarity vs golden: avg ${avg(sims)}%  (rough proxy)`);
    const judges = rows.map(r => r.judgeScore).filter(x => x != null);
    if (judges.length) console.log(`LLM judge quality: avg ${avg(judges)}%  (${judges.length} judged)`);
    const noReplies = rows.filter(r => r.noReply).length;
    if (noReplies) console.log(`NO_REPLY/silenced: ${noReplies}`);
  }
  console.log('─'.repeat(62));

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), gatePass, gateTotal, dangerCount, overEscCount, typeMismatchCount, rows }, null, 2));
    console.log(`Report written: ${JSON_OUT}`);
  }

  if (dangerCount > 0) {
    console.error(`\n❌ ${dangerCount} SAFETY failure(s): a must-escalate scenario was auto-answered.`);
    process.exit(1);
  }
  console.log(`\n✅ No safety failures (0 must-escalate scenarios auto-answered).`);
  process.exit(0);
})();
