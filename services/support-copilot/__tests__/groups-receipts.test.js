#!/usr/bin/env node
/**
 * Partner-group receipts endpoint tests — Support Copilot
 *
 * Covers GET /api/support/groups/receipts (routes/groups.js), the endpoint the
 * Next.js confirm-partner-payments cron polls via partner-receipts.ts:
 *  - contract shape: { receipts: [{ amountCents, receiptRef, sourceMessageId, at }] }
 *  - partner link resolution (partnerId + brandId), 400/404 off-ramps
 *  - x-brand-id tenant guard (cross-brand reads as 404)
 *  - candidate filtering: inbound only, image/document media only, sinceHours window
 *  - extraction cache (receipt_extractions): cached ok rows are returned, cached
 *    no_receipt rows are not, uncached rows without OPENROUTER_API_KEY are left
 *    pending (not cached as an error) so a later configured run picks them up
 *
 * Also unit-tests parseAmountToCents (lib/receipt-extractor.js) in-process —
 * Brazilian ("4.639,32") and US ("4,639.32") formats must both round-trip.
 *
 * Runs the route in a child process against a throwaway DB path so this test
 * doesn't share the singleton `db` connection with the other test files.
 *
 * Run: node services/support-copilot/__tests__/groups-receipts.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function freshDbPath(tag) {
  return path.join(os.tmpdir(), `support-copilot-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

console.log('\n🧪 lib/receipt-extractor.js — parseAmountToCents\n');

const { parseAmountToCents } = require('../lib/receipt-extractor');

test('parses a JSON number', () => {
  assert.equal(parseAmountToCents(4639.32), 463932);
});
test('parses Brazilian format "4.639,32"', () => {
  assert.equal(parseAmountToCents('4.639,32'), 463932);
});
test('parses "R$ 10.421,75"', () => {
  assert.equal(parseAmountToCents('R$ 10.421,75'), 1042175);
});
test('parses US format "4,639.32"', () => {
  assert.equal(parseAmountToCents('4,639.32'), 463932);
});
test('parses plain "4639.32"', () => {
  assert.equal(parseAmountToCents('4639.32'), 463932);
});
test('parses decimal comma "4639,5"', () => {
  assert.equal(parseAmountToCents('4639,5'), 463950);
});
test('parses dot-as-thousands "4.639"', () => {
  assert.equal(parseAmountToCents('4.639'), 463900);
});
test('rejects garbage / negatives', () => {
  assert.equal(parseAmountToCents('abc'), null);
  assert.equal(parseAmountToCents(''), null);
  assert.equal(parseAmountToCents(null), null);
  assert.equal(parseAmountToCents(-5), null);
});

console.log('\n🧪 routes/groups.js — GET /receipts\n');

test('resolves the partner group, applies filters, and returns cached receipts in contract shape', () => {
  const dbPath = freshDbPath('receipts-route');

  try {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `
        // No live extraction in tests: without OPENROUTER_API_KEY the extractor
        // reports { status:'error', reason:'no_api_key' } and the route must
        // leave the message pending instead of caching a failure.
        delete process.env.OPENROUTER_API_KEY;

        const express = require('express');
        const supertest = require('supertest');
        const { db, nowIso } = require('./lib/db.js');

        const app = express();
        app.use(express.json());
        app.use('/', require('./routes/groups.js'));

        const now = Date.now();
        const iso = (msAgo) => new Date(now - msAgo).toISOString();
        const HOUR = 3600 * 1000;

        db.prepare(
          "INSERT INTO conversations (id, brand_id, channel, customer_phone, customer_name, status, created_at, updated_at) VALUES ('conv1', 'turbo_station', 'whatsapp-group', 'g1@g.us', 'Grupo Teste', 'open', ?, ?)"
        ).run(nowIso(), nowIso());
        db.prepare(
          "INSERT INTO group_partner_links (group_jid, conversation_id, brand_id, partner_id, partner_user_id, partner_name, allowed_tools, enabled, linked_at, updated_at) VALUES ('g1@g.us', 'conv1', 'turbo_station', 'p1', '', 'Parceiro Teste', '[]', 1, ?, ?)"
        ).run(nowIso(), nowIso());

        const insMsg = db.prepare(
          "INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, external_message_id, media_json, created_at) VALUES (?, 'conv1', 'turbo_station', ?, 'evolution', ?, ?, ?, ?)"
        );
        const media = (type, ext, mime) => JSON.stringify({ media_type: type, mimetype: mime, url: '/api/support/media/x.' + ext, filename: null, caption: null });

        // m1: inbound image with a cached OK extraction → returned
        insMsg.run('m1', 'inbound', '[Y]: [Imagem]', 'WA1', media('image', 'jpg', 'image/jpeg'), iso(2 * HOUR));
        // m2: inbound image cached as no_receipt → not returned
        insMsg.run('m2', 'inbound', '[Y]: [Imagem]', 'WA2', media('image', 'jpg', 'image/jpeg'), iso(3 * HOUR));
        // m3: OUTBOUND pdf with a cached OK row → excluded by direction filter
        insMsg.run('m3', 'outbound', 'Relatório', 'WA3', media('document', 'pdf', 'application/pdf'), iso(4 * HOUR));
        // m4: inbound pdf cached OK but 10 days old → excluded by default window,
        //     included when sinceHours is widened
        insMsg.run('m4', 'inbound', '[Y]: [Documento]', 'WA4', media('document', 'pdf', 'application/pdf'), iso(240 * HOUR));
        // m5: inbound audio → excluded by media type
        insMsg.run('m5', 'inbound', '[Y]: [Áudio]', 'WA5', media('audio', 'ogg', 'audio/ogg'), iso(2 * HOUR));
        // m6: inbound image, no cache → pending (no key), never an error row
        insMsg.run('m6', 'inbound', '[Y]: [Imagem]', 'WA6', media('image', 'jpg', 'image/jpeg'), iso(1 * HOUR));

        const insCache = db.prepare(
          "INSERT INTO receipt_extractions (message_id, conversation_id, status, amount_cents, receipt_ref, model, attempts, extracted_at) VALUES (?, 'conv1', ?, ?, ?, 'test-model', 1, ?)"
        );
        insCache.run('m1', 'ok', 463932, 'E60701TEST', nowIso());
        insCache.run('m2', 'no_receipt', null, null, nowIso());
        insCache.run('m3', 'ok', 999, 'EOUTBOUND', nowIso());
        insCache.run('m4', 'ok', 1042175, 'EOLD', nowIso());

        (async () => {
          // 400 without partnerId
          const noPartner = await supertest(app).get('/receipts');
          if (noPartner.status !== 400) throw new Error('expected 400 without partnerId, got ' + noPartner.status);

          // 404 for a partner with no link
          const unknown = await supertest(app).get('/receipts?partnerId=nobody');
          if (unknown.status !== 404) throw new Error('expected 404 for unlinked partner, got ' + unknown.status);

          // 404 for a cross-brand x-brand-id (tenant guard)
          const crossBrand = await supertest(app).get('/receipts?partnerId=p1&brandId=turbo_station').set('x-brand-id', 'other_brand');
          if (crossBrand.status !== 404) throw new Error('expected 404 for cross-brand header, got ' + crossBrand.status);

          // Default window: only m1 comes back, m6 stays pending
          const main = await supertest(app).get('/receipts?partnerId=p1&brandId=turbo_station').set('x-brand-id', 'turbo_station');
          if (main.status !== 200) throw new Error('expected 200, got ' + main.status + ': ' + JSON.stringify(main.body));
          const receipts = main.body.receipts;
          if (!Array.isArray(receipts) || receipts.length !== 1) throw new Error('expected exactly 1 receipt, got ' + JSON.stringify(main.body));
          const r = receipts[0];
          if (r.amountCents !== 463932) throw new Error('wrong amountCents: ' + JSON.stringify(r));
          if (r.receiptRef !== 'E60701TEST') throw new Error('wrong receiptRef: ' + JSON.stringify(r));
          if (r.sourceMessageId !== 'WA1') throw new Error('sourceMessageId must be the WhatsApp external id: ' + JSON.stringify(r));
          if (!r.at) throw new Error('missing at timestamp: ' + JSON.stringify(r));
          if (main.body.pendingExtraction !== 1) throw new Error('m6 should be pending (no api key): ' + JSON.stringify(main.body));

          // The no-key miss must NOT have been cached as an attempt
          const m6cache = db.prepare('SELECT * FROM receipt_extractions WHERE message_id = ?').get('m6');
          if (m6cache) throw new Error('no_api_key result must not be cached: ' + JSON.stringify(m6cache));

          // Widened window picks up the old m4 pdf too
          const wide = await supertest(app).get('/receipts?partnerId=p1&brandId=turbo_station&sinceHours=480');
          if (wide.status !== 200) throw new Error('expected 200 on widened window, got ' + wide.status);
          const amounts = wide.body.receipts.map((x) => x.amountCents).sort((a, b) => a - b);
          if (JSON.stringify(amounts) !== JSON.stringify([463932, 1042175])) {
            throw new Error('widened window expected both receipts, got ' + JSON.stringify(wide.body.receipts));
          }

          console.log('receipts-route-ok');
        })().catch((err) => { console.error(err.message); process.exit(1); });
        `,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, SUPPORT_COPILOT_DB_PATH: dbPath },
        encoding: 'utf8',
      }
    );
    assert.ok(output.includes('receipts-route-ok'), 'child should reach the success marker; output: ' + output.slice(-500));
  } finally {
    cleanup(dbPath);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
