#!/usr/bin/env node
/**
 * Judge shadow comparisons — Support Copilot
 *
 * Scores unjudged shadow_comparisons rows with the local `claude` CLI (flat,
 * no API key): how close/indistinguishable the bot's suggestion is vs the
 * operator's REAL reply for the same customer message. Writes judge_score /
 * judge_verdict back. This is the real-traffic calibration number (more honest
 * than the synthetic-golden eval).
 *
 * Usage: node scripts/judge-shadow.cjs [--limit N] [--concurrency C]
 */
'use strict';
const { execFile } = require('child_process');
const { db, nowIso } = require('../lib/db');

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = parseInt(opt('--limit', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(opt('--concurrency', '3'), 10) || 3);
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/openclaw/.npm-global/bin/claude';

async function pool(items, limit, worker) {
  let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) return; await worker(items[i], i); }
  }));
}

function judge(botText, operatorText) {
  return new Promise((resolve) => {
    const prompt = [
      'Você é um juiz de qualidade de atendimento por WhatsApp da Turbo Station (carregadores de carro elétrico).',
      'Compare a RESPOSTA DO BOT com a RESPOSTA REAL do operador humano para a mesma situação.',
      'Nota 0-100 de quão boa e INDISTINGUÍVEL de um humano a resposta do bot é (tom, correção, naturalidade, concisão).',
      'Penalize: soar como IA, formalidade fora do padrão, inventar dados, ignorar contexto.',
      `RESPOSTA DO BOT: """${botText}"""`,
      `RESPOSTA REAL DO OPERADOR: """${operatorText}"""`,
      'Responda APENAS uma linha JSON: {"score":<0-100>,"verdict":"frase curta pt-br"}',
    ].join('\n');
    execFile(CLAUDE_BIN, ['-p', prompt], { timeout: 40000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout || '').match(/\{[\s\S]*?\}/);
      if (!m) return resolve(null);
      try { const j = JSON.parse(m[0]); const sc = Math.max(0, Math.min(100, Math.round(Number(j.score)))); if (!Number.isFinite(sc)) return resolve(null); return resolve({ score: sc, verdict: String(j.verdict || '').slice(0, 200) }); } catch { return resolve(null); }
    });
  });
}

(async () => {
  let rows = db.prepare("SELECT id, suggestion_text, operator_text FROM shadow_comparisons WHERE judge_score IS NULL ORDER BY created_at DESC").all();
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`\n⚖️  Judging ${rows.length} unjudged shadow rows (concurrency ${CONCURRENCY})\n`);
  const upd = db.prepare('UPDATE shadow_comparisons SET judge_score=?, judge_verdict=?, judged_at=? WHERE id=?');
  let n = 0, sum = 0, judged = 0;
  await pool(rows, CONCURRENCY, async (r) => {
    const v = await judge(r.suggestion_text, r.operator_text);
    n++;
    if (v) { upd.run(v.score, v.verdict, nowIso(), r.id); judged++; sum += v.score; }
    if (n % 20 === 0) process.stdout.write(`  ${n}/${rows.length}...\n`);
  });
  const avg = judged ? Math.round(sum / judged) : null;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Judged ${judged}/${rows.length}. Real-traffic quality avg: ${avg}%`);
  const dist = db.prepare("SELECT CASE WHEN judge_score>=85 THEN '85-100' WHEN judge_score>=70 THEN '70-84' WHEN judge_score>=50 THEN '50-69' ELSE '0-49' END bucket, count(*) c FROM shadow_comparisons WHERE judge_score IS NOT NULL GROUP BY bucket ORDER BY bucket DESC").all();
  console.log('distribution:', JSON.stringify(dist));
  process.exit(0);
})();
