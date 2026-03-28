#!/usr/bin/env node
/**
 * GitHub Webhook Ingress (separated from vercel-drain)
 *
 * Endpoint: /api/github/webhook
 *
 * Responsibilities:
 * - Verify GitHub signature (optional but enabled by default)
 * - Extract relevant fields
 * - Append to github-webhook-queue.jsonl
 * - Send instant ACK to Thiago on Telegram (DM)
 * - Wake OpenClaw for immediate processing
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3002', 10);
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '1700081a5b367b04b35758df55a42b72d3c9ba65';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '1700081a5b367b04b35758df55a42b72d3c9ba65';

const QUEUE_PATH = path.join(__dirname, '..', 'github-webhook-queue.jsonl');
const CI_ATTEMPTS_PATH = path.join(__dirname, '..', 'ci-fix-attempts.json');
const ACK_DEBOUNCE_PATH = path.join(__dirname, '..', 'github-ack-debounce.json');
const CI_PENDING_PATH = path.join(__dirname, '..', 'ci-pending-wakes.json');
const CI_DEBOUNCE_MS = parseInt(process.env.CI_WAKE_DEBOUNCE_MS || '60000', 10); // 60s
const CODEX_REVIEW_DEBOUNCE_MS = parseInt(process.env.CODEX_REVIEW_DEBOUNCE_MS || '1800000', 10); // 30min

const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB (comments and webhook payloads are small)

function sendTelegramNotification(text, target = 'telegram:-5103508388') {
  const { exec } = require('child_process');
  // Escape for a double-quoted shell string.
  const escaped = text.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  exec(
    `openclaw message send --channel telegram --target ${target} -m "${escaped}"`,
    { timeout: 10000 },
    (err) => {
      if (err) console.error(`[telegram-notify] CLI failed: ${err.message}`);
      else console.log(`[telegram-notify] Sent to ${target}: ${text.substring(0, 80)}`);
    }
  );
}

function sendNightWorkersPing(text) {
  const { exec } = require('child_process');
  const escaped = text.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  exec(
    `openclaw message send --channel telegram --target telegram:-5143783696 -m "${escaped}"`,
    { timeout: 10000 },
    (err) => {
      if (err) console.error(`[night-workers-ping] CLI failed: ${err.message}`);
      else console.log(`[night-workers-ping] Sent: ${text.substring(0, 80)}`);
    }
  );
}

/**
 * Add a 👀 reaction to a GitHub comment/review so the user knows the webhook received it.
 * Uses `gh api` which is already authenticated on this machine.
 */
function addGitHubReaction({ repo, commentId, type = 'issue_comment' }) {
  const { exec } = require('child_process');
  let endpoint;

  if (type === 'pull_request_review_comment') {
    endpoint = `repos/${repo}/pulls/comments/${commentId}/reactions`;
  } else if (type === 'pull_request_review') {
    endpoint = `repos/${repo}/pulls/comments/${commentId}/reactions`;
  } else {
    // issue_comment (covers both issue and PR comments)
    endpoint = `repos/${repo}/issues/comments/${commentId}/reactions`;
  }

  exec(
    `gh api ${endpoint} -f content=eyes --silent`,
    { timeout: 10000 },
    (err) => {
      if (err) console.error(`[github-reaction] Failed to add 👀: ${err.message}`);
      else console.log(`[github-reaction] 👀 added to ${type} comment ${commentId}`);
    }
  );
}

function getPullRequestUrl({ repository, prNumber, fallbackUrl }) {
  if (fallbackUrl) return fallbackUrl;
  if (!repository || !prNumber) return null;
  return `https://github.com/${repository}/pull/${prNumber}`;
}

function sendOpenClawWake(text) {
  const postData = JSON.stringify({ text, mode: 'now' });
  const url = new URL('/hooks/wake', OPENCLAW_GATEWAY_URL);

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENCLAW_HOOKS_TOKEN}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        console.log(`[github-webhook] Wake sent (${res.statusCode}): ${body.substring(0, 100)}`);
      });
    }
  );

  req.on('error', (err) => {
    console.error(`[github-webhook] Wake failed: ${err.message}`);
  });

  req.write(postData);
  req.end();
}

function sendOpenClawAgent({ message, agentId, name, channel, to, wakeMode = 'now', deliver = true }) {
  const postData = JSON.stringify({
    message,
    agentId,
    name,
    channel,
    to,
    wakeMode,
    deliver,
  });

  const url = new URL('/hooks/agent', OPENCLAW_GATEWAY_URL);

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENCLAW_HOOKS_TOKEN}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        console.log(`[github-webhook] Agent hook sent (${res.statusCode}): ${body.substring(0, 160)}`);
      });
    }
  );

  req.on('error', (err) => {
    console.error(`[github-webhook] Agent hook failed: ${err.message}`);
  });

  req.write(postData);
  req.end();
}

function verifySignature({ rawBody, signatureHeader }) {
  if (!GITHUB_WEBHOOK_SECRET || !signatureHeader) return true;
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const expected = 'sha256=' + hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function readJsonFileOrDefault(filePath, def) {
  const fs = require('fs');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return def;
  }
}

