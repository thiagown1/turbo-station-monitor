/**
 * Shadow calibration routes — /api/support/shadow
 *
 * Read-only views over shadow_comparisons (bot suggestion vs the operator's real
 * reply, recorded while auto_respond is OFF). Powers the dashboard calibration
 * panel so the team can see how close the bot already is before going live.
 *
 *   GET /api/support/shadow/comparisons?brandId=&limit=&offset=
 *   GET /api/support/shadow/stats?brandId=
 *
 * Brand is taken from the x-brand-id header (set by the Next proxy) or ?brandId.
 * No PII beyond the message texts themselves (same data already in the inbox).
 */
const { Router } = require('express');
const { db } = require('../lib/db');

const router = Router();

const GREETING_RE = /^\s*(bom dia|boa tarde|boa noite|ol[aá]|oi\b|opa)/i;
// Rough emoji detector (covers the ranges the team actually uses).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}❤✅⚡]/u;

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
}

/** Token Jaccard similarity in [0,1] — cheap stand-in until the LLM judge runs. */
function jaccard(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function rowMetrics(r) {
  const sug = r.suggestion_text || '', op = r.operator_text || '';
  const similarity = Math.round(jaccard(sug, op) * 100);
  return {
    similarity,
    botGreeted: GREETING_RE.test(sug),
    opGreeted: GREETING_RE.test(op),
    botEmoji: EMOJI_RE.test(sug),
    opEmoji: EMOJI_RE.test(op),
    lenBot: sug.length,
    lenOp: op.length,
  };
}

function resolveBrand(req) {
  return req.headers['x-brand-id'] || req.query.brandId || null;
}

router.get('/comparisons', (req, res) => {
  const brandId = resolveBrand(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const where = brandId ? 'WHERE s.brand_id = ?' : '';
  const args = brandId ? [brandId] : [];
  const rows = db.prepare(`
    SELECT s.*, c.customer_name, c.channel
    FROM shadow_comparisons s
    LEFT JOIN conversations c ON c.id = s.conversation_id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const total = db.prepare(`SELECT count(*) c FROM shadow_comparisons s ${where}`).get(...args).c;
  res.json({
    total,
    limit,
    offset,
    comparisons: rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      customerName: r.customer_name || null,
      suggestion: r.suggestion_text,
      operator: r.operator_text,
      model: r.model_name,
      judgeScore: r.judge_score ?? null,
      judgeVerdict: r.judge_verdict ?? null,
      createdAt: r.created_at,
      metrics: rowMetrics(r),
    })),
  });
});

router.get('/stats', (req, res) => {
  const brandId = resolveBrand(req);
  const where = brandId ? 'WHERE brand_id = ?' : '';
  const args = brandId ? [brandId] : [];
  const rows = db.prepare(`SELECT suggestion_text, operator_text, judge_score, created_at FROM shadow_comparisons ${where}`).all(...args);
  const n = rows.length;
  const sevenDayAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  let last7 = 0, sumSim = 0, sumLenBot = 0, sumLenOp = 0;
  let greetOveruse = 0, emojiMatch = 0, judged = 0, sumJudge = 0;
  for (const r of rows) {
    const m = rowMetrics(r);
    sumSim += m.similarity; sumLenBot += m.lenBot; sumLenOp += m.lenOp;
    if (m.botGreeted && !m.opGreeted) greetOveruse++;
    if (m.botEmoji === m.opEmoji) emojiMatch++;
    if (r.created_at >= sevenDayAgo) last7++;
    if (r.judge_score != null) { judged++; sumJudge += r.judge_score; }
  }
  const pct = (x) => n ? Math.round((x / n) * 100) : 0;
  res.json({
    total: n,
    last7Days: last7,
    avgSimilarity: n ? Math.round(sumSim / n) : 0,
    avgLenBot: n ? Math.round(sumLenBot / n) : 0,
    avgLenOperator: n ? Math.round(sumLenOp / n) : 0,
    greetingOverusePct: pct(greetOveruse),
    emojiMatchPct: pct(emojiMatch),
    judgedCount: judged,
    avgJudgeScore: judged ? Math.round(sumJudge / judged) : null,
  });
});

module.exports = router;
