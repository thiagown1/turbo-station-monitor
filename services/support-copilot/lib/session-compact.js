/**
 * Session compaction via the OpenClaw CLI — Support Copilot
 *
 * Compaction used to be triggered by sending the literal `/compact` as an agent
 * message (`openclaw agent --session-id <id> --message /compact`). That worked
 * until OpenClaw 2026.7.1-2 landed on the box, which rejects slash commands on
 * that path:
 *
 *   Slash commands cannot be executed via --message from the CLI.
 *   Use: openclaw sessions compact <key>
 *
 * Timeline on the VPS: last successful compaction 2026-08-14 23:12:22, gateway
 * restarted onto 2026.7.1-2 at 23:58:07, first rejection at 2026-08-15 00:20:27.
 * From then on every compaction failed — 102 rejections over four days, zero
 * successes. Nobody noticed because `compactSession` treats the failure as
 * non-critical and stamps `compacted_at` regardless, so the DB claimed the
 * sessions were compacted while the transcripts kept growing (issue #48).
 *
 * This module speaks the supported interface instead.
 *
 * @module lib/session-compact
 */

'use strict';

const { execFile } = require('child_process');
const { LOG_TAG } = require('./constants');

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/openclaw/.npm-global/bin/openclaw';

/** How long to give the gateway RPC before giving up. */
const COMPACT_TIMEOUT_MS = parseInt(process.env.SUPPORT_COMPACT_TIMEOUT_MS || '', 10) || 180_000;

/**
 * Transcript lines to keep when falling back to truncation.
 *
 * LLM summarization has to load the whole transcript, so it is exactly what an
 * overgrown session cannot do — the 39MB alert session could not be summarized
 * even with a 4-minute deadline. `--max-lines` truncates without reading the
 * session into a model, which is the only thing that works past that point.
 */
const COMPACT_MAX_LINES = parseInt(process.env.SUPPORT_COMPACT_MAX_LINES || '', 10) || 300;

/**
 * Build the session key `openclaw sessions compact` expects.
 *
 * The copilot always addresses sessions by explicit id (`--session-id`), which
 * the store keys as `agent:<agentId>:explicit:<sessionId>`. (A bare
 * `agent:<agentId>:main` also exists and points at whichever session was last
 * made "main"; targeting that would compact the wrong transcript.)
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @returns {string}
 */
function sessionKey(agentId, sessionId) {
  return `agent:${agentId}:explicit:${sessionId}`;
}

/**
 * Compact a session transcript through the OpenClaw gateway.
 *
 * @param {string} sessionId
 * @param {string} agentId
 * @param {{ maxLines?: number, timeoutMs?: number, exec?: Function }} [opts]
 *   maxLines - truncate to the last N lines instead of LLM-summarizing
 *   exec     - `child_process.execFile` stand-in; tests assert on the argv this
 *              receives, which is the whole point (the previous breakage was an
 *              argv shape the CLI refuses)
 * @returns {Promise<{ ok: boolean, mode: 'summarize'|'truncate', error?: string }>}
 *   Never rejects: compaction is best-effort and the caller logs the outcome.
 */
function compactSessionViaCli(sessionId, agentId, opts = {}) {
  const exec = opts.exec || execFile;
  const mode = opts.maxLines ? 'truncate' : 'summarize';
  const args = [
    'sessions', 'compact', sessionKey(agentId, sessionId),
    '--agent', agentId,
    '--json',
    '--timeout', String(opts.timeoutMs || COMPACT_TIMEOUT_MS),
  ];
  if (opts.maxLines) args.push('--max-lines', String(opts.maxLines));

  return new Promise((resolve) => {
    exec(
      OPENCLAW_BIN,
      args,
      // Give the child a little more wall-clock than the RPC deadline so the
      // CLI gets a chance to report a structured error instead of being killed.
      { timeout: (opts.timeoutMs || COMPACT_TIMEOUT_MS) + 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        // `--json` reports failures in the payload (`{"ok": false, "error": ...}`)
        // and can still exit 0, so the payload is authoritative — checking only
        // the exit code is how the previous breakage stayed invisible.
        let payload = null;
        try {
          payload = JSON.parse(String(stdout || '').trim());
        } catch { /* not JSON — fall through to the error path below */ }

        if (payload && typeof payload.ok === 'boolean') {
          if (payload.ok) return resolve({ ok: true, mode });
          return resolve({ ok: false, mode, error: payload.error || 'compaction reported ok:false' });
        }

        const detail = (error && error.message) || String(stderr || '').trim() || 'no output from openclaw sessions compact';
        return resolve({ ok: false, mode, error: detail.slice(0, 400) });
      }
    );
  });
}

/**
 * Compact a session, falling back to truncation when summarization fails.
 *
 * An overgrown transcript is precisely the case where summarization cannot run,
 * so retrying it forever would be pointless churn — and the session that most
 * needs compacting would be the one that never gets it.
 *
 * @param {string} sessionId
 * @param {string} agentId
 * @param {{ maxLines?: number, forceTruncate?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, mode: string, error?: string }>}
 */
async function compactSessionWithFallback(sessionId, agentId, opts = {}) {
  const maxLines = opts.maxLines || COMPACT_MAX_LINES;
  const exec = opts.exec;

  if (!opts.forceTruncate) {
    const summarized = await compactSessionViaCli(sessionId, agentId, { exec });
    if (summarized.ok) return summarized;
    console.warn(
      `${LOG_TAG} Summarizing compaction failed for ${sessionId} (${summarized.error}); ` +
      `falling back to truncation at ${maxLines} lines`
    );
  }

  const truncated = await compactSessionViaCli(sessionId, agentId, { maxLines, exec });
  return truncated;
}

module.exports = {
  sessionKey,
  compactSessionViaCli,
  compactSessionWithFallback,
  COMPACT_MAX_LINES,
  COMPACT_TIMEOUT_MS,
};