function writeJsonFile(filePath, obj) {
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function shouldSendAck({ key, windowMs }) {
  const now = Date.now();
  const state = readJsonFileOrDefault(ACK_DEBOUNCE_PATH, {});
  const last = state[key] || 0;
  if (now - last < windowMs) return false;
  state[key] = now;
  writeJsonFile(ACK_DEBOUNCE_PATH, state);
  return true;
}

/**
 * Dispatch a single, batched CI wake for all failures accumulated
 * for a given branch key during the debounce window.
 */
function dispatchBatchedCIWake(branchKey) {
  const pending = readJsonFileOrDefault(CI_PENDING_PATH, {});
  const entry = pending[branchKey];

  if (!entry || !entry.failures.length) {
    console.log(`[github-webhook] CI debounce: no pending failures for ${branchKey}, skipping`);
    return;
  }

  // Consume the pending entry
  const failures = [...entry.failures];
  delete pending[branchKey];
  writeJsonFile(CI_PENDING_PATH, pending);

  const [repo, branch] = branchKey.split(':');
  const repoFull = `${repo}:${branch}`.includes('/') ? repo : branchKey;

  console.log(`[github-webhook] CI debounce: dispatching ${failures.length} batched failure(s) for ${branchKey}`);

  // Separate quality gate issues from code failures
  const qualityGateFailures = failures.filter(f => f.isPRQualityGate);
  const codeFailures = failures.filter(f => !f.isPRQualityGate);

  // Build a unified message listing ALL failures
  const failureList = failures.map(f =>
    `  - "${f.workflow}" (attempt ${f.count}/${f.maxFixAttempts}) ${f.runUrl}`
  ).join('\n');

  const maxCount = Math.max(...failures.map(f => f.count));
  const maxFixAttempts = Math.max(...failures.map(f => f.maxFixAttempts));

  if (qualityGateFailures.length > 0 && codeFailures.length === 0) {
    // All failures are PR Quality Gate
    sendOpenClawAgent({
      agentId: 'coder',
      name: 'PR Quality Gate Fix',
      channel: 'telegram',
      to: '-5167874742',
      wakeMode: 'now',
      deliver: true,
      message:
        `🔴 PR Quality Gate failed on branch ${branch} (${qualityGateFailures.length} check(s), attempt ${maxCount}/${maxFixAttempts})\n` +
        `Failures:\n${failureList}\n\n` +
        `This is a PR BODY template issue, not a code issue.\n\n` +
        `Instructions:\n` +
        `1. Find the PR: gh pr list --repo ${repoFull} --head ${branch} --json number,title\n` +
        `2. Read the failed CI logs for each run above\n` +
        `3. Read the PR diff to understand scope: gh pr diff PR_NUMBER --repo ${repoFull} | head -100\n` +
        `4. Write a proper PR body to /tmp/pr-body-fix.md with ALL required sections:\n` +
        `   ## Resumo\n   ## Acceptance Criteria (with - [x] checkboxes)\n   ## Testes (with "Resultado: ✅")\n   ## Cenários cobertos (with - [x] checkboxes)\n   ## Riscos e Rollback\n` +
        `5. Update: gh pr edit PR_NUMBER --repo ${repoFull} --body-file /tmp/pr-body-fix.md\n` +
        `6. Reply with what you did.`,
    });
  } else {
    // Code failures (possibly mixed with quality gate)
    sendOpenClawAgent({
      agentId: 'coder',
      name: 'CI Failure',
      channel: 'telegram',
      to: '-5167874742',
      wakeMode: 'now',
      deliver: true,
      message:
        `🔴 CI Failed: ${failures.length} check(s) on branch ${branch} (attempt ${maxCount}/${maxFixAttempts})\n` +
        `Failures:\n${failureList}\n\n` +
        `Instructions:\n` +
        `1. Read task-state.json first\n` +
        `2. Find the PR: gh pr list --repo ${repoFull} --head ${branch} --json number,title\n` +
        `3. Read CI logs for EACH failed run above: gh run view RUN_ID --log-failed --repo ${repoFull}\n` +
        `4. If the branch has a worktree, use it. Otherwise create one.\n` +
        `5. Fix ALL issues from the batch, commit, push.\n` +
        `6. If attempts >= 5: set phase=blocked, add label status:blocked\n` +
        `7. Update task-state.json before finishing`,
    });
  }

  // NOTE: main agent no longer notified — coder handles CI autonomously
}

function handleHealth(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return true;
  }
  return false;
}

