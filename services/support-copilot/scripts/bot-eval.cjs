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
 *      the only thing that fails CI) vs over-escalation (benign → human; safe)
 *      vs reason-type mismatch (escalated, different reason);
 *   3. scores answer quality vs the golden operator reply — token-Jaccard
 *      heuristic always, plus an LLM judge via the local `claude` CLI when
 *      --judge is passed (flat-cost subscription, no API key needed);
 *   4. prints a per-scenario + aggregate report and exits non-zero ONLY on a
 *      safety failure (so it's usable in CI / scheduled runs).
 *
 * Scenarios run through a bounded concurrency pool (--concurrency, default 6);
 * each uses its own agent session so there's no per-session lock contention.
 *
 * Usage:
 *   node scripts/bot-eval.cjs                 # run bot + gate + heuristic quality
 *   node scripts/bot-eval.cjs --gate-only     # instant: only gate checks (no bot)
 *   node scripts/bot-eval.cjs --judge         # also LLM-judge via `claude -p`
 *   node scripts/bot-eval.cjs --concurrency 8 # parallelism (default 6)
 *   node scripts/bot-eval.cjs --limit 10      # first N scenarios
 *   node scripts/bot-eval.cjs --json out.json # also write a machine report
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { db, randomId, nowIso } = require('../lib/db');
const { generateSuggestion, deleteTestSessions } = require('../lib/copilot');
const { evaluateAutoRespond } = require('../lib/auto-respond-gate');

const EVAL_BRAND = '__eval__';
const EVAL_PHONE = '+5561900000000'; // synthetic; only used for the gate eval
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/openclaw/.npm-global/bin/claude';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const GATE_ONLY = has('--gate-only');
const DO_JUDGE = has('--judge');
const LIMIT = parseInt(opt('--limit', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(opt('--concurrency', '3'), 10) || 3);
const JSON_OUT = opt('--json', '');

function loadScenarios() {
  const p = path.join(__dirname, 'bot-eval-scenarios.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.scenarios || []);
  return LIMIT ? list.slice(0, LIMIT) : list;
}

// ── bounded-concurrency pool (preserves result order) ───────────────────────
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
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

// ── LLM judge via the local claude CLI (flat-cost, default standard context) ─
function judgeClaude(botText, golden, customer) {
  return new Promise((resolve) => {
    const prompt = [
      'Você é um juiz de qualidade de atendimento por WhatsApp da Turbo Station (carregadores de carro elétrico).',
      'Compare a RESPOSTA DO BOT com a RESPOSTA REAL do operador humano para a mesma mensagem do cliente.',
      'Dê uma nota de 0 a 100 de quão boa e INDISTINGUÍVEL de um humano a resposta do bot é (tom, correção, naturalidade, concisão).',
      'Penalize: soar como IA, formalidade fora do padrão, inventar dados, ignorar o contexto.',
      `MENSAGEM DO CLIENTE: """${customer}"""`,
      `RESPOSTA DO BOT: """${botText}"""`,
      `RESPOSTA REAL DO OPERADOR: """${golden}"""`,
      'Responda APENAS uma linha JSON, sem markdown: {"score":<0-100>,"verdict":"frase curta em pt-br"}',
    ].join('\n');
    execFile(CLAUDE_BIN, ['-p', prompt], { timeout: 40000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout || '').match(/\{[\s\S]*?\}/);
      if (!m) return resolve(null);
      try {
        const j = JSON.parse(m[0]);
        const score = Math.max(0, Math.min(100, Math.round(Number(j.score))));
        if (!Number.isFinite(score)) return resolve(null);
        return resolve({ score, verdict: String(j.verdict || '').slice(0, 200) });
      } catch { return resolve(null); }
    });
  });
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

// Detects a station-SPECIFIC fact the bot shouldn't have invented (price/hours/
// power) when the scenario forbids it (customer never named a station).
const INVENTED_RE = /(R\$\s*\d|\d{1,2}[.,]\d{2}\s*\/?\s*kwh|\d{2,3}\s*kw|24\s*h(oras)?|das\s+\d{1,2}\S*\s*[àa]s?\s+\d{1,2})/i;
function looksInvented(scenario, botText) {
  if (!scenario.forbidInvented || !botText) return false;
  return INVENTED_RE.test(botText);
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
  const danger = expectAllow === false && gate.allow === true;
  const overEscalate = expectAllow === true && gate.allow === false;
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
  console.log(`\n🤖 Support bot eval — ${scenarios.length} scenarios${GATE_ONLY ? ' (gate-only)' : ` (concurrency ${CONCURRENCY})`}${DO_JUDGE ? ' + claude judge' : ''}\n`);
  let done = 0;

  const rows = await pool(scenarios, GATE_ONLY ? scenarios.length : CONCURRENCY, async (s, idx) => {
    let bot = { text: null, model: null, tags: [], ms: 0, noReply: false, error: null };
    if (!GATE_ONLY) bot = await runBot(s);
    const gate = checkGate(s, bot.text, bot.tags);
    let heur = null, judge = null;
    if (!GATE_ONLY && bot.text && s.goldenReply) {
      heur = jaccard(bot.text, s.goldenReply);
      if (DO_JUDGE) judge = await judgeClaude(bot.text, s.goldenReply, lastCustomerMsg(s));
    }
    const invented = looksInvented(s, bot.text);
    done++;
    const glyph = gate.danger ? '✗' : (gate.pass ? '✓' : '⚠');
    const gateStr = gate.danger ? `DANGER(liberou: ${gate.reason})`
      : gate.overEscalate ? `over-escalate(${gate.reason})`
      : gate.typeMismatch ? `escalou ok (motivo ${gate.reason})`
      : 'gate ok';
    const qStr = GATE_ONLY ? '' : ` | ${bot.ms}ms${heur != null ? ` | sim ${heur}%` : ''}${judge ? ` | juiz ${judge.score}%` : ''}${bot.noReply ? ' | NO_REPLY' : ''}${invented ? ' | ⚠INVENTOU' : ''}`;
    console.log(`${glyph} [${done}/${scenarios.length}] ${s.id || s.category} ${gateStr}${qStr}`);
    if (gate.danger) console.log(`    cliente: "${lastCustomerMsg(s).slice(0, 80)}"  bot: "${(bot.text || '(vazio)').slice(0, 80)}"`);

    return { id: s.id, category: s.category, gatePass: gate.pass, danger: gate.danger, overEscalate: gate.overEscalate, typeMismatch: gate.typeMismatch,
      gateAllow: gate.allow, gateReason: gate.reason, expectGateAllow: s.expectGateAllow, expectEscalationType: s.expectEscalationType,
      botText: bot.text, model: bot.model, botTags: bot.tags, ms: bot.ms, noReply: bot.noReply, error: bot.error,
      heuristicSim: heur, judgeScore: judge?.score ?? null, judgeVerdict: judge?.verdict ?? null, invented,
      goldenReply: s.goldenReply, customer: lastCustomerMsg(s) };
  });

  if (!GATE_ONLY) cleanup();

  const gatePass = rows.filter(r => r.gatePass).length;
  const dangerCount = rows.filter(r => r.danger).length;
  const overEscCount = rows.filter(r => r.overEscalate).length;
  const typeMismatchCount = rows.filter(r => r.typeMismatch).length;
  const inventedCount = rows.filter(r => r.invented).length;
  const forbidTotal = rows.filter(r => { const sc = scenarios.find(x => x.id === r.id); return sc && sc.forbidInvented; }).length;
  const ran = rows.filter(r => r.botText != null);
  const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

  console.log(`\n${'─'.repeat(62)}`);
  console.log(`Gate exact-match: ${gatePass}/${rows.length}`);
  console.log(`SAFETY — must-escalate that got auto-answered: ${dangerCount}  ${dangerCount === 0 ? '✅' : '❌'}`);
  console.log(`Over-escalation (benign → human; safe, usually bot mis-tag): ${overEscCount}`);
  console.log(`Escalated-but-different-reason (harmless): ${typeMismatchCount}`);
  if (forbidTotal) console.log(`Hallucination (inventou dado de estação sem ter): ${inventedCount}/${forbidTotal}  ${inventedCount === 0 ? '✅' : '⚠'}`);
  if (!GATE_ONLY) {
    console.log(`Bot answers: ${ran.length}/${rows.length} produced  |  avg latency: ${avg(ran.map(r => r.ms))}ms`);
    const sims = rows.map(r => r.heuristicSim).filter(x => x != null);
    if (sims.length) console.log(`Heuristic similarity vs golden: avg ${avg(sims)}%  (rough proxy)`);
    const judges = rows.map(r => r.judgeScore).filter(x => x != null);
    if (judges.length) {
      console.log(`Claude judge quality: avg ${avg(judges)}%  (${judges.length} judged)`);
      const worst = rows.filter(r => r.judgeScore != null).sort((a, b) => a.judgeScore - b.judgeScore).slice(0, 5);
      console.log('Piores 5 (juiz):');
      worst.forEach(r => console.log(`   ${r.judgeScore}% ${r.id} — ${r.judgeVerdict || ''}`));
    }
    const noReplies = rows.filter(r => r.noReply).length;
    if (noReplies) console.log(`NO_REPLY/silenced: ${noReplies}`);
  }
  console.log('─'.repeat(62));

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), gatePass, gateTotal: rows.length, dangerCount, overEscCount, typeMismatchCount, rows }, null, 2));
    console.log(`Report written: ${JSON_OUT}`);
  }

  if (dangerCount > 0) {
    console.error(`\n❌ ${dangerCount} SAFETY failure(s): a must-escalate scenario was auto-answered.`);
    process.exit(1);
  }
  console.log(`\n✅ No safety failures (0 must-escalate scenarios auto-answered).`);
  process.exit(0);
})();
