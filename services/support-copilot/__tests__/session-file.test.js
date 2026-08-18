#!/usr/bin/env node
/**
 * Session JSONL memory-safety tests — Support Copilot (regression for issue #48)
 *
 * support-copilot was recycling on pm2's `max_memory_restart` because three code
 * paths read a whole agent session `.jsonl` into the heap. On the real 39 MB
 * "Notificações Turbo Station" session that peaked at 208 MB RSS in a bare node
 * process — past the 150 MB cap before the service's own ~90 MB is counted.
 *
 * These tests build an oversized session on disk and assert the helpers stay in
 * bounded memory. The guard is **peak RSS** — the same number pm2 samples for
 * `max_memory_restart` — so a regression to `readFileSync(...).split()` fails
 * here rather than in production. A CONTROL case runs the old approach to keep
 * the budget anchored to a real difference.
 *
 * Run: node services/support-copilot/__tests__/session-file.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  countSessionLines,
  readSessionTail,
  rewriteSessionTailWithout,
  sessionFileSize,
  needsRecompaction,
  SESSION_TAIL_MAX_BYTES,
} = require('../lib/session-file');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

async function run() {
  console.log('\n🧪 session-file (issue #48 — memory-safe session reads)\n');
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-session-'));
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Write a JSONL session of roughly `targetBytes`, mimicking the real shape
 * (one `{type:'message'}` envelope per line with a long content string).
 */
function writeSession(name, targetBytes) {
  const filePath = path.join(tmpRoot, name);
  const fd = fs.openSync(filePath, 'w');
  // Real alert payloads are emoji-heavy ("🔴 *Falha de temperatura*", "🏢", "⚡"),
  // which forces V8 to hold them as two-byte strings — that is why the live
  // 39MB session decoded into ~81MB of heap. An ASCII-only fixture would be
  // half as expensive and would understate the bug.
  const filler = ('🔴 Falha de temperatura — possível roubo de cabo ⚡ ').repeat(40);
  let written = 0;
  let i = 0;
  try {
    while (written < targetBytes) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const line = JSON.stringify({
        type: 'message',
        idx: i,
        message: { role, content: filler + ' #' + i },
      }) + '\n';
      fs.writeSync(fd, line);
      written += Buffer.byteLength(line);
      i++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { filePath, lineCount: i, bytes: written };
}

/**
 * Run a snippet in a fresh child process and report how far its **peak RSS**
 * rose above its own baseline.
 *
 * Peak RSS is the metric that actually matters here: it is precisely what pm2's
 * `max_memory_restart` samples, so a test on it maps 1:1 onto the production
 * failure. In-process heap sampling was tried first and is unusable — a
 * streaming loop's garbage inflates the peak, and `--max-old-space-size` does
 * not bound the large-object space where a 24MB decoded string lands, so a heap
 * cap never trips. `process.resourceUsage().maxRSS` is the OS high-water mark
 * and separates the two implementations by ~12x.
 *
 * The snippet must print `RESULT:<something>` on stdout; it runs with `report`
 * in scope, which stamps the peak and must be called when the work is done.
 *
 * @returns {{ ok: boolean, result: string, peakGrowthMB: number, stderr: string }}
 */
function measurePeakRss(snippet) {
  const scriptPath = path.join(tmpRoot, `rss-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(scriptPath, `
    'use strict';
    const __baseline = process.resourceUsage().maxRSS;
    const report = (result) => {
      const growthMB = (process.resourceUsage().maxRSS - __baseline) / 1024;
      console.log('RESULT:' + result);
      console.log('GROWTH:' + growthMB.toFixed(1));
    };
    ${snippet}
  `);
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 120_000 });
  const stdout = res.stdout || '';
  const result = (stdout.match(/^RESULT:(.*)$/m) || [, ''])[1].trim();
  const growth = parseFloat((stdout.match(/^GROWTH:(.*)$/m) || [, 'NaN'])[1]);
  return {
    ok: res.status === 0,
    result,
    peakGrowthMB: growth,
    stderr: (res.stderr || '').trim(),
  };
}

/**
 * Peak-RSS growth a memory-safe operation on the 24MB fixture may cost.
 *
 * Measured: streaming +5.5MB, whole-file read +67MB. 16MB sits well clear of
 * both, so the assertion is neither flaky nor trivially satisfiable.
 */
const SAFE_PEAK_GROWTH_MB = 16;

/** Path to lib/session-file.js, as a JS string literal for child snippets. */
const LIB = JSON.stringify(path.resolve(__dirname, '..', 'lib', 'session-file.js'));

const MB = 1024 * 1024;
// The overgrown session under test. Big enough that a whole-file read is
// unmistakable in the heap numbers, small enough to keep the suite fast.
const BIG = writeSession('big-session.jsonl', 24 * MB);
const SMALL = writeSession('small-session.jsonl', 64 * 1024);

// ─── countSessionLines ───────────────────────────────────────────────────────

test('countSessionLines counts every non-blank line', async () => {
  assert.equal(await countSessionLines(SMALL.filePath), SMALL.lineCount);
});

test('countSessionLines ignores blank lines and a missing trailing newline', async () => {
  const p = path.join(tmpRoot, 'blanks.jsonl');
  fs.writeFileSync(p, '{"a":1}\n\n\n{"b":2}\n   \n{"c":3}');
  assert.equal(await countSessionLines(p), 3);
});

test('countSessionLines returns 0 for a missing file instead of throwing', async () => {
  assert.equal(await countSessionLines(path.join(tmpRoot, 'nope.jsonl')), 0);
});

test('REGRESSION: countSessionLines reads a 24MB session in near-constant memory', () => {
  const r = measurePeakRss(`
    const { countSessionLines } = require(${LIB});
    countSessionLines(${JSON.stringify(BIG.filePath)})
      .then(n => report(n))
      .catch(e => { console.error(e); process.exit(1); });
  `);
  assert.ok(r.ok, `child failed: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.result, String(BIG.lineCount), 'streaming count must match the real line count');
  assert.ok(
    r.peakGrowthMB < SAFE_PEAK_GROWTH_MB,
    `peak RSS grew ${r.peakGrowthMB}MB on a 24MB session (budget ${SAFE_PEAK_GROWTH_MB}MB) — did this revert to readFileSync?`
  );
});