function handleWebhook(req, res) {
  if (req.url !== '/api/github/webhook') return false;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }

  let body = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_PAYLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('end', () => {
    const signature = req.headers['x-hub-signature-256'];

    try {
      if (GITHUB_WEBHOOK_SECRET && signature) {
        const ok = verifySignature({ rawBody: body, signatureHeader: signature });
        if (!ok) {
          console.error('[github-webhook] Invalid signature');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
      }

      const parsed = safeJsonParse(body);
      if (!parsed.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const payload = parsed.value;
      const event = req.headers['x-github-event'] || 'unknown';

      const webhookEvent = {
        event,
        action: payload.action,
        timestamp: new Date().toISOString(),
        repository: payload.repository?.full_name,
      };

      const shortTraderRepos = new Set(['thiagown1/short_trader', 'thiagown1/short-trader']);
      const isShortTrader = shortTraderRepos.has(webhookEvent.repository);
      const shortTraderGroup = 'telegram:-5128168391';


      // Extract relevant info
      if (event === 'issue_comment' || event === 'pull_request_review_comment') {
        webhookEvent.pr_number = payload.issue?.number || payload.pull_request?.number;
        webhookEvent.pr_title = payload.issue?.title || payload.pull_request?.title;
        webhookEvent.pr_url = payload.issue?.html_url || payload.pull_request?.html_url;
        webhookEvent.pr_head_ref = payload.pull_request?.head?.ref;
        webhookEvent.pr_head_sha = payload.pull_request?.head?.sha;
        webhookEvent.comment_body = payload.comment?.body;
        webhookEvent.comment_author = payload.comment?.user?.login;
        webhookEvent.comment_url = payload.comment?.html_url;
      } else if (event === 'pull_request_review') {
        webhookEvent.pr_number = payload.pull_request?.number;
        webhookEvent.pr_title = payload.pull_request?.title;
        webhookEvent.pr_url = payload.pull_request?.html_url;
        webhookEvent.pr_head_ref = payload.pull_request?.head?.ref;
        webhookEvent.pr_head_sha = payload.pull_request?.head?.sha;
        webhookEvent.review_state = payload.review?.state;
        webhookEvent.review_body = payload.review?.body;
        webhookEvent.review_author = payload.review?.user?.login;
        webhookEvent.review_url = payload.review?.html_url;
      } else if (event === 'pull_request') {
        webhookEvent.pr_number = payload.number;
        webhookEvent.pr_title = payload.pull_request?.title;
        webhookEvent.pr_url = payload.pull_request?.html_url;
        webhookEvent.pr_author = payload.pull_request?.user?.login;
        webhookEvent.pr_state = payload.pull_request?.state;
        webhookEvent.pr_merged = payload.pull_request?.merged;
      } else if (event === 'push') {
        webhookEvent.ref = payload.ref;
        webhookEvent.pusher = payload.pusher?.name;
        webhookEvent.commits_count = payload.commits?.length;
        webhookEvent.head_message = payload.head_commit?.message?.substring(0, 200);
      } else if (event === 'workflow_run') {
        webhookEvent.workflow_name = payload.workflow_run?.name;
        webhookEvent.conclusion = payload.workflow_run?.conclusion;
        webhookEvent.status = payload.workflow_run?.status;
        webhookEvent.head_branch = payload.workflow_run?.head_branch;
        webhookEvent.workflow_run_url = payload.workflow_run?.html_url;
      } else if (event === 'check_run' || event === 'check_suite') {
        webhookEvent.check_name = payload.check_run?.name || payload.check_suite?.app?.name;
        webhookEvent.conclusion = payload.check_run?.conclusion || payload.check_suite?.conclusion;
        webhookEvent.status = payload.check_run?.status || payload.check_suite?.status;
      } else {
        webhookEvent.sender = payload.sender?.login;
      }

      const author = webhookEvent.comment_author || webhookEvent.review_author || webhookEvent.pr_author || '';
      const isCodexReview = author === 'chatgpt-codex-connector[bot]';
      const isBot = !isCodexReview && (author === 'TurboStation-ai' || author.endsWith('[bot]') || author === 'github-actions');

      const needsAttention = ['issue_comment', 'pull_request_review_comment', 'pull_request_review'].includes(event) && !isBot;

      // Spam guard:
      // - ignore edited comments for ACK (still enqueue + wake)
      // - debounce ACKs per PR+author for a short window
      const ackDebounceWindowMs = parseInt(process.env.GITHUB_ACK_DEBOUNCE_MS || '90000', 10); // 90s
      const shouldAckThisEvent = webhookEvent.action !== 'edited';

      // Release auto-notes (TestFlight)
      const releaseAutoNotesEnabled = (process.env.RELEASE_AUTONOTES_ENABLED || '1') !== '0';

      // CI failures that need auto-fix (loop protection)
      let ciNeedsAttention = false;
      if (event === 'workflow_run' && webhookEvent.action === 'completed' && webhookEvent.conclusion === 'failure') {
        const attempts = readJsonFileOrDefault(CI_ATTEMPTS_PATH, {});
        const runKey = `${webhookEvent.workflow_name}:${webhookEvent.head_branch}`;
        const headSha = payload.workflow_run?.head_sha || '';
        const now = Date.now();
        const entry = attempts[runKey] || { count: 0, firstAttempt: now, lastAttempt: 0 };

        // Skip if we already processed this exact SHA (no new code to analyze)
        if (entry.lastSha && entry.lastSha === headSha) {
          console.log(`[github-webhook] CI skip: same SHA ${headSha.substring(0, 8)} already analyzed for ${runKey}`);
          webhookEvent.sha_already_analyzed = true;
        }

        // Reset counter if last attempt was >1h ago
        if (now - entry.lastAttempt > 3600000) {
          entry.count = 0;
          entry.firstAttempt = now;
        }

        const maxFixAttempts = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || '5', 10);

        if (webhookEvent.sha_already_analyzed) {
          console.log(`[github-webhook] CI skip: SHA already analyzed for ${runKey}, not waking coder`);
        } else if (entry.count < maxFixAttempts) {
          ciNeedsAttention = true;
          entry.count++;
          entry.lastAttempt = now;
          entry.lastSha = headSha;
          attempts[runKey] = entry;
          writeJsonFile(CI_ATTEMPTS_PATH, attempts);
          console.log(`[github-webhook] CI fix attempt ${entry.count}/${maxFixAttempts} for ${runKey} (sha=${headSha.substring(0, 8)})`);
        } else {
          console.log(`[github-webhook] CI fix limit reached (${maxFixAttempts}/${maxFixAttempts}) for ${runKey}, skipping auto-fix`);
          webhookEvent.fix_limit_reached = true;
        }
      }

      // ── PR Label-based agent wake ──────────────────────────────
      // When a PR gets labeled with "needs:test-review" or "needs:sec-review",
      // instantly wake the corresponding agent to perform the review.
      if (event === 'pull_request' && webhookEvent.action === 'labeled' && !isShortTrader) {
        const addedLabel = payload.label?.name;
        const prNumber = webhookEvent.pr_number;
        const prTitle = webhookEvent.pr_title || '';
        const prUrl = webhookEvent.pr_url || '';
        const repo = webhookEvent.repository || 'thiagown1/turbo_station';

        const REVIEW_LABEL_MAP = {
          'needs:test-review': {
            agentId: 'test-engineer',
            name: 'PR Test Review',
            telegramGroup: '-5142618491',
            emoji: '🧪',
            reviewType: 'test',
          },
          'needs:sec-review': {
            agentId: 'secguard',
            name: 'PR Security Review',
            telegramGroup: '-5142618491',
            emoji: '🔒',
            reviewType: 'security',
          },
          'needs:coder-fix': {
            agentId: 'coder',
            name: 'PR Fix Requested',
            telegramGroup: '-5167874742',
            emoji: '🔧',
            reviewType: 'fix',
          },
        };

        const reviewConfig = REVIEW_LABEL_MAP[addedLabel];
        if (reviewConfig) {
          const wakeKey = `review-wake:${reviewConfig.agentId}:${repo}:${prNumber}`;
          const shouldWake = shouldSendAck({ key: wakeKey, windowMs: 30 * 60 * 1000 }); // 30min debounce

          if (shouldWake) {
            console.log(`[github-webhook] ${reviewConfig.emoji} Waking ${reviewConfig.agentId} for PR #${prNumber} (label: ${addedLabel})`);

            sendOpenClawAgent({
              agentId: reviewConfig.agentId,
              name: reviewConfig.name,
              channel: 'telegram',
              to: reviewConfig.telegramGroup,
              wakeMode: 'now',
              deliver: true,
              message: reviewConfig.reviewType === 'fix'
                ? `${reviewConfig.emoji} PR #${prNumber} needs fixes — ${prTitle}\n\n` +
                  `Link: ${prUrl}\n\n` +
                  `Test Engineer or SecGuard found issues that need fixing.\n\n` +
                  `Instructions:\n` +
                  `1. Read task-state.json first\n` +
                  `2. Read the review comments: gh pr view ${prNumber} --repo ${repo} --comments | tail -30\n` +
                  `3. Check inline review comments: gh api repos/${repo}/pulls/${prNumber}/comments --jq '.[].body'\n` +
                  `4. Fix the issues in the worktree, commit, push\n` +
                  `5. Remove label "needs:coder-fix": gh pr edit ${prNumber} --repo ${repo} --remove-label "needs:coder-fix"\n` +
                  `6. Re-add review labels if needed: gh pr edit ${prNumber} --repo ${repo} --add-label "needs:test-review,needs:sec-review"\n` +
                  `7. Update task-state.json before finishing`
                : `${reviewConfig.emoji} PR #${prNumber} needs ${reviewConfig.reviewType} review — ${prTitle}\n\n` +
                  `Link: ${prUrl}\n\n` +
                  `Instructions:\n` +
                  `1. Read HEARTBEAT.md for your full review process\n` +
                  `2. Read the PR diff: gh pr diff ${prNumber} --repo ${repo}\n` +
                  `3. Perform your ${reviewConfig.reviewType} review following your checklist\n` +
                  `4. Submit review via gh pr review\n` +
                  `5. Update labels: remove "${addedLabel}", add "reviewed:${reviewConfig.reviewType === 'test' ? 'tests' : 'security'}"`,
            });

            sendTelegramNotification(
              `${reviewConfig.emoji} PR #${prNumber} — ${prTitle}\nLabel "${addedLabel}" added. Waking ${reviewConfig.agentId}...`,
              'telegram:-5103508388'
            );
          } else {
            console.log(`[github-webhook] Review wake suppressed (debounce) for ${wakeKey}`);
          }
        }
      }

      // Auto-cleanup: when a TurboStation-ai PR is merged, remove the worktree
      const isMergedPR = event === 'pull_request' &&
        webhookEvent.action === 'closed' &&
        webhookEvent.pr_merged === true &&
        webhookEvent.pr_author === 'TurboStation-ai' &&
        !isShortTrader;

      if (isMergedPR) {
        const { exec } = require('child_process');
        const prBranch = payload.pull_request?.head?.ref || '';
        const prNumber = webhookEvent.pr_number;

        console.log(`[github-webhook] PR #${prNumber} merged — running auto-cleanup for branch ${prBranch}`);

        // 1. Remove worktree matching this branch
        const cleanupScript = `
          cd /home/openclaw/.openclaw/workspace-coder/turbo_station &&
          WORKTREE=$(git worktree list --porcelain | grep -B2 "branch refs/heads/${prBranch}" | grep "worktree " | sed 's/worktree //') &&
          if [ -n "$WORKTREE" ]; then
            git worktree remove --force "$WORKTREE" 2>/dev/null || true
            git worktree prune
            echo "REMOVED: $WORKTREE"
          else
            echo "NO_WORKTREE_FOUND"
          fi
        `;

        exec(cleanupScript, { timeout: 30000 }, (err, stdout) => {
          if (err) {
            console.error(`[github-webhook] Worktree cleanup failed: ${err.message}`);
          } else {
            console.log(`[github-webhook] Worktree cleanup: ${stdout.trim()}`);
          }
        });

        // 2. Update task-state.json — move task to completedToday
        try {
          const taskStatePath = '/home/openclaw/.openclaw/workspace-coder/task-state.json';
          const taskState = JSON.parse(fs.readFileSync(taskStatePath, 'utf8'));

          // Check activeTasks array
          const idx2 = taskState.activeTasks?.findIndex(t => t.prNumber === prNumber);
          if (idx2 >= 0) {
            taskState.completedToday = taskState.completedToday || [];
            taskState.completedToday.push({
              ...taskState.activeTasks.splice(idx2, 1)[0],
              phase: 'done',
              lastAction: new Date().toISOString(),
            });
          }

          // Check queue
          const idx = taskState.queue?.findIndex(t => t.prNumber === prNumber);
          if (idx >= 0) {
            const task = taskState.queue.splice(idx, 1)[0];
            taskState.completedToday = taskState.completedToday || [];
            taskState.completedToday.push({
              ...task,
              phase: 'done',
              lastAction: new Date().toISOString(),
            });
          }

          taskState.lastUpdated = new Date().toISOString();
          fs.writeFileSync(taskStatePath, JSON.stringify(taskState, null, 2));
          console.log(`[github-webhook] task-state.json updated — PR #${prNumber} moved to completedToday`);
        } catch (e) {
          console.error(`[github-webhook] task-state.json update failed: ${e.message}`);
        }

        // 3. Notify
        sendTelegramNotification(
          `✅ PR #${prNumber} merged! Worktree cleanup running.\n${webhookEvent.pr_title || ''}`,
          'telegram:-5103508388'
        );
      }

      webhookEvent.needs_attention = needsAttention || ciNeedsAttention;

      // Append queue
      const fs = require('fs');
      fs.appendFileSync(QUEUE_PATH, JSON.stringify(webhookEvent) + '\n');

      const sender = author || webhookEvent.sender || '';
      console.log(`[github-webhook] ${event}/${webhookEvent.action}: PR #${webhookEvent.pr_number} by ${sender}`);

      // Auto-update Next.js codebase index when master changes (turbo_station)
      if (event === 'push' && payload.ref === 'refs/heads/master' && payload.repository?.full_name === 'thiagown1/turbo_station') {
        const ok = shouldSendAck({ key: `codebase-index:${payload.repository.full_name}:${payload.after}`, windowMs: 5 * 60 * 1000 });
        if (ok) {
          try {
            const cmd = `node /home/openclaw/.openclaw/workspace/skills/codebase-indexer/generate-next-index.js`;
            exec(cmd, { timeout: 120000 }, (err) => {
              if (err) console.error(`[codebase-index] failed: ${err.message}`);
              else console.log('[codebase-index] updated for master push');
            });
          } catch (e) {
            console.error('[codebase-index] exception:', e.message);
          }
        }
      }

      // ── Auto-deploy turbo-station-monitor on push to main ──────────
      if (event === 'push' && payload.ref === 'refs/heads/main' && payload.repository?.full_name === 'thiagown1/turbo-station-monitor') {
        const deployKey = `deploy:turbo-station-monitor:${payload.after}`;
        const shouldDeploy = shouldSendAck({ key: deployKey, windowMs: 30 * 1000 }); // 30s dedup

        if (shouldDeploy) {
          const { exec } = require('child_process');
          const monitorDir = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor';
          const commitMsg = (payload.head_commit?.message || '').substring(0, 80);
          const pusher = payload.pusher?.name || 'unknown';

          console.log(`[auto-deploy] turbo-station-monitor push by ${pusher}: "${commitMsg}"`);

          // Step 1: git pull
          exec(`cd ${monitorDir} && git pull origin main`, { timeout: 30000 }, (pullErr, pullStdout) => {
            if (pullErr) {
              console.error(`[auto-deploy] git pull failed: ${pullErr.message}`);
              sendTelegramNotification(
                `❌ Auto-deploy falhou (git pull):\n${pullErr.message.substring(0, 200)}`,
                'telegram:-5103508388'
              );
              return;
            }

            console.log(`[auto-deploy] git pull: ${pullStdout.trim()}`);

            // Step 2: Detect which services changed based on committed files
            const changedFiles = (payload.commits || []).flatMap(c =>
              [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]
            );

            const serviceMap = {
              'services/support-copilot/': 'support-copilot',
              'services/whatsapp-gateway/': 'whatsapp-gateway',
              'services/smart-collector.js': 'ocpp-collector',
              'services/alert-processor.js': 'ocpp-alerts',
              'services/vercel-drain.js': 'vercel-drain',
              'services/github-webhook.js': 'github-webhook',
              'services/mobile-telemetry/': 'mobile-telemetry',
              'services/pagarme-status-webhook.js': 'pagarme-status-webhook',
              'services/alert-engine.js': 'alert-engine',
            };

            const servicesToRestart = new Set();

            // If ecosystem.config.js changed, restart everything
            if (changedFiles.some(f => f === 'ecosystem.config.js' || f === '.env')) {
              Object.values(serviceMap).forEach(s => servicesToRestart.add(s));
            } else {
              for (const file of changedFiles) {
                for (const [prefix, service] of Object.entries(serviceMap)) {
                  if (file.startsWith(prefix)) {
                    servicesToRestart.add(service);
                  }
                }
              }
            }

            if (servicesToRestart.size === 0) {
              console.log('[auto-deploy] No service files changed, skipping restart');
              sendTelegramNotification(
                `📦 Monitor atualizado (sem restart): "${commitMsg}" by ${pusher}`,
                'telegram:-5103508388'
              );
              return;
            }

            // Step 3: Send notification FIRST, then restart
            // (If github-webhook itself is restarted, we'd lose the notification)
            const services = [...servicesToRestart].join(', ');
            sendTelegramNotification(
              `🚀 Auto-deploy turbo-station-monitor: "${commitMsg}" by ${pusher} | Reiniciando: ${services}`,
              'telegram:-5103508388'
            );

            // Delay restart slightly so the notification has time to send
            const restartDelay = servicesToRestart.has('github-webhook') ? 2000 : 500;
            setTimeout(() => {
              const restartCmd = [...servicesToRestart].map(s => `pm2 restart ${s} --update-env`).join(' && ');
              exec(restartCmd, { timeout: 30000 }, (restartErr) => {
                if (restartErr) {
                  console.error(`[auto-deploy] pm2 restart failed: ${restartErr.message}`);
                } else {
                  exec('pm2 save', { timeout: 10000 }, () => {});
                  console.log(`[auto-deploy] ✅ Restarted: ${services}`);
                }
              });
            }, restartDelay);
          });
        }
      }

      // Auto-update release notes for TestFlight tags
      if (releaseAutoNotesEnabled && event === 'release') {
        const tag = payload.release?.tag_name;
        const action = payload.action;
        const repoFull = payload.repository?.full_name;

        if (tag && typeof tag === 'string' && tag.startsWith('ios/tf/') && ['published', 'created'].includes(action)) {
          // debounce per tag (avoid double edits)
          const ok = shouldSendAck({ key: `release:${repoFull}:${tag}`, windowMs: 10 * 60 * 1000 });
          if (ok) {
            try {
              const cmd = `cd /home/openclaw/.openclaw/workspace/ai-devops/turbo_station && node /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/release-autonotes.js --repo ${repoFull} --tag ${tag}`;
              exec(cmd, { timeout: 120000 }, (err) => {
                if (err) console.error(`[release-autonotes] failed: ${err.message}`);
                else console.log(`[release-autonotes] updated: ${tag}`);
              });
            } catch (e) {
              console.error('[release-autonotes] exception:', e.message);
            }
          } else {
            console.log(`[release-autonotes] suppressed (debounce) for ${repoFull}:${tag}`);
          }
        }
      }

      // Instant ACK + Wake
      if (needsAttention) {
        const bodyText = webhookEvent.comment_body || webhookEvent.review_body || '';
        const preview = bodyText.length > 100 ? bodyText.substring(0, 100) + '...' : bodyText;

        const ackKey = `pr:${webhookEvent.pr_number}:author:${author}`;
        const canAck = shouldAckThisEvent && shouldSendAck({ key: ackKey, windowMs: ackDebounceWindowMs });

        // 👀 React to the comment on GitHub (instant visual feedback)
        const commentId = payload.comment?.id || payload.review?.id;
        if (commentId && !isBot) {
          addGitHubReaction({ repo: webhookEvent.repository, commentId, type: event });
        }

        if (canAck) {
          const prUrl = getPullRequestUrl({ repository: webhookEvent.repository, prNumber: webhookEvent.pr_number, fallbackUrl: webhookEvent.pr_url });
          const link = webhookEvent.comment_url || webhookEvent.review_url || prUrl;
          const title = webhookEvent.pr_title ? ` — ${webhookEvent.pr_title}` : '';

          // Keep ACK short but actionable: PR number + link.
          const ackTarget = isShortTrader ? shortTraderGroup : 'telegram:-5103508388';
          sendTelegramNotification(
            `🔔 ${author} comentou (${webhookEvent.action}) na PR #${webhookEvent.pr_number}${title}\n${link || ''}\n"${preview}"\n⚡ Processando...`,
            ackTarget
          );

          if (isShortTrader) {
            // Trigger MoneyMan automatically for short_trader events.
            sendOpenClawAgent({
              agentId: 'moneyman',
              name: 'GitHub short_trader',
              channel: 'telegram',
              to: '-5128168391',
              wakeMode: 'now',
              deliver: true,
              message:
                `Você é o MoneyMan. Chegou um evento do GitHub do repo ${webhookEvent.repository}.\n\n` +
                `Tipo: ${webhookEvent.event} (${webhookEvent.action})\n` +
                `Autor: ${author}\n` +
                `PR: #${webhookEvent.pr_number || ''} ${webhookEvent.pr_title || ''}\n` +
                `Link: ${link || ''}\n\n` +
                `Preview: "${preview}"\n\n` +
                `Tarefa: avalie se precisa agir (responder comentário, abrir PR, corrigir CI, etc). Se precisar mexer em código, clone/atualize o repo short_trader e faça a ação. Responda com um status curto + próximo passo.`,
            });
          }
        } else {
          console.log(`[github-webhook] ACK suppressed (debounce or edited) for ${ackKey}`);
        }

        // Route Turbo Station events directly to the coder agent
        if (!isShortTrader) {
          if (isCodexReview) {
            // Codex review comments can arrive in bursts (many inline events).
            // Coalesce by PR + head SHA to avoid Telegram/PR spam and repeated work.
            const reviewKey = `codex-review:${webhookEvent.repository}:${webhookEvent.pr_number}:${webhookEvent.pr_head_sha || webhookEvent.pr_head_ref || 'unknown'}`;
            const shouldDispatchCodexReview = shouldAckThisEvent && shouldSendAck({
              key: reviewKey,
              windowMs: CODEX_REVIEW_DEBOUNCE_MS,
            });

            if (!shouldDispatchCodexReview) {
              console.log(`[github-webhook] Codex review wake suppressed (debounce): ${reviewKey}`);
            } else {
              sendOpenClawAgent({
                agentId: 'coder',
                name: 'Codex Review',
                channel: 'telegram',
                to: '-5167874742',
                wakeMode: 'now',
                // Internal wake only; coder should send one consolidated checkpoint.
                deliver: false,
                message:
                  `🤖 Codex Review on PR #${webhookEvent.pr_number} — ${webhookEvent.pr_title || ''}\n\n` +
                  `Codex left review comments. Address them in ONE consolidated pass (no repeated spam).\n\n` +
                  `Instructions:\n` +
                  `1. Read task-state.json to find the worktree for this PR's branch\n` +
                  `2. Read ALL Codex comments once: gh pr view ${webhookEvent.pr_number} --repo ${webhookEvent.repository} --comments\n` +
                  `3. Also check inline review comments once: gh api repos/${webhookEvent.repository}/pulls/${webhookEvent.pr_number}/comments --jq '.[].body'\n` +
                  `4. Evaluate each suggestion:\n` +
                  `   - P0/P1 (bugs, security) → MUST fix\n` +
                  `   - P2 (improvements) → SHOULD fix\n` +
                  `   - P3 (style/nitpick) → fix if easy, skip if risky\n` +
                  `5. Implement fixes in the worktree, commit, push\n` +
                  `6. IMPORTANT: all changes must be BACKWARDS COMPATIBLE\n` +
                  `7. Post AT MOST ONE PR comment in this run, and only if there is a new commit pushed.\n` +
                  `8. Update task-state.json before finishing`,
              });
            }
          } else {
            // Human comment — wake coder directly
            sendOpenClawAgent({
              agentId: 'coder',
              name: 'GitHub Turbo Station',
              channel: 'telegram',
              to: '-5167874742',
              wakeMode: 'now',
              deliver: true,
              message:
                `GitHub event: ${author} (${webhookEvent.action}) on PR #${webhookEvent.pr_number} — ${webhookEvent.pr_title || ''}\n\n` +
                `Comment: "${preview}"\n\n` +
                `Instructions:\n` +
                `1. Read task-state.json first\n` +
                `2. Read the full comment on GitHub: gh pr view ${webhookEvent.pr_number} --repo ${webhookEvent.repository} --comments | tail -30\n` +
                `3. If the comment requests a code change: update task-state.json, switch to the relevant worktree, implement the fix\n` +
                `4. If the comment is just feedback/approval: acknowledge and update task-state.json\n` +
                `5. Update task-state.json before finishing`,
            });
          }

          // NOTE: main agent no longer woken — coder handles PR feedback autonomously
        }
      } else if (ciNeedsAttention) { 
        const maxFixAttempts = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || '5', 10);
        const attempts = readJsonFileOrDefault(CI_ATTEMPTS_PATH, {});
        const runKey = `${webhookEvent.workflow_name}:${webhookEvent.head_branch}`;
        const count = attempts[runKey]?.count || 1;

        const runUrl = webhookEvent.workflow_run_url;
        sendTelegramNotification(
          `🔴 CI falhou: "${webhookEvent.workflow_name}" (${webhookEvent.head_branch})\n${runUrl || ''}\n⚡ Analisando... (tentativa ${count}/${maxFixAttempts})`,
          isShortTrader ? shortTraderGroup : 'telegram:-5103508388'
        );

        if (isShortTrader) {
          sendOpenClawAgent({
            agentId: 'moneyman',
            name: 'GitHub short_trader CI',
            channel: 'telegram',
            to: '-5128168391',
            wakeMode: 'now',
            deliver: true,
            message:
              `CI falhou no repo ${webhookEvent.repository}.\n` +
              `Workflow: ${webhookEvent.workflow_name}\n` +
              `Branch: ${webhookEvent.head_branch}\n` +
              `Run: ${runUrl || ''}\n` +
              `Tentativa: ${count}/${maxFixAttempts}\n\n` +
              `Tarefa: diagnosticar o motivo do failure e propor (ou aplicar) correção no repo short_trader. Responda com status curto e próximo passo.`,
          });
        }

        if (!isShortTrader) {
          // ── Debounced CI wake ──────────────────────────────────────
          // Instead of waking the coder immediately for each failing
          // workflow, buffer failures per branch and dispatch a single
          // batched wake after CI_DEBOUNCE_MS (default 60s). This way
          // if 3 checks fail from the same push, the coder gets ONE
          // wake with all 3 failures listed.
          const pending = readJsonFileOrDefault(CI_PENDING_PATH, {});
          const branchKey = `${webhookEvent.repository}:${webhookEvent.head_branch}`;

          if (!pending[branchKey]) {
            pending[branchKey] = { failures: [], firstSeen: Date.now() };
          }

          pending[branchKey].failures.push({
            workflow: webhookEvent.workflow_name,
            runUrl: runUrl || '(no url)',
            count,
            maxFixAttempts,
            isPRQualityGate: (webhookEvent.workflow_name || '').toLowerCase().includes('pr quality gate'),
            workflowRunId: payload.workflow_run?.id || '',
          });
          writeJsonFile(CI_PENDING_PATH, pending);

          // Schedule the batched dispatch (only if this is the first
          // failure in this debounce window)
          if (pending[branchKey].failures.length === 1) {
            console.log(`[github-webhook] CI debounce: first failure for ${branchKey}, dispatching in ${CI_DEBOUNCE_MS}ms`);
            setTimeout(() => {
              dispatchBatchedCIWake(branchKey);
            }, CI_DEBOUNCE_MS);
          } else {
            console.log(`[github-webhook] CI debounce: buffered failure #${pending[branchKey].failures.length} for ${branchKey}`);
          }
        }

        // Dispatch to Night workers when the CI issue is persisting
        if (count >= 2) {
          try {
            const backlogPath = '/home/openclaw/.openclaw/workspace/groups/telegram/-5143783696-night-workers/BACKLOG.md';
            const ts = new Date().toISOString();
            const item = `\n- [${ts}] CI failing: "${webhookEvent.workflow_name}" (${webhookEvent.head_branch}) attempt ${count}/${maxFixAttempts}\n  - Run: ${runUrl || '(no url)'}\n  - Next: investigar logs do run, aplicar fix mínimo, abrir PR/commit e re-rodar CI\n`;
            fs.appendFileSync(backlogPath, item);

            sendNightWorkersPing(
              `📨 Dispatch (GitHub Hub → Night workers)\nCI falhou: "${webhookEvent.workflow_name}" (${webhookEvent.head_branch})\n${runUrl || ''}\nTentativa ${count}/${maxFixAttempts}\n\nBacklog: groups/telegram/-5143783696-night-workers/BACKLOG.md`
            );
          } catch (e) {
            console.error('[dispatch] failed:', e.message);
          }
        }
      } else if (webhookEvent.fix_limit_reached) {
        sendOpenClawWake(
          `⚠️ CI fix limit reached: "${webhookEvent.workflow_name}" on ${webhookEvent.head_branch} failed ${process.env.CI_FIX_MAX_ATTEMPTS || '5'} times. ` +
            `Stopping auto-fix to prevent infinite loop. Notify Thiago with the full diagnosis.`
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[github-webhook] Error:', err?.stack || err?.message || String(err));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });

  req.on('error', (err) => {
    console.error('[github-webhook] Request error:', err.message);
  });

  return true;
}

function requestHandler(req, res) {
  if (handleHealth(req, res)) return;
  if (handleWebhook(req, res)) return;

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

http.createServer(requestHandler).listen(PORT, () => {
  console.log(`[github-webhook] Server listening on port ${PORT}`);
  console.log(`[github-webhook] Endpoint: http://localhost:${PORT}/api/github/webhook`);
});
