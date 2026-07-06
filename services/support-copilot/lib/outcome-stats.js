/**
 * Conversation outcome stats aggregation — Support Copilot
 *
 * Pure aggregation over already-fetched conversation_outcomes rows (one per
 * conversation — the caller is responsible for the "latest row per
 * conversation_id" SQL, see routes/outcomes.js). Kept DB-free so the
 * aggregation math is testable with plain arrays, no sqlite involved.
 *
 * @module lib/outcome-stats
 */
'use strict';

const { NEGATIVE_OUTCOMES, OUTCOMES } = require('./outcome-prompt');

/**
 * @param {Array<{outcome: string, root_cause?: string|null, created_at: string}>} rows
 * @returns {{total:number, byOutcome:Record<string,number>, resolvedPct:number,
 *   negativePct:number, topRootCauses:Array<{rootCause:string,count:number}>,
 *   trend:Array<{date:string,total:number,negative:number}>}}
 */
function computeOutcomeStats(rows) {
  const byOutcome = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
  const rootCauseCounts = {};
  const trendMap = {};
  let negative = 0;

  for (const r of rows) {
    if (byOutcome[r.outcome] != null) byOutcome[r.outcome]++;
    if (NEGATIVE_OUTCOMES.has(r.outcome)) {
      negative++;
      if (r.root_cause) rootCauseCounts[r.root_cause] = (rootCauseCounts[r.root_cause] || 0) + 1;
    }
    const day = (r.created_at || '').slice(0, 10);
    if (day) {
      if (!trendMap[day]) trendMap[day] = { date: day, total: 0, negative: 0 };
      trendMap[day].total++;
      if (NEGATIVE_OUTCOMES.has(r.outcome)) trendMap[day].negative++;
    }
  }

  const total = rows.length;
  const topRootCauses = Object.entries(rootCauseCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([rootCause, count]) => ({ rootCause, count }));
  const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    total,
    byOutcome,
    resolvedPct: total ? Math.round(((byOutcome.resolved_by_bot + byOutcome.resolved_by_operator) / total) * 100) : 0,
    negativePct: total ? Math.round((negative / total) * 100) : 0,
    topRootCauses,
    trend,
  };
}

module.exports = { computeOutcomeStats };