test('CONTROL: the old readFileSync+split approach costs multiples of the file size', () => {
  // Anchors the budget above to a real difference rather than a number that any
  // implementation would pass. This snippet is what routes/conversations.js
  // session-info used to run on the live 39MB session.
  const r = measurePeakRss(`
    const fs = require('fs');
    const n = fs.readFileSync(${JSON.stringify(BIG.filePath)}, 'utf8').split('\\n').filter(l => l.trim()).length;
    report(n);
  `);
  assert.ok(r.ok, `child failed: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.result, String(BIG.lineCount));
  assert.ok(
    r.peakGrowthMB > 2 * SAFE_PEAK_GROWTH_MB,
    `expected the whole-file read to cost far more than the ${SAFE_PEAK_GROWTH_MB}MB budget, ` +
    `but it only grew ${r.peakGrowthMB}MB — the budget is no longer a meaningful constraint`
  );
});

// ─── readSessionTail ─────────────────────────────────────────────────────────

test('readSessionTail returns every line untruncated for a small session', () => {
  const r = readSessionTail(SMALL.filePath);
  assert.equal(r.truncated, false);
  assert.equal(r.lines.length, SMALL.lineCount);
  assert.equal(r.totalBytes, SMALL.bytes);
});

test('readSessionTail caps the read at maxBytes on an oversized session', () => {
  const r = readSessionTail(BIG.filePath, { maxBytes: 1 * MB });
  assert.equal(r.truncated, true);
  assert.ok(r.readBytes <= 1 * MB, `read ${r.readBytes} bytes, expected <= 1MB`);
  assert.equal(r.totalBytes, BIG.bytes, 'totalBytes must still report the real size');
});

test('readSessionTail drops the partial leading line so every line parses', () => {
  const r = readSessionTail(BIG.filePath, { maxBytes: 1 * MB });
  assert.ok(r.lines.length > 0);
  for (const line of r.lines) {
    assert.doesNotThrow(() => JSON.parse(line), `tail yielded an unparseable line: ${line.slice(0, 80)}`);
  }
});

test('readSessionTail returns the END of the file, not the start', () => {
  const r = readSessionTail(BIG.filePath, { maxBytes: 1 * MB });
  const last = JSON.parse(r.lines[r.lines.length - 1]);
  assert.equal(last.idx, BIG.lineCount - 1, 'last tail entry must be the last line of the file');
});

test('REGRESSION: readSessionTail reads a 24MB session in near-constant memory', () => {
  const r = measurePeakRss(`
    const { readSessionTail } = require(${LIB});
    const res = readSessionTail(${JSON.stringify(BIG.filePath)});
    if (!res.truncated) { console.error('expected the 24MB session to be truncated'); process.exit(1); }
    report(res.totalBytes);
  `);
  assert.ok(r.ok, `child failed: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.result, String(BIG.bytes), 'totalBytes must report the real file size');
  assert.ok(
    r.peakGrowthMB < SAFE_PEAK_GROWTH_MB,
    `peak RSS grew ${r.peakGrowthMB}MB on a 24MB session (budget ${SAFE_PEAK_GROWTH_MB}MB) — is it reading the whole file?`
  );
});

