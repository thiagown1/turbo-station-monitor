#!/usr/bin/env node
/**
 * agent-repo-sync.js — keep every per-agent turbo_station-family checkout
 * fetched, reacting to GitHub push events instead of blindly polling.
 *
 * Replaces the old ad-hoc `sync-repos` pm2 process, whose script lived as an
 * untracked file inside workspace-coder/turbo_station (the coder agent's own
 * disposable PR-review checkout) and silently vanished when that checkout was
 * cleaned/reset — see docs/internal/todos or the 2026-07 incident note.
 *
 * Design:
 *   - Tails the same github-webhook-queue.jsonl the auto-doc-worker already
 *     consumes (byte offset + inode tracked in a local state file, same
 *     fast-forward-on-first-run / reset-on-rotation approach).
 *   - On a new `push` event for a watched repo, OR once FALLBACK_INTERVAL_MS
 *     has elapsed since the last sync (missed-webhook safety net), runs
 *     `git fetch` — never merge/checkout/reset — across every known agent
 *     checkout. Several of these checkouts sit on arbitrary in-progress PR
 *     branches; fetch-only never touches their working tree.
 *   - Logs `[sync HH:MM:SS] SYNC_FETCH: fetched=N errors=N`, matching the
 *     format the old process used, so nothing downstream that greps pm2 logs
 *     breaks.
 *
 * Intended to run once per tick from agent-repo-sync-loop.sh (60s tick); the
 * FALLBACK_INTERVAL_MS gate is what actually paces real git activity.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const QUEUE_FILE = process.env.QUEUE_FILE
  || '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/github-webhook-queue.jsonl';
const STATE_FILE = process.env.STATE_FILE
  || path.join(ROOT, 'db', 'agent-repo-sync.state.json');
const FALLBACK_INTERVAL_MS = Number(process.env.FALLBACK_INTERVAL_MS) || 30 * 60 * 1000; // 30min safety net
const WATCHED_REPOS = new Set(
  (process.env.WATCHED_REPOS || 'thiagown1/turbo_station').split(',').map((s) => s.trim()).filter(Boolean)
);

// Every per-agent checkout that should stay fetched. `git fetch` only updates
// remote-tracking refs — it never touches whatever branch/worktree state the
// owning agent currently has checked out.
const CHECKOUTS = [
  '/home/openclaw/.openclaw/workspace-coder/turbo_station',
  '/home/openclaw/.openclaw/workspace-scout/turbo_station',
  '/home/openclaw/.openclaw/workspace-secguard/turbo_station',
  '/home/openclaw/.openclaw/workspace-test-engineer/turbo_station',
  '/home/openclaw/.openclaw/workspace/turbo_station',
  '/home/openclaw/.openclaw/workspace-reuse-reviewer/repo',
  '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
  '/home/openclaw/.openclaw/workspace-support-turbo_station',
];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS (UTC)
  console.log(`[sync ${ts}] ${msg}`);
}

function statQueue() {
  try { return fs.statSync(QUEUE_FILE); } catch { return null; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// Returns true if a new `push` event for a watched repo appears in the queue
// since the last read. Always advances the persisted offset, so events for
// unwatched repos don't get re-scanned every tick.
function checkQueueForRelevantPush(state) {
  const stat = statQueue();
  if (!stat) return { found: false, state };

  if (!state.queueOffset) {
    // First run (or queue rotated) — fast-forward, don't backfill history.
    return { found: false, state: { ...state, queueOffset: { byteOffset: stat.size, inode: stat.ino } } };
  }

  const { byteOffset, inode } = state.queueOffset;
  if (inode !== stat.ino || byteOffset > stat.size) {
    // Rotated or truncated — reset to end.
    return { found: false, state: { ...state, queueOffset: { byteOffset: stat.size, inode: stat.ino } } };
  }
  if (byteOffset === stat.size) return { found: false, state };

  const fd = fs.openSync(QUEUE_FILE, 'r');
  let found = false;
  try {
    const bytesToRead = stat.size - byteOffset;
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, byteOffset);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    let partialLen = 0;
    if (!text.endsWith('\n')) partialLen = Buffer.byteLength(lines.pop() || '', 'utf8');
    else lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'push' && WATCHED_REPOS.has(event.repository)) {
        found = true;
      }
    }
    const consumed = (stat.size - byteOffset) - partialLen;
    return { found, state: { ...state, queueOffset: { byteOffset: byteOffset + consumed, inode: stat.ino } } };
  } finally {
    fs.closeSync(fd);
  }
}

function fetchAll() {
  let fetched = 0;
  let errors = 0;
  for (const dir of CHECKOUTS) {
    try {
      execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
      fetched++;
    } catch (err) {
      errors++;
      const detail = (err.stderr ? err.stderr.toString() : err.message || '').trim().split('\n')[0];
      log(`  ! ${dir}: ${detail}`);
    }
  }
  return { fetched, errors };
}

function main() {
  let state = readState() || { queueOffset: null, lastSyncAt: null };

  const { found, state: nextState } = checkQueueForRelevantPush(state);
  state = nextState;

  const sinceLastSync = state.lastSyncAt ? Date.now() - Date.parse(state.lastSyncAt) : Infinity;
  const dueForFallback = sinceLastSync >= FALLBACK_INTERVAL_MS;

  if (!found && !dueForFallback) {
    writeState(state);
    return;
  }

  const { fetched, errors } = fetchAll();
  state.lastSyncAt = new Date().toISOString();
  writeState(state);

  const label = found ? 'SYNC_FETCH' : 'SYNC_FETCH'; // reserved: distinguish push-triggered vs fallback if ever needed
  log(`${label}: fetched=${fetched} errors=${errors}${found ? ' (push-triggered)' : ' (fallback interval)'}`);
}

main();
