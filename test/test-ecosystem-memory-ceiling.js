#!/usr/bin/env node
/**
 * Memory-ceiling invariants for ecosystem.config.js (2026-08-18).
 *
 * pm2 kills a process the moment it crosses `max_memory_restart`. Two ways that
 * bites us, both seen in production:
 *
 *  - Ceiling too close to the working set. alert-engine sat at ~90MB steady
 *    against a 100M ceiling and recycled 8 times in 40 minutes. A recycle
 *    mid-burst silently drops the URGENTE cable-theft messages still queued,
 *    because the burst is fire-and-forget in-process.
 *  - No ceiling at all. A leaking service then takes the whole box down instead
 *    of just itself, and the VPS also runs the staging OCPP server.
 *
 * These checks lock the shape, not any single number: every app declares a
 * parseable ceiling, and no ceiling is set so low that it cannot hold a Node
 * process's own baseline.
 */

const assert = require('assert');
const path = require('path');

const config = require(path.join(__dirname, '..', 'ecosystem.config.js'));

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failures++;
        console.error(`  ❌ ${name}: ${e.message}`);
    }
}

console.log('🧪 ecosystem.config.js memory ceilings\n');

/** '256M' → 256, '1G' → 1024. Returns null for anything unparseable. */
function ceilingToMb(value) {
    const m = /^(\d+(?:\.\d+)?)\s*([KMG])B?$/i.exec(String(value || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2].toUpperCase();
    if (unit === 'K') return n / 1024;
    if (unit === 'G') return n * 1024;
    return n;
}

check('config exposes an apps array', () => {
    assert.ok(Array.isArray(config.apps), 'apps must be an array');
    assert.ok(config.apps.length > 0, 'apps must not be empty');
});

check('every app declares max_memory_restart', () => {
    const missing = config.apps
        .filter(a => a.max_memory_restart == null)
        .map(a => a.name);
    assert.strictEqual(
        missing.length, 0,
        `sem teto de memória: ${missing.join(', ')} — um serviço que vaza sem teto derruba a caixa inteira`
    );
});

check('every ceiling parses to a positive size', () => {
    const bad = config.apps
        .filter(a => !(ceilingToMb(a.max_memory_restart) > 0))
        .map(a => `${a.name}=${a.max_memory_restart}`);
    assert.strictEqual(bad.length, 0, `teto ilegível: ${bad.join(', ')}`);
});

check('no ceiling below a bare Node baseline (48MB)', () => {
    // Node itself plus a couple of requires already sits near 40MB; a ceiling
    // under that guarantees a boot loop rather than protection.
    const tooLow = config.apps
        .filter(a => ceilingToMb(a.max_memory_restart) < 48)
        .map(a => `${a.name}=${a.max_memory_restart}`);
    assert.strictEqual(tooLow.length, 0, `teto abaixo do baseline do Node: ${tooLow.join(', ')}`);
});

check('alert-engine has headroom over its measured ~90MB working set', () => {
    // Regression for the 2026-08-18 recycling: the engine holds four SQLite DBs
    // open and measured ~90MB steady. Anything under 2x that is back to
    // recycling on routine spikes.
    const engine = config.apps.find(a => a.name === 'alert-engine');
    assert.ok(engine, 'alert-engine deve existir no ecosystem');
    const mb = ceilingToMb(engine.max_memory_restart);
    assert.ok(
        mb >= 180,
        `alert-engine com teto de ${engine.max_memory_restart}: working set medido é ~90MB, precisa de pelo menos 2x`
    );
});

check('ceiling parser handles the units pm2 accepts', () => {
    assert.strictEqual(ceilingToMb('100M'), 100);
    assert.strictEqual(ceilingToMb('256M'), 256);
    assert.strictEqual(ceilingToMb('1G'), 1024);
    assert.strictEqual(ceilingToMb('512K'), 0.5);
    assert.strictEqual(ceilingToMb('nonsense'), null);
    assert.strictEqual(ceilingToMb(undefined), null);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
