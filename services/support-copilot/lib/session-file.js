/**
 * Session JSONL helpers — Support Copilot
 *
 * The OpenClaw agent keeps one `.jsonl` transcript per conversation under
 * `$OPENCLAW_HOME/agents/<agentId>/sessions/<sessionId>.jsonl`. Those files are
 * append-only and grow without bound while a conversation stays active — the
 * "Notificações Turbo Station" alert feed reached **39 MB / 17k lines** before
 * anyone noticed (issue #48).
 *
 * Reading such a file with `readFileSync(p, 'utf8').split('\n')` costs far more
 * than the file size: the decoded string, the line array and any `join()` of it
 * are all live at once. Measured on the real 39 MB session, in a bare node
 * process with no service loaded:
 *
 *   baseline                    rss  41 MB
 *   after readFileSync utf8     rss 121 MB
 *   after split + filter        rss 129 MB
 *   after join (rewrite)        rss 208 MB   <-- pm2 cap was 150 MB
 *
 * On top of support-copilot's own ~90 MB working set, a single request touching
 * that session exceeded `max_memory_restart` and pm2 killed the process. That is
 * what produced the restart bursts in issue #48 — a transient spike proportional
 * to the session size, not a slow leak.
 *
 * Everything here therefore works in bounded memory: byte-level line counting,
 * tail-only reads, and a tail-scoped rewrite. No helper ever materialises a
 * whole session, and none of them costs more as the session grows. Re-measured
 * against that same 39 MB file: tail read +9.5 MB, tail read + full line count
 * +16.2 MB peak RSS, together, in one process.
 *
 * @module lib/session-file
 */

'use strict';

const fs = require('fs');

/**
 * Bytes of a session file we are willing to hold in memory at once.
 *
 * 2 MiB keeps the worst-case decoded string + line array well inside the
 * headroom left by the pm2 cap, while still covering the tail of any realistic
 * conversation (the 39 MB alert session averages ~2.3 KB/line, so 2 MiB is
 * roughly the last 900 entries).
 */
const SESSION_TAIL_MAX_BYTES = parseInt(process.env.SUPPORT_SESSION_TAIL_MAX_BYTES || '', 10) || 2 * 1024 * 1024;

/**
 * Size at which a session is considered overgrown and eligible for another
 * compaction pass even though it was already compacted once.
 *
 * 8 MiB is ~4x a healthy compacted session and still small enough that the
 * OpenClaw agent child can load it — past roughly 30 MB the agent fails outright
 * ("Failed to inject into session ..."), which is how the alert session got
 * stuck: too big to compact *because* it was too big to load.
 */
const SESSION_RECOMPACT_BYTES = parseInt(process.env.SUPPORT_SESSION_RECOMPACT_BYTES || '', 10) || 8 * 1024 * 1024;

/** Read buffer for the byte-level line scan. One of these exists at a time. */
const COUNT_CHUNK_BYTES = 256 * 1024;

/**
 * Count non-blank lines in a JSONL file without loading it.
 *
 * Streaming replacement for `readFileSync(p, 'utf8').split('\n').filter(...)`.
 *
 * Scans raw bytes rather than going through `readline`: readline decodes every
 * line into a JS string, which on the real 39MB session still cost +30MB peak
 * RSS. Counting newline bytes and tracking whether the current line had any
 * non-whitespace holds one 256KB buffer regardless of file size.
 *
 * Blank-line detection is byte-wise (space/tab/CR/LF), which matches the
 * `line.trim()` this replaced for JSONL — every non-blank line starts with `{`.
 *
 * @param {string} filePath
 * @returns {Promise<number>} 0 when the file is missing or unreadable
 */
async function countSessionLines(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return 0;
  }

  const buf = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
  let count = 0;
  let lineHasContent = false;

  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, COUNT_CHUNK_BYTES, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        const b = buf[i];
        if (b === 0x0a) { // '\n'
          if (lineHasContent) count++;
          lineHasContent = false;
        } else if (b !== 0x20 && b !== 0x09 && b !== 0x0d) { // not space/tab/CR
          lineHasContent = true;
        }
      }
    }
  } catch {
    // Fall through with whatever was counted so far.
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  // A final line with no trailing newline still counts.
  if (lineHasContent) count++;
  return count;
}

/**
 * Read at most the last `maxBytes` of a session file and return its whole lines.
 *
 * When the file is larger than the budget the read starts mid-file, so the first
 * (partial) line is dropped to avoid handing back a truncated JSON fragment.
 *
 * `linesStartOffset` is the absolute byte offset at which the first returned
 * line begins, which lets a caller rewrite just this region (see
 * `rewriteSessionTailWithout`).
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ lines: string[], truncated: boolean, totalBytes: number, readBytes: number, linesStartOffset: number }}
 */
