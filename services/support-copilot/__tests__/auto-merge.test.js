#!/usr/bin/env node
/**
 * Auto-Merge Logic Tests — Support Copilot
 *
 * Tests the mergeConversations() function and the findDuplicateConv statement
 * using an in-memory SQLite database that mirrors the production schema.
 *
 * Run: node services/support-copilot/__tests__/auto-merge.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// ─── In-memory DB setup (mirrors production schema from lib/db.js) ──────────

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_user_id TEXT,
      external_conversation_id TEXT,
      customer_phone TEXT,
      customer_name TEXT,
      phone_aliases TEXT,
      profile_pic_url TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_agent_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags TEXT,
      is_staff INTEGER DEFAULT 0,
      escalated_at TEXT DEFAULT NULL,
      escalated_to TEXT DEFAULT NULL,
      last_message_at TEXT,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      source TEXT NOT NULL,
      body TEXT NOT NULL,
      author_id TEXT,
      external_message_id TEXT,
      media_json TEXT,
      delivery_status TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE suggestions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      suggestion_text TEXT NOT NULL,
      model_name TEXT,
      edited_text TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT
    );

    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      conversation_id TEXT,
      action TEXT NOT NULL,
      actor_user_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE session_context (
      conversation_id TEXT PRIMARY KEY,
      last_msg_index INTEGER NOT NULL DEFAULT 0,
      context_hash TEXT,
      last_sent_at TEXT,
      full_context_sent INTEGER NOT NULL DEFAULT 0,
      compacted_at TEXT DEFAULT NULL,
      compaction_summary TEXT DEFAULT NULL
    );

    CREATE INDEX idx_conv_phone ON conversations (customer_phone);
  `);

  return db;
}

// ─── Build stmts and helper functions (mirror lib/db.js exports) ────────────

function buildModule(db) {
  function nowIso() { return new Date().toISOString(); }
  function randomId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  const stmts = {
    getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    countMessages: db.prepare('SELECT COUNT(*) as total FROM messages WHERE conversation_id = ?'),
    findDuplicateConv: db.prepare(
      `SELECT * FROM conversations
       WHERE brand_id = ? AND channel = 'whatsapp' AND id != ?
       AND (customer_phone = ? OR (',' || phone_aliases || ',') LIKE ('%,' || ? || ',%'))
       LIMIT 1`
    ),
    findConvByPhoneOrAlias: db.prepare(
      `SELECT * FROM conversations
       WHERE brand_id = ? AND channel = 'whatsapp'
       AND (customer_phone = ? OR (',' || phone_aliases || ',') LIKE ('%,' || ? || ',%'))
       LIMIT 1`
    ),
  };

  function mergeConversations(targetId, sourceId) {
    const target = stmts.getConversation.get(targetId);
    const source = stmts.getConversation.get(sourceId);
    if (!target || !source) return { merged: false, targetId, sourceId, reason: 'not_found' };
    if (target.id === source.id) return { merged: false, targetId, sourceId, reason: 'same_conversation' };

    const now = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?')
        .run(target.id, source.id);
      db.prepare('UPDATE suggestions SET conversation_id = ? WHERE conversation_id = ?')
        .run(target.id, source.id);
      db.prepare('UPDATE audit_log SET conversation_id = ? WHERE conversation_id = ?')
        .run(target.id, source.id);
      if (source.customer_phone && !target.customer_phone) {
        db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
          .run(source.customer_phone, target.id);
      }
      if (source.customer_name && !target.customer_name) {
        db.prepare('UPDATE conversations SET customer_name = ? WHERE id = ?')
          .run(source.customer_name, target.id);
      }
      if (source.profile_pic_url && !target.profile_pic_url) {
        db.prepare('UPDATE conversations SET profile_pic_url = ? WHERE id = ?')
          .run(source.profile_pic_url, target.id);
      }
      const allAliases = new Set();
      if (target.phone_aliases) target.phone_aliases.split(',').forEach(a => allAliases.add(a));
      if (source.phone_aliases) source.phone_aliases.split(',').forEach(a => allAliases.add(a));
      if (source.customer_phone) allAliases.add(source.customer_phone);
      if (target.customer_phone) allAliases.add(target.customer_phone);
      const primaryPhone = target.customer_phone || source.customer_phone;
      if (primaryPhone) allAliases.delete(primaryPhone);
      const mergedAliases = [...allAliases].filter(Boolean).join(',') || null;
      db.prepare('UPDATE conversations SET phone_aliases = ?, updated_at = ? WHERE id = ?')
        .run(mergedAliases, now, target.id);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(source.id);
      db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(randomId('audit'), target.brand_id, target.id, 'support.auto_merge', null, JSON.stringify({ merged_from: source.id, source_phone: source.customer_phone, source_aliases: source.phone_aliases }), now);
    })();

    return { merged: true, targetId: target.id, sourceId: source.id };
  }

  return { db, stmts, nowIso, randomId, mergeConversations };
}

// ─── Test helpers ───────────────────────────────────────────────────────────

function insertConv(db, id, brandId, phone, name, aliases) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations (id, brand_id, channel, customer_phone, customer_name, phone_aliases, status, priority, unread_count, created_at, updated_at)
    VALUES (?, ?, 'whatsapp', ?, ?, ?, 'open', 'normal', 0, ?, ?)
  `).run(id, brandId, phone || null, name || null, aliases || null, now, now);
}

function insertMsg(db, id, convId, brandId, body) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, created_at)
    VALUES (?, ?, ?, 'inbound', 'webhook', ?, ?)
  `).run(id, convId, brandId, body, now);
}

function insertSuggestion(db, id, convId, brandId, text) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO suggestions (id, conversation_id, brand_id, suggestion_text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, convId, brandId, text, now, now);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

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

console.log('\n🧪 mergeConversations() — unit tests\n');

// ─── 1. Basic merge: source deleted, target kept ────────────────────────────
test('basic merge deletes source and keeps target', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', 'Daniel', null);
  insertConv(db, 'conv-b', 'brand1', null, null, '9771352613108');
  insertMsg(db, 'msg1', 'conv-a', 'brand1', 'hello from A');
  insertMsg(db, 'msg2', 'conv-b', 'brand1', 'hello from B');

  const result = mod.mergeConversations('conv-a', 'conv-b');
  assert.ok(result.merged, 'should have merged');

  // Source deleted
  assert.equal(mod.stmts.getConversation.get('conv-b'), undefined, 'source conv should be deleted');

  // Target kept
  const target = mod.stmts.getConversation.get('conv-a');
  assert.ok(target, 'target conv should still exist');

  // Messages moved
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all('conv-a');
  assert.equal(msgs.length, 2, 'both messages should be on target');
});

// ─── 2. Phone backfill during merge ─────────────────────────────────────────
test('merging LID-only conv into phone conv preserves phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-phone', 'brand1', '556599421507', 'Daniel', null);
  insertConv(db, 'conv-lid', 'brand1', null, null, '9771352613108');

  mod.mergeConversations('conv-phone', 'conv-lid');
  const target = mod.stmts.getConversation.get('conv-phone');

  assert.equal(target.customer_phone, '556599421507', 'phone should be preserved');
  assert.ok(target.phone_aliases?.includes('9771352613108'), 'LID should be in aliases');
});

// ─── 3. Phone backfill when target has no phone ─────────────────────────────
test('merging phone conv into LID-only conv backfills phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-lid', 'brand1', null, null, '9771352613108');
  insertConv(db, 'conv-phone', 'brand1', '556599421507', 'Daniel', null);

  mod.mergeConversations('conv-lid', 'conv-phone');
  const target = mod.stmts.getConversation.get('conv-lid');

  assert.equal(target.customer_phone, '556599421507', 'target should get phone from source');
});

// ─── 4. Name backfill ───────────────────────────────────────────────────────
test('merge backfills customer_name when target has none', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', null, 'Daniel V.', '9771352613108');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');

  assert.equal(target.customer_name, 'Daniel V.', 'name should be backfilled');
});

// ─── 5. Name preserved when target already has one ──────────────────────────
test('merge does NOT overwrite existing customer_name', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', 'Original Name', null);
  insertConv(db, 'conv-b', 'brand1', null, 'Other Name', '9771352613108');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');

  assert.equal(target.customer_name, 'Original Name', 'name should not be overwritten');
});

// ─── 6. Same-conversation guard ─────────────────────────────────────────────
test('merging a conversation into itself is a no-op', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', 'Daniel', null);

  const result = mod.mergeConversations('conv-a', 'conv-a');
  assert.equal(result.merged, false, 'should not merge');
  assert.equal(result.reason, 'same_conversation');
});

// ─── 7. Non-existent conversation guard ─────────────────────────────────────
test('merging non-existent conversation fails gracefully', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', 'Daniel', null);

  const result = mod.mergeConversations('conv-a', 'conv-nonexistent');
  assert.equal(result.merged, false, 'should not merge');
  assert.equal(result.reason, 'not_found');
});

// ─── 8. Suggestions are moved on merge ──────────────────────────────────────
test('suggestions are moved from source to target', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', null, null, '9771352613108');
  insertSuggestion(db, 'sug1', 'conv-b', 'brand1', 'Try X');

  mod.mergeConversations('conv-a', 'conv-b');

  const sugs = db.prepare('SELECT * FROM suggestions WHERE conversation_id = ?').all('conv-a');
  assert.equal(sugs.length, 1, 'suggestion should be moved to target');
  assert.equal(sugs[0].id, 'sug1');
});

// ─── 9. Audit log records the merge ─────────────────────────────────────────
test('audit log entry is created for auto_merge', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', null, null, '9771352613108');

  mod.mergeConversations('conv-a', 'conv-b');

  const logs = db.prepare("SELECT * FROM audit_log WHERE action = 'support.auto_merge'").all();
  assert.equal(logs.length, 1, 'should have exactly one auto_merge audit entry');
  const meta = JSON.parse(logs[0].metadata_json);
  assert.equal(meta.merged_from, 'conv-b');
});

// ─── 10. Aliases are properly combined ──────────────────────────────────────
test('merge combines aliases from both conversations without duplicates', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, '111111,222222');
  insertConv(db, 'conv-b', 'brand1', null, null, '222222,333333');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');
  const aliases = target.phone_aliases ? target.phone_aliases.split(',').sort() : [];

  assert.ok(aliases.includes('111111'), 'should include alias from target');
  assert.ok(aliases.includes('222222'), 'should include shared alias');
  assert.ok(aliases.includes('333333'), 'should include alias from source');
  // primary phone should NOT be in aliases
  assert.ok(!aliases.includes('556599421507'), 'primary phone should not be duplicated in aliases');
});

// ─── 11. Profile pic is preserved ───────────────────────────────────────────
test('merge backfills profile_pic_url when target has none', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  db.prepare('UPDATE conversations SET profile_pic_url = ? WHERE id = ?')
    .run('https://example.com/pic.jpg', 'conv-a');
  insertConv(db, 'conv-b', 'brand1', null, null, '9771352613108');

  // Merge B into A — A already has pic, should keep it
  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');
  assert.equal(target.profile_pic_url, 'https://example.com/pic.jpg');
});

test('merge gets profile_pic_url from source when target has none', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', null, null, '9771352613108');
  db.prepare('UPDATE conversations SET profile_pic_url = ? WHERE id = ?')
    .run('https://example.com/pic2.jpg', 'conv-b');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');
  assert.equal(target.profile_pic_url, 'https://example.com/pic2.jpg');
});

console.log('\n🧪 findDuplicateConv — prepared statement tests\n');

// ─── 12. findDuplicateConv finds by phone ───────────────────────────────────
test('findDuplicateConv finds conv with matching customer_phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', '556599421507', null, null);

  const dup = mod.stmts.findDuplicateConv.get('brand1', 'conv-a', '556599421507', '556599421507');
  assert.ok(dup, 'should find duplicate');
  assert.equal(dup.id, 'conv-b');
});

// ─── 13. findDuplicateConv finds by alias ───────────────────────────────────
test('findDuplicateConv finds conv with matching alias', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', null, null, '556599421507');

  const dup = mod.stmts.findDuplicateConv.get('brand1', 'conv-a', '556599421507', '556599421507');
  assert.ok(dup, 'should find duplicate via alias');
  assert.equal(dup.id, 'conv-b');
});

// ─── 14. findDuplicateConv excludes self ────────────────────────────────────
test('findDuplicateConv does not return self', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);

  const dup = mod.stmts.findDuplicateConv.get('brand1', 'conv-a', '556599421507', '556599421507');
  assert.equal(dup, undefined, 'should not find self');
});

// ─── 15. findDuplicateConv respects brand isolation ─────────────────────────
test('findDuplicateConv does not cross brands', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand2', '556599421507', null, null);

  const dup = mod.stmts.findDuplicateConv.get('brand1', 'conv-a', '556599421507', '556599421507');
  assert.equal(dup, undefined, 'should not find conv from different brand');
});

// ─── 16. findDuplicateConv returns nothing when no duplicate ────────────────
test('findDuplicateConv returns undefined when no duplicate exists', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'brand1', '556599421507', null, null);
  insertConv(db, 'conv-b', 'brand1', '5511999887766', null, null);

  const dup = mod.stmts.findDuplicateConv.get('brand1', 'conv-a', '556599421507', '556599421507');
  assert.equal(dup, undefined, 'should not find unrelated conv');
});

console.log('\n🧪 Auto-merge integration — simulated ingest flow\n');

// ─── 17. Backfill auto-merge scenario ───────────────────────────────────────
test('backfill triggers auto-merge when duplicate phone conv exists', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  // Scenario: Conv A exists with real phone. Customer sends via LID → Conv B created.
  // Later, we get real phone for Conv B (backfill) → detect Conv A as duplicate → merge.
  insertConv(db, 'conv-phone', 'brand1', '556599421507', 'Daniel', null);
  insertMsg(db, 'msg-old', 'conv-phone', 'brand1', 'old message');
  insertConv(db, 'conv-lid', 'brand1', null, null, '9771352613108');
  insertMsg(db, 'msg-new', 'conv-lid', 'brand1', 'new via LID');

  // Simulate backfill + auto-merge (what ingest-evolution.js does)
  const normalizedPhone = '556599421507';
  const existing = mod.stmts.getConversation.get('conv-lid');

  // Backfill
  db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
    .run(normalizedPhone, existing.id);

  // Auto-merge check
  const duplicate = mod.stmts.findDuplicateConv.get('brand1', existing.id, normalizedPhone, normalizedPhone);
  assert.ok(duplicate, 'should find duplicate conv with real phone');

  // Keep the one with more messages
  const existingMsgCount = mod.stmts.countMessages.get(existing.id)?.total || 0;
  const dupMsgCount = mod.stmts.countMessages.get(duplicate.id)?.total || 0;
  const keepId = dupMsgCount > existingMsgCount ? duplicate.id : existing.id;
  const mergeId = keepId === existing.id ? duplicate.id : existing.id;

  const result = mod.mergeConversations(keepId, mergeId);
  assert.ok(result.merged, 'should have merged');

  // Verify: only one conversation remains
  const allConvs = db.prepare('SELECT * FROM conversations WHERE brand_id = ?').all('brand1');
  assert.equal(allConvs.length, 1, 'should have exactly one conversation');

  // Verify: all messages are on the surviving conv
  const allMsgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(keepId);
  assert.equal(allMsgs.length, 2, 'both messages should be on surviving conv');
});

// ─── 18. Cross-link auto-merge scenario ─────────────────────────────────────
test('cross-link auto-merge when orphaned LID-only conv exists', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  // Scenario: Conv B (LID only) exists. Then customer contacts via real phone (Conv A created).
  // When a new LID message arrives for Conv A, we detect Conv B as orphaned → merge.
  insertConv(db, 'conv-orphan-lid', 'brand1', null, null, '9771352613108');
  insertMsg(db, 'msg-lid', 'conv-orphan-lid', 'brand1', 'message via LID');
  insertConv(db, 'conv-real', 'brand1', '556599421507', 'Daniel', '9771352613108');

  // Simulate: LID message arrives, conv-real is found. Check for orphaned LID convs.
  const lid = '9771352613108';
  const lidDuplicate = mod.stmts.findDuplicateConv.get('brand1', 'conv-real', lid, lid);
  assert.ok(lidDuplicate, 'should find orphaned LID-only conv');
  assert.equal(lidDuplicate.id, 'conv-orphan-lid');

  const result = mod.mergeConversations('conv-real', lidDuplicate.id);
  assert.ok(result.merged, 'should have merged');

  const allConvs = db.prepare('SELECT * FROM conversations WHERE brand_id = ?').all('brand1');
  assert.equal(allConvs.length, 1, 'should have exactly one conversation');
  assert.equal(allConvs[0].id, 'conv-real', 'real-phone conv should survive');

  // Message from orphan should be moved
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all('conv-real');
  assert.equal(msgs.length, 1, 'orphan message should be on real conv');
});

// ─── 19. No merge when no duplicate exists ──────────────────────────────────
test('no auto-merge when backfilling with unique phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-lid', 'brand1', null, null, '9771352613108');
  insertConv(db, 'conv-other', 'brand1', '5511988776655', 'Other Person', null);

  // Backfill
  const uniquePhone = '556599421507';
  db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
    .run(uniquePhone, 'conv-lid');

  const duplicate = mod.stmts.findDuplicateConv.get('brand1', 'conv-lid', uniquePhone, uniquePhone);
  assert.equal(duplicate, undefined, 'should NOT find duplicate for unique phone');

  const allConvs = db.prepare('SELECT * FROM conversations WHERE brand_id = ?').all('brand1');
  assert.equal(allConvs.length, 2, 'both conversations should remain');
});

// ─── 20. Merge prefers conversation with more messages ──────────────────────
test('auto-merge keeps the conversation with more messages', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-few', 'brand1', '556599421507', null, null);
  insertMsg(db, 'msg1', 'conv-few', 'brand1', 'only one message');

  insertConv(db, 'conv-many', 'brand1', null, 'Daniel', '9771352613108');
  insertMsg(db, 'msg2', 'conv-many', 'brand1', 'message 1');
  insertMsg(db, 'msg3', 'conv-many', 'brand1', 'message 2');
  insertMsg(db, 'msg4', 'conv-many', 'brand1', 'message 3');

  // Simulate backfill on conv-many
  db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
    .run('556599421507', 'conv-many');

  const duplicate = mod.stmts.findDuplicateConv.get('brand1', 'conv-many', '556599421507', '556599421507');
  assert.ok(duplicate, 'should find duplicate');

  const manyCount = mod.stmts.countMessages.get('conv-many')?.total || 0;
  const fewCount = mod.stmts.countMessages.get(duplicate.id)?.total || 0;
  const keepId = fewCount > manyCount ? duplicate.id : 'conv-many';
  const mergeId = keepId === 'conv-many' ? duplicate.id : 'conv-many';

  assert.equal(keepId, 'conv-many', 'should keep conv with more messages');

  const result = mod.mergeConversations(keepId, mergeId);
  assert.ok(result.merged);

  const allMsgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all('conv-many');
  assert.equal(allMsgs.length, 4, 'all 4 messages should be on surviving conv');
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
