/**
 * atomic-json.js
 *
 * Crash/ENOSPC-safe JSON state persistence for the long-running services.
 *
 * WHY: `fs.writeFileSync(file, json)` TRUNCATES the target before writing. When
 * the disk is full the truncate succeeds and the write fails, leaving a 0-byte
 * file behind — the previous state is gone even though nothing was written.
 * The alert engine then boots, fails to parse it, and starts from an empty
 * state. That is exactly how the URGENTE group got re-paged for two already-
 * known cable thefts on 2026-09-06 (disk full 10:46 UTC → `ENOSPC` on save →
 * restart 18:28 UTC → `Unexpected end of JSON input` → two fresh 5x bursts),
 * and again on 2026-09-01 → 09-02.
 *
 * Write to a sibling temp file first and `rename()` over the target only after
 * the bytes are down: rename is atomic on the same filesystem, so a reader
 * either sees the whole old file or the whole new one, never a truncated one.
 */

'use strict';

const fs = require('fs');

/**
 * Serialize `value` and replace `filePath` atomically.
 * Throws on failure (callers already log + continue); the previous file
 * contents are left untouched when it does.
 */
function writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
    } catch (e) {
        // Never leave a half-written temp file lying around to be mistaken for
        // state (and to not waste the little disk space that is left).
        try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
        throw e;
    }
}

module.exports = { writeJsonAtomic };