test('readSessionTail default budget is the documented 2MiB', () => {
  assert.equal(SESSION_TAIL_MAX_BYTES, 2 * MB);
});

test('readSessionTail returns empty for a missing file instead of throwing', () => {
  const r = readSessionTail(path.join(tmpRoot, 'nope.jsonl'));
  assert.deepEqual(r.lines, []);
  assert.equal(r.totalBytes, 0);
});

// ─── rewriteSessionWithout ───────────────────────────────────────────────────

test('rewriteSessionTailWithout drops exactly the requested indices', () => {
  const p = path.join(tmpRoot, 'rewrite-small.jsonl');
  fs.writeFileSync(p, ['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}'].join('\n') + '\n');

  const res = rewriteSessionTailWithout(p, [1, 2]);
  assert.equal(res.dropped, 2);
  assert.equal(res.keptInTail, 2);

  const kept = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).i);
  assert.deepEqual(kept, [0, 3]);
});

test('rewriteSessionTailWithout is a no-op when nothing is dropped', () => {
  const p = path.join(tmpRoot, 'rewrite-noop.jsonl');
  const original = ['{"i":0}', '{"i":1}'].join('\n') + '\n';
  fs.writeFileSync(p, original);

  const res = rewriteSessionTailWithout(p, []);
  assert.equal(res.dropped, 0);
  assert.equal(res.keptInTail, 2);
  assert.equal(fs.readFileSync(p, 'utf8'), original, 'file must be left byte-identical');
});

test('rewriteSessionTailWithout leaves the untouched head of a big session intact', () => {
  // The whole point of the tail scoping: bytes before linesStartOffset are never
  // rewritten, so a 24MB session keeps its history byte-for-byte.
  const p = path.join(tmpRoot, 'rewrite-head-intact.jsonl');
  fs.copyFileSync(BIG.filePath, p);

  const tailBudget = 256 * 1024;
  const before = readSessionTail(p, { maxBytes: tailBudget });
  assert.ok(before.truncated, 'fixture must be larger than the tail budget');

  const headBefore = Buffer.alloc(before.linesStartOffset);
  let fd = fs.openSync(p, 'r');
  fs.readSync(fd, headBefore, 0, headBefore.length, 0);
  fs.closeSync(fd);

  const res = rewriteSessionTailWithout(p, [before.lines.length - 1], { maxBytes: tailBudget });
  assert.equal(res.dropped, 1);

  const headAfter = Buffer.alloc(before.linesStartOffset);
  fd = fs.openSync(p, 'r');
  fs.readSync(fd, headAfter, 0, headAfter.length, 0);
  fs.closeSync(fd);

  assert.ok(headBefore.equals(headAfter), 'bytes before the tail region must be untouched');
});

