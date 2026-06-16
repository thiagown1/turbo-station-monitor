#!/usr/bin/env node
/**
 * Shadow backtest — Support Copilot
 *
 * Fills shadow_comparisons from REAL historical conversations instead of waiting
 * for new live traffic. For a sample of past turns (a customer message followed
 * by an operator reply), it generates what the bot WOULD have said for the
 * context up to that customer message and pairs it with the operator's ACTUAL
 * reply. Then the calibration dashboard's "Avaliar com IA" scores them.
 *
 * Read-only on real conversations: generation runs on a throwaway conv id, so it
 * never mutates real tags/status/sessions. Inserts only into shadow_comparisons.
 * Rows are marked model_name='backtest:<model>' to distinguish from live shadow.
 *
 * Usage:
 *   node scripts/backtest-shadow.cjs                 # 150 sampled turns, c3
 *   node scripts/backtest-shadow.cjs --limit 50 --concurrency 4
 *   node scripts/backtest-shadow.cjs --brand turbo_station --purge   # clear prior backtest rows first
 */
'use strict';

const { db, randomId, nowIso } = require('../lib/db');
const { generateSuggestion, deleteTestSessions } = require('../lib/copilot');

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const LIMIT = parseInt(opt('--limit', '150'), 10) || 150;
const CONCURRENCY = Math.max(1, parseInt(opt('--concurrency', '3'), 10) || 3);
const BRAND = opt('--brand', 'turbo_station');
const PURGE = has('--purge');

async function pool(items, limit, worker) {
  let next = 0; const out = new Array(items.length);
  async function run() { while (true) { const i = next++; if (i >= items.length) return; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// Sample operator replies (real, evolution) in 1:1 non-staff convs that have a
// preceding customer message. Random for representativeness.
function sampleTurns(n) {
  return db.prepare(`
    SELECT m.id AS reply_id, m.conversation_id, m.body AS operator_text, m.created_at AS reply_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.direction='outbound' AND m.source='evolution'
      AND c.channel='whatsapp' AND COALESCE(c.is_staff,0)=0
      AND c.brand_id = ?
      AND length(trim(m.body)) >= 3
      AND EXISTS (SELECT 1 FROM messages p WHERE p.conversation_id=m.conversation_id AND p.direction='inbound' AND p.created_at < m.created_at)
    ORDER BY RANDOM()
    LIMIT ?
  `).all(BRAND, n * 2); // oversample; we'll skip turns whose immediate predecessor isn't a customer msg
}

function contextBefore(convId, replyAt) {
  return db.prepare(`
    SELECT direction, source, body, created_at FROM messages
    WHERE conversation_id = ? AND created_at < ?
    ORDER BY created_at ASC
  `).all(convId, replyAt);
}

(async () => {
  if (PURGE) {
    const del = db.prepare("DELETE FROM shadow_comparisons WHERE model_name LIKE 'backtest:%'").run();
    console.log(`Purged ${del.changes} prior backtest rows.`);
  }
  const candidates = sampleTurns(LIMIT);
  // Keep only turns whose immediate predecessor is a customer message (clean turn).
  const turns = [];
  for (const t of candidates) {
    if (turns.length >= LIMIT) break;
    const ctx = contextBefore(t.conversation_id, t.reply_at);
    if (ctx.length === 0) continue;
    if (ctx[ctx.length - 1].direction !== 'inbound') continue; // last before reply must be the customer
    turns.push({ ...t, ctx });
  }
  console.log(`\n🕰️  Shadow backtest — ${turns.length} real turns (brand ${BRAND}, concurrency ${CONCURRENCY})\n`);

  let inserted = 0, skipped = 0, done = 0;
  await pool(turns, CONCURRENCY, async (t) => {
    const fakeId = randomId('bt');
    // Map the real messages into the shape generateSuggestion expects.
    const msgs = t.ctx.map((m, i) => ({
      id: `${fakeId}_${i}`,
      conversation_id: fakeId,
      direction: m.direction,
      source: m.source,
      body: m.body,
      created_at: m.created_at,
    }));
    const fakeConv = { id: fakeId, brand_id: BRAND, customer_phone: '+5561900000000', customer_name: 'backtest', status: 'open', created_at: nowIso(), channel: 'test' };
    let res = {};
    try {
      res = await generateSuggestion(fakeConv, msgs, { tags: [], forceFullPrompt: true }) || {};
    } catch (err) {
      res = { text: null, model: 'error', error: err.message };
    }
    done++;
    if (!res.text) { skipped++; process.stdout.write(`· [${done}/${turns.length}] skip (${res.model || 'no text'})\n`); return; }
    const now = nowIso();
    db.prepare(`INSERT INTO shadow_comparisons (id, conversation_id, brand_id, suggestion_id, suggestion_text, operator_text, model_name, suggestion_created_at, operator_replied_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      randomId('shadow'), t.conversation_id, BRAND, 'backtest', res.text, t.operator_text,
      `backtest:${res.model || 'unknown'}`, now, t.reply_at, now);
    inserted++;
    process.stdout.write(`✓ [${done}/${turns.length}] paired\n`);
    // session_context cleanup for the throwaway id
    try { db.prepare('DELETE FROM session_context WHERE conversation_id = ?').run(fakeId); } catch {}
    try { db.prepare('DELETE FROM conversations WHERE id = ?').run(fakeId); } catch {}
  });

  try { deleteTestSessions && deleteTestSessions(); } catch {}
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Backtest done: ${inserted} pairs inserted, ${skipped} skipped (NO_REPLY/error).`);
  console.log(`shadow_comparisons total now: ${db.prepare('SELECT count(*) c FROM shadow_comparisons').get().c}`);
  console.log(`Next: open /dashboard/support/calibration → "Avaliar com IA" to score them.`);
  process.exit(0);
})();
