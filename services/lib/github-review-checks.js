'use strict';

const {
  CHECK_NAMES,
  hasCanonicalReviewChecks,
  parseWorkflowRunId,
  replaceCanonicalChecksWithMetadata,
} = require('./review-verdicts');

function hydrateCanonicalCheckMetadata(pr, { repo, run, onUnavailable = () => {} }) {
  const checks = pr.statusCheckRollup || [];
  let checkRuns = null;
  const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo || '');
  const validHead = /^[0-9a-f]{40}$/i.test(pr.headRefOid || '');
  const validBase = /^[0-9a-f]{40}$/i.test(pr.baseRefOid || '');

  pr.baseAncestryCurrent = null;
  if (validRepo && validHead && validBase && typeof run === 'function') {
    try {
      const rawCompare = run(
        `gh api -H "Accept: application/vnd.github+json" "repos/${repo}/compare/${pr.baseRefOid}...${pr.headRefOid}"`,
        { allowFail: true, timeout: 30000 }
      );
      const comparison = rawCompare ? JSON.parse(rawCompare) : null;
      if (comparison && Number.isInteger(comparison.behind_by)) {
        pr.baseAncestryCurrent = comparison.behind_by === 0;
      }
    } catch {
      pr.baseAncestryCurrent = null;
    }
  }

  if (!hasCanonicalReviewChecks(checks)) return pr;

  if (validRepo && validHead && typeof run === 'function') {
    try {
      const raw = run(
        `gh api -H "Accept: application/vnd.github+json" "repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100" --jq ".check_runs"`,
        { allowFail: true, timeout: 30000 }
      );
      checkRuns = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(checkRuns)) checkRuns = null;
      if (checkRuns) {
        for (const check of checkRuns) {
          if (![CHECK_NAMES.test, CHECK_NAMES.security].includes(check.name)) continue;
          const runId = parseWorkflowRunId(check.details_url || check.detailsUrl, repo);
          if (!runId) continue;
          try {
            const workflowRaw = run(
              `gh api -H "Accept: application/vnd.github+json" "repos/${repo}/actions/runs/${runId}"`,
              { allowFail: true, timeout: 30000 }
            );
            const workflowRun = workflowRaw ? JSON.parse(workflowRaw) : null;
            if (workflowRun && typeof workflowRun === 'object') check.workflowRun = workflowRun;
          } catch {
            // Missing provenance is intentionally evaluated as blocked.
          }
        }
      }
    } catch {
      checkRuns = null;
    }
  }

  if (!checkRuns) onUnavailable({ repo, prNumber: pr.number, headSha: pr.headRefOid });
  pr.statusCheckRollup = replaceCanonicalChecksWithMetadata(checks, checkRuns);
  return pr;
}

module.exports = { hydrateCanonicalCheckMetadata };