function readSessionTail(filePath, opts = {}) {
  const maxBytes = opts.maxBytes || SESSION_TAIL_MAX_BYTES;
  const empty = { lines: [], truncated: false, totalBytes: 0, readBytes: 0, linesStartOffset: 0 };
  if (!fs.existsSync(filePath)) return empty;

  let totalBytes;
  try {
    totalBytes = fs.statSync(filePath).size;
  } catch {
    return empty;
  }
  if (totalBytes === 0) return empty;

  const truncated = totalBytes > maxBytes;
  const start = truncated ? totalBytes - maxBytes : 0;
  const length = totalBytes - start;

  const buf = Buffer.allocUnsafe(length);
  let fd;
  let bytesRead = 0;
  try {
    fd = fs.openSync(filePath, 'r');
    bytesRead = fs.readSync(fd, buf, 0, length, start);
  } catch {
    return empty;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }

  // Mid-file start: the leading fragment is not a whole JSON line, so skip past
  // the first newline and record where the first whole line actually begins.
  let offsetInBuf = 0;
  if (truncated) {
    const nl = buf.indexOf(0x0a, 0); // '\n'
    offsetInBuf = nl === -1 ? bytesRead : nl + 1;
  }
  const linesStartOffset = start + offsetInBuf;

  const lines = buf.toString('utf8', offsetInBuf, bytesRead).split('\n').filter(l => l.trim());

  return { lines, truncated, totalBytes, readBytes: bytesRead, linesStartOffset };
}

/**
 * Drop lines from the **tail** of a JSONL session, leaving the rest untouched.
 *
 * `dropTailIndices` are indices into the array returned by `readSessionTail`,
 * not into the whole file. Only the tail region is rewritten: the file is
 * truncated at `linesStartOffset` and the kept tail lines are appended back, so
 * cost is bounded by the tail budget no matter how large the session is.
 *
 * A whole-file streaming rewrite was tried first and rejected: it does avoid
 * holding the file, but decoding 24MB of two-byte strings still pushed peak RSS
 * up ~46MB in garbage alone, and pm2 kills on the RSS high-water mark
 * regardless of whether the bytes are live or collectable.
 *
 * This is enough for the only caller, `removeSuggestionFromSession`, which
 * removes the trailing user+assistant pair.
 *
 * @param {string} filePath
 * @param {Iterable<number>} dropTailIndices - indices into the tail lines
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ dropped: number, keptInTail: number, truncated: boolean }}
 */
function rewriteSessionTailWithout(filePath, dropTailIndices, opts = {}) {
  const drop = new Set(dropTailIndices);
  const tail = readSessionTail(filePath, opts);
  if (drop.size === 0 || tail.lines.length === 0) {
    return { dropped: 0, keptInTail: tail.lines.length, truncated: tail.truncated };
  }

  const kept = tail.lines.filter((_, i) => !drop.has(i));
  const dropped = tail.lines.length - kept.length;
  if (dropped === 0) {
    return { dropped: 0, keptInTail: kept.length, truncated: tail.truncated };
  }

  let fd;
  try {
    fd = fs.openSync(filePath, 'r+');
    fs.ftruncateSync(fd, tail.linesStartOffset);
    // Written line by line rather than via `kept.join('\n')`: joining the tail
    // would materialise another full copy of it, which measured ~17MB peak RSS
    // against a 2MiB tail. Incremental writes keep the peak at roughly the tail
    // buffer itself.
    let offset = tail.linesStartOffset;
    for (const line of kept) {
      offset += fs.writeSync(fd, line + '\n', offset, 'utf8');
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }

  return { dropped, keptInTail: kept.length, truncated: tail.truncated };
}

/**
 * Byte size of a session file, 0 when missing.
 * @param {string} filePath
 * @returns {number}
 */
function sessionFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Whether an already-compacted session has regrown enough to compact again.
 *
 * The old guard was "compacted once, never again", which let the always-active
 * alert feed grow to 39 MB after its single compaction (issue #48).
 *
 * @param {string} filePath
 * @param {number} [threshold]
 * @returns {boolean}
 */
function needsRecompaction(filePath, threshold = SESSION_RECOMPACT_BYTES) {
  return sessionFileSize(filePath) > threshold;
}

module.exports = {
  SESSION_TAIL_MAX_BYTES,
  SESSION_RECOMPACT_BYTES,
  countSessionLines,
  readSessionTail,
  rewriteSessionTailWithout,
  sessionFileSize,
  needsRecompaction,
};
