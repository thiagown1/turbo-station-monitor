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
        webhookEvent.comment_body = payload.comment?.body;
        webhookEvent.comment_author = payload.comment?.user?.login;
        webhookEvent.comment_url = payload.comment?.html_url;
      } else if (event === 'pull_request_review') {
        webhookEvent.pr_number = payload.pull_request?.number;
        webhookEvent.pr_title = payload.pull_request?.title;
        webhookEvent.pr_url = payload.pull_request?.html_url;
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
      const isBot = author === 'TurboStation-ai' || author.endsWith('[bot]') || author === 'github-actions';

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
        const now = Date.now();
        const entry = attempts[runKey] || { count: 0, firstAttempt: now, lastAttempt: 0 };

        // Reset counter if last attempt was >1h ago
        if (now - entry.lastAttempt > 3600000) {
          entry.count = 0;
          entry.firstAttempt = now;
        }

        const maxFixAttempts = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || '10', 10);

        if (entry.count < maxFixAttempts) {
          ciNeedsAttention = true;
          entry.count++;
          entry.lastAttempt = now;
          attempts[runKey] = entry;
          writeJsonFile(CI_ATTEMPTS_PATH, attempts);
          console.log(`[github-webhook] CI fix attempt ${entry.count}/${maxFixAttempts} for ${runKey}`);
        } else {
          console.log(`[github-webhook] CI fix limit reached (${maxFixAttempts}/${maxFixAttempts}) for ${runKey}, skipping auto-fix`);
          webhookEvent.fix_limit_reached = true;
        }
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

        // Keep current pipeline for the main system (Turbo Station).
        // For short_trader we rely on sendOpenClawAgent above to route to MoneyMan.
        if (!isShortTrader) {
          sendOpenClawWake(
            `🔔 GitHub: ${author} (${webhookEvent.action}) on PR #${webhookEvent.pr_number} (${webhookEvent.pr_title}): "${preview}"\n\n` +
              `Process the github-webhook-queue.jsonl file. Read the comment, analyze if it needs a code fix or reply, and act accordingly.`
          );
        }
      } else if (ciNeedsAttention) { 
        const maxFixAttempts = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || '10', 10);
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
          sendOpenClawWake(
            `🔴 CI Failed: "${webhookEvent.workflow_name}" on branch ${webhookEvent.head_branch} (attempt ${count}/${maxFixAttempts})\n\n` +
              `Auto-fix: Read the CI failure logs with 'gh run view --log-failed', diagnose the issue, fix it if possible, commit and push. ` +
              `If you cannot fix it or it's a pre-existing issue unrelated to our PR branch changes, notify in GitHub Hub with the diagnosis. ` +
              `DO NOT attempt to fix pre-existing issues in the codebase that are unrelated to our PR branch changes.`
          );
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
          `⚠️ CI fix limit reached: "${webhookEvent.workflow_name}" on ${webhookEvent.head_branch} failed ${process.env.CI_FIX_MAX_ATTEMPTS || '10'} times. ` +
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
