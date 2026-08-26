/**
 * Conversation outcome routes — /api/support/outcomes
 *
 * Read-only views over conversation_outcomes (how each closed conversation
 * ended: resolved by bot/operator, escalated, unresolved, abandoned, spam),
 * classified by classifyConversationOutcome() at close time. Powers the
 * "Desfechos" dashboard tab so the team can see what fraction of support
 * actually gets resolved and review the ones that didn't, with a suggested fix.
 *
 *   GET /api/support/outcomes/stats?brandId=&days=
 *   GET /api/support/outcomes?brandId=&outcome=&limit=&offset=
 *
 * Brand is taken from the x-brand-id header (set by the Next proxy) or ?brandId.
 */
const { Router } = require('express');
const { db } = require('../lib/db');
const { OUTCOMES, NEGATIVE_OUTCOMES } = require('../lib/outcome-prompt');
const { computeOutcomeStats } = require('../lib/outcome-stats');

const router = Router();

function resolveBrand(req) {
  return req.headers['x-brand-id'] || req.query.brandId || null;
}

// Only the latest outcome row per conversation counts towards "current" state
// (a reopened-then-reclosed conversation gets reclassified, and we don't want
// to double-count it under both its old and new outcome).
const LATEST_PER_CONV_CTE = `
  WITH latest AS (
    SELECT o.*
    FROM conversation_outcomes o
    INNER JOIN (
      SELECT conversation_id, MAX(datetime(created_at)) AS max_created
      FROM conversation_outcomes
      GROUP BY conversation_id
    ) m ON m.conversation_id = o.conversation_id AND datetime(o.created_at) = m.max_created
  )
`;

router.get('/stats', (req, res) => {
  const brandId = resolveBrand(req);
  const days = Math.min(parseInt(req.query.days, 10) || 30, 180);
  const since = new Date(Date.now() - days * 864e5).toISOString();

  const clauses = ['datetime(created_at) >= datetime(?)'];
  const args = [since];
  if (brandId) { clauses.push('brand_id = ?'); args.push(brandId); }
  const where = 'WHERE ' + clauses.join(' AND ');

  const rows = db.prepare(`${LATEST_PER_CONV_CTE} SELECT outcome, root_cause, created_at FROM latest ${where}`).all(...args);

  res.json({ days, ...computeOutcomeStats(rows) });
});

router.get('/', (req, res) => {
  const brandId = resolveBrand(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const outcomeFilter = req.query.outcome;

  const clauses = [];
  const args = [];
  if (brandId) { clauses.push('brand_id = ?'); args.push(brandId); }
  if (outcomeFilter === 'negative') {
    clauses.push(`outcome IN (${[...NEGATIVE_OUTCOMES].map(() => '?').join(',')})`);
    args.push(...NEGATIVE_OUTCOMES);
  } else if (outcomeFilter && OUTCOMES.includes(outcomeFilter)) {
    clauses.push('outcome = ?');
    args.push(outcomeFilter);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = db.prepare(`
    ${LATEST_PER_CONV_CTE}
    SELECT latest.*, c.customer_name, c.channel, c.tags
    FROM latest
    LEFT JOIN conversations c ON c.id = latest.conversation_id
    ${where}
    ORDER BY datetime(latest.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const total = db.prepare(`${LATEST_PER_CONV_CTE} SELECT count(*) c FROM latest ${where}`).get(...args).c;

  res.json({
    total,
    limit,
    offset,
    outcomes: rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      customerName: r.customer_name || null,
      channel: r.channel,
      outcome: r.outcome,
      closedBy: r.closed_by,
      rootCause: r.root_cause,
      analysis: r.analysis,
      suggestion: r.suggestion,
      model: r.model_name,
      tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
      createdAt: r.created_at,
    })),
  });
});

module.exports = router;
