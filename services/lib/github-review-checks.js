'use strict';

const {
  hasCanonicalReviewChecks,
  replaceCanonicalChecksWithMetadata,
} = require('./review-verdicts');

function hydrateCanonicalCheckMetadata(pr, { repo, run, onUnavailable = () => {} }) {
  const checks = pr.statusCheckRollup || [];
  if (!hasCanonicalReviewChecks(checks)) return pr;

  let checkRuns = null;
  const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo || '');
  const validHead = /^[0-9a-f]{40}$/i.test(pr.headRefOid || '');

  if (validRepo && validHead && typeof run === 'function') {
    try {
      const raw = run(
        `gh api -H "Accept: application/vnd.github+json" "repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100" --jq ".check_runs"`,
        { allowFail: true, timeout: 30000 }
      );
      checkRuns = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(checkRuns)) checkRuns = null;
    } catch {
      checkRuns = null;
    }
  }

  if (!checkRuns) onUnavailable({ repo, prNumber: pr.number, headSha: pr.headRefOid });
  pr.statusCheckRollup = replaceCanonicalChecksWithMetadata(checks, checkRuns);
  return pr;
}

module.exports = { hydrateCanonicalCheckMetadata };
