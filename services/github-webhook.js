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
 * - Record PR/CI evidence without auto-dispatching a code writer
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');
const { resolveServicePort, BIND_HOST } = require('./lib/service-port');

const PORT = resolveServicePort('GITHUB_WEBHOOK_PORT', 3002, '[github-webhook]');
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '';
const OPENCLAW_CLI = process.env.OPENCLAW_CLI || '/home/openclaw/.npm-global/bin/openclaw';

const QUEUE_PATH = path.join(__dirname, '..', 'github-webhook-queue.jsonl');
const CI_ATTEMPTS_PATH = path.join(__dirname, '..', 'ci-fix-attempts.json');
const ACK_DEBOUNCE_PATH = path.join(__dirname, '..', 'github-ack-debounce.json');

const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB (comments and webhook payloads are small)

function sendTelegramNotification(text, target = 'telegram:-5103508388') {
  execFile(
    OPENCLAW_CLI,
    ['message', 'send', '--channel', 'telegram', '--target', target, '--message', String(text)],
    { timeout: 10000 },
    (err) => {
      if (err) console.error(`[telegram-notify] CLI failed: ${err.message}`);
      else console.log(`[telegram-notify] Sent to ${target}: ${text.substring(0, 80)}`);
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

function sendOpenClawAgentRequest({ message, agentId, name, channel, to, wakeMode = 'now', deliver = true }) {
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
  if (!GITHUB_WEBHOOK_SECRET || !signatureHeader) return false;
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const expected = 'sha256=' + hmac.digest('hex');
  const provided = Buffer.from(signatureHeader);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
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

const TURBO_STATION_REPO = 'thiagown1/turbo_station';
const TURBO_STATION_CODER_WORKSPACE = '/home/openclaw/.openclaw/workspace-coder/turbo_station';
const CODER_WORKTREES_ROOT = '/home/openclaw/.openclaw/workspace-coder/worktrees';

function findWorktreeForBranch(porcelain, branch) {
  const expectedRef = `refs/heads/${branch}`;
  for (const block of String(porcelain || '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    const branchRef = lines.find(line => line.startsWith('branch '))?.slice('branch '.length);
    if (worktree && branchRef === expectedRef) return worktree;
  }
  return null;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function cleanupMergedTurboWorktree(branch, prNumber) {
  if (!branch) {
    console.error(`[github-webhook] Refusing PR #${prNumber} cleanup without an exact branch`);
    return;
  }

  execFile(
    'git',
    ['-C', TURBO_STATION_CODER_WORKSPACE, 'worktree', 'list', '--porcelain'],
    { timeout: 15000 },
    (listError, stdout) => {
      if (listError) {
        console.error(`[github-webhook] Worktree lookup failed: ${listError.message}`);
        return;
      }

      const worktree = findWorktreeForBranch(stdout, branch);
      if (!worktree) {
        console.log(`[github-webhook] No registered worktree found for PR #${prNumber}`);
        return;
      }
      if (!isPathInside(CODER_WORKTREES_ROOT, worktree)) {
        console.error(`[github-webhook] Refusing cleanup outside dedicated worktree root: ${worktree}`);
        return;
      }

      execFile(
        'git',
        ['-C', TURBO_STATION_CODER_WORKSPACE, 'worktree', 'remove', '--force', worktree],
        { timeout: 30000 },
        (removeError) => {
          if (removeError) {
            console.error(`[github-webhook] Worktree cleanup failed: ${removeError.message}`);
            return;
          }
          console.log(`[github-webhook] Worktree removed for PR #${prNumber}: ${worktree}`);
          execFile(
            'git',
            ['-C', TURBO_STATION_CODER_WORKSPACE, 'worktree', 'prune'],
            { timeout: 15000 },
            (pruneError) => {
              if (pruneError) console.error(`[github-webhook] Worktree prune failed: ${pruneError.message}`);
            }
          );
        }
      );
    }
  );
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

function handleHealth(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    // X-Service lets scripts/check-ports.js tell WHICH process owns this socket.
    // Body stays 'OK\n' — several probes match on it.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Service': 'github-webhook' });
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
      if (!GITHUB_WEBHOOK_SECRET) {
        console.error('[github-webhook] Secret not configured; request rejected');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook unavailable' }));
        return;
      }
      if (!verifySignature({ rawBody: body, signatureHeader: signature })) {
        console.error('[github-webhook] Invalid or missing signature');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
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
        webhookEvent.pr_base_sha = payload.pull_request?.base?.sha;
        webhookEvent.comment_body = payload.comment?.body;
        webhookEvent.comment_author = payload.comment?.user?.login;
        webhookEvent.comment_url = payload.comment?.html_url;
      } else if (event === 'pull_request_review') {
        webhookEvent.pr_number = payload.pull_request?.number;
        webhookEvent.pr_title = payload.pull_request?.title;
        webhookEvent.pr_url = payload.pull_request?.html_url;
        webhookEvent.pr_head_ref = payload.pull_request?.head?.ref;
        webhookEvent.pr_head_sha = payload.pull_request?.head?.sha;
        webhookEvent.pr_base_sha = payload.pull_request?.base?.sha;
        webhookEvent.review_state = payload.review?.state;
        webhookEvent.review_body = payload.review?.body;
        webhookEvent.review_author = payload.review?.user?.login;
        webhookEvent.review_commit_sha = payload.review?.commit_id;
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
      const isThiagoIntervention = !isBot && (
        author === 'thiagown1' ||
        webhookEvent.comment_author === 'thiagown1' ||
        webhookEvent.review_author === 'thiagown1' ||
        payload.sender?.login === 'thiagown1'
      );

      // Spam guard:
      // - ignore edited comments for ACK (still enqueue + wake)
      // - debounce ACKs per PR+author for a short window
      const ackDebounceWindowMs = parseInt(process.env.GITHUB_ACK_DEBOUNCE_MS || '90000', 10); // 90s
      const shouldAckThisEvent = webhookEvent.action !== 'edited';

      // Release auto-notes (TestFlight)
      const releaseAutoNotesEnabled = (process.env.RELEASE_AUTONOTES_ENABLED || '1') !== '0';

      // Human intervention resets the CI evidence counter for the affected branch/PR.
      if (isThiagoIntervention && webhookEvent.pr_head_ref) {
        const attempts = readJsonFileOrDefault(CI_ATTEMPTS_PATH, {});
        const branch = webhookEvent.pr_head_ref;
        let resetCount = 0;

        for (const key of Object.keys(attempts)) {
          if (key.endsWith(`:${branch}`)) {
            delete attempts[key];
            resetCount++;
          }
        }

        if (resetCount > 0) {
          writeJsonFile(CI_ATTEMPTS_PATH, attempts);
          console.log(`[github-webhook] Thiago intervention detected on ${branch} — reset ${resetCount} CI evidence counter(s)`);
        }
      }

      // CI failures that need attention (notification loop protection)
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

        const maxFixAttempts = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || '3', 10);

        if (webhookEvent.sha_already_analyzed) {
          console.log(`[github-webhook] CI skip: SHA already recorded for ${runKey}`);
        } else if (entry.count < maxFixAttempts) {
          ciNeedsAttention = true;
          entry.count++;
          entry.lastAttempt = now;
          entry.lastSha = headSha;
          attempts[runKey] = entry;
          writeJsonFile(CI_ATTEMPTS_PATH, attempts);
          console.log(`[github-webhook] CI evidence observation ${entry.count}/${maxFixAttempts} for ${runKey} (sha=${headSha.substring(0, 8)})`);
        } else {
          console.log(`[github-webhook] CI evidence limit reached (${maxFixAttempts}/${maxFixAttempts}) for ${runKey}`);
          webhookEvent.fix_limit_reached = true;
        }
      }

      // Submitted reviews are evidence only. In the target repositories,
      // `needs:coder-fix` can trigger a writer workflow, so this ingress must
      // never add or remove it (or any pending-review label).
      if (event === 'pull_request_review' && webhookEvent.action === 'submitted' && !isShortTrader) {
        const reviewState = (webhookEvent.review_state || '').toLowerCase();
        if (reviewState === 'changes_requested') {
          console.log(
            `[github-webhook] CHANGES_REQUESTED recorded as evidence only; ` +
            `no writer-triggering label changed for ${webhookEvent.repository}#${webhookEvent.pr_number}`
          );
        }
      }

      // Cleanup is repository-scoped and argv-only. OCPP has no audited local
      // workspace mapping here, so its merge event remains evidence-only.
      const isMergedTurboStationPR = event === 'pull_request' &&
        webhookEvent.action === 'closed' &&
        webhookEvent.pr_merged === true &&
        webhookEvent.pr_author === 'TurboStation-ai' &&
        webhookEvent.repository === TURBO_STATION_REPO;

      if (isMergedTurboStationPR) {
        const prBranch = payload.pull_request?.head?.ref || '';
        const prNumber = webhookEvent.pr_number;

        console.log(`[github-webhook] PR #${prNumber} merged — running auto-cleanup for branch ${prBranch}`);
        cleanupMergedTurboWorktree(prBranch, prNumber);

        sendTelegramNotification(
          `✅ PR #${prNumber} merged! Worktree cleanup running.\n${webhookEvent.pr_title || ''}`,
          'telegram:-5103508388'
        );
      }

      webhookEvent.needs_attention = needsAttention || ciNeedsAttention;

      // Append queue
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
          const monitorDir = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor';
          const commitMsg = (payload.head_commit?.message || '').substring(0, 80);
          const pusher = payload.pusher?.name || 'unknown';
          const deployScript = path.join(monitorDir, 'scripts', 'deploy-monitor.js');
          const child = spawn(process.execPath, [deployScript, payload.after, commitMsg, pusher], {
            cwd: monitorDir,
            env: process.env,
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          console.log(`[auto-deploy] worker started for ${String(payload.after || '').slice(0, 8)} by ${pusher}`);
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
            sendOpenClawAgentRequest({
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

        // PR feedback is evidence, not writer authorization. Turbo Station and
        // OCPP repairs are dispatched manually with an exact immutable tuple;
        // no public comment, bot review, or edited event may start the Coder.
        if (!isShortTrader) {
          console.log(`[github-webhook] PR feedback recorded; manual exact-tuple repair required for ${webhookEvent.repository}#${webhookEvent.pr_number}`);
        }
      } else if (ciNeedsAttention) { 
        const maxFixAttempts = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || '3', 10);
        const attempts = readJsonFileOrDefault(CI_ATTEMPTS_PATH, {});
        const runKey = `${webhookEvent.workflow_name}:${webhookEvent.head_branch}`;
        const count = attempts[runKey]?.count || 1;

        const runUrl = webhookEvent.workflow_run_url;
        sendTelegramNotification(
          `🔴 CI falhou: "${webhookEvent.workflow_name}" (${webhookEvent.head_branch})\n${runUrl || ''}\n⚡ Analisando... (tentativa ${count}/${maxFixAttempts})`,
          isShortTrader ? shortTraderGroup : 'telegram:-5103508388'
        );

        if (isShortTrader) {
          sendOpenClawAgentRequest({
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

        if (!isShortTrader && count >= 2) {
          console.log(
            `[github-webhook] Persistent CI failure recorded as evidence only; ` +
            `manual repair required (${webhookEvent.repository}:${webhookEvent.head_branch}, attempt ${count}/${maxFixAttempts})`
          );
        }
      } else if (webhookEvent.fix_limit_reached) {
        sendTelegramNotification(
          `⚠️ CI fix limit reached: "${webhookEvent.workflow_name}" on ${webhookEvent.head_branch} failed ${process.env.CI_FIX_MAX_ATTEMPTS || '3'} times. ` +
            `Automatic repair is disabled; manual diagnosis is required.`
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

http.createServer(requestHandler).listen(PORT, BIND_HOST, () => {
  console.log(`[github-webhook] Server listening on ${BIND_HOST}:${PORT}`);
  console.log(`[github-webhook] Endpoint: http://localhost:${PORT}/api/github/webhook`);
});