test('rewriteSessionTailWithout removes only the last entry of a big session', async () => {
  const p = path.join(tmpRoot, 'rewrite-last.jsonl');
  fs.copyFileSync(BIG.filePath, p);

  const tail = readSessionTail(p, { maxBytes: 256 * 1024 });
  const res = rewriteSessionTailWithout(p, [tail.lines.length - 1], { maxBytes: 256 * 1024 });

  assert.equal(res.dropped, 1);
  assert.equal(await countSessionLines(p), BIG.lineCount - 1);

  const after = readSessionTail(p, { maxBytes: 64 * 1024 });
  assert.equal(JSON.parse(after.lines[after.lines.length - 1]).idx, BIG.lineCount - 2);
});

test('rewriteSessionTailWithout leaves no temp file behind', () => {
  const p = path.join(tmpRoot, 'rewrite-tmp.jsonl');
  fs.writeFileSync(p, ['{"i":0}', '{"i":1}', '{"i":2}'].join('\n') + '\n');
  rewriteSessionTailWithout(p, [1]);

  const strays = fs.readdirSync(tmpRoot).filter(f => f.includes('.tmp'));
  assert.deepEqual(strays, [], `temp files left behind: ${strays.join(', ')}`);
});

test('REGRESSION: rewriteSessionTailWithout rewrites a 24MB session in bounded memory', async () => {
  // The old removeSuggestionFromSession did read -> split -> filter -> join,
  // i.e. ~4 live copies of the session. Measured 208MB RSS on the real 39MB
  // file, against a 150MB pm2 cap.
  const p = path.join(tmpRoot, 'rewrite-big.jsonl');
  fs.copyFileSync(BIG.filePath, p);

  const r = measurePeakRss(`
    const { readSessionTail, rewriteSessionTailWithout } = require(${LIB});
    const tail = readSessionTail(${JSON.stringify(p)});
    const res = rewriteSessionTailWithout(
      ${JSON.stringify(p)},
      [tail.lines.length - 2, tail.lines.length - 1]
    );
    report(res.dropped);
  `);
  assert.ok(r.ok, `child failed: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.result, '2');
  assert.ok(
    r.peakGrowthMB < SAFE_PEAK_GROWTH_MB,
    `peak RSS grew ${r.peakGrowthMB}MB on a 24MB session (budget ${SAFE_PEAK_GROWTH_MB}MB) — did the rewrite go back to join()?`
  );

  // The rewrite must be correct, not just cheap.
  assert.equal(await countSessionLines(p), BIG.lineCount - 2);
  const tail = readSessionTail(p, { maxBytes: 64 * 1024 });
  assert.equal(JSON.parse(tail.lines[tail.lines.length - 1]).idx, BIG.lineCount - 3);
});

// ─── recompaction threshold ──────────────────────────────────────────────────

test('sessionFileSize reports the real size and 0 when missing', () => {
  assert.equal(sessionFileSize(SMALL.filePath), SMALL.bytes);
  assert.equal(sessionFileSize(path.join(tmpRoot, 'nope.jsonl')), 0);
});

test('needsRecompaction is false for a healthy session', () => {
  assert.equal(needsRecompaction(SMALL.filePath), false);
});

test('REGRESSION: an already-compacted session that regrew past the threshold is eligible again', () => {
  // The old guard was `if (compacted_at) return`, which is why the always-active
  // alert feed reached 39MB after a single compaction and then became too large
  // for the agent to load at all.
  assert.equal(needsRecompaction(BIG.filePath, 8 * MB), true);
});

test('needsRecompaction returns false for a missing file', () => {
  assert.equal(needsRecompaction(path.join(tmpRoot, 'nope.jsonl')), false);
});

run();
