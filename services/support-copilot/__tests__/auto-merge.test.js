#!/usr/bin/env node
/**
 * Auto-Merge Logic Tests — Support Copilot
 *
 * Tests the mergeConversations() function and the findDuplicateConv statement
 * using an in-memory SQLite database that mirrors the production schema.
 *
 * IMPORTANT: Queries are BRAND-AGNOSTIC for phone/alias lookups.
 * A phone number uniquely identifies a customer regardless of brand_id.
 * This prevents duplicate conversations when brand mappings change
 * (e.g. turbo → turbo_station).
 *
 * Run: node services/support-copilot/__tests__/auto-merge.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// ─── Real-world test data (from production scenarios) ──────────────────────

const REAL_DATA = {
  // Lori: contacted via real phone first, then via LID → created duplicate
  lori: {
    phone: '556581634243',
    lid: '275844442411126',
    name: 'Lori',
    brand: 'turbo_station',
  },
  // Daniel V.: all messages via LID, no real phone ever resolved
  danielV: {
    phone: null,
    lid: '256920799707279',
    name: 'Daniel V.',
    brand: 'turbo_station',
  },
  // Simulated: brand mapping changed from 'turbo' to 'turbo_station'
  brandMigration: {
    phone: '5511999887766',
    name: 'João',
    oldBrand: 'turbo',
    newBrand: 'turbo_station',
  },
};

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
// CRITICAL: These queries must match the PRODUCTION queries in lib/db.js.
// All phone/alias lookups are BRAND-AGNOSTIC (no brand_id filter).

function buildModule(db) {
  function nowIso() { return new Date().toISOString(); }
  function randomId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  const stmts = {
    getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    countMessages: db.prepare('SELECT COUNT(*) as total FROM messages WHERE conversation_id = ?'),
    // Brand-agnostic: phone uniquely identifies a customer
    findDuplicateConv: db.prepare(
      `SELECT * FROM conversations
       WHERE channel = 'whatsapp' AND id != ?
       AND (customer_phone = ? OR (',' || phone_aliases || ',') LIKE ('%,' || ? || ',%'))
       LIMIT 1`
    ),
    // Brand-agnostic: unified phone + alias lookup
    findConvByPhoneOrAlias: db.prepare(
      `SELECT * FROM conversations
       WHERE channel = 'whatsapp'
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

function insertMsg(db, id, convId, brandId, body, direction = 'inbound') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, created_at)
    VALUES (?, ?, ?, ?, 'webhook', ?, ?)
  `).run(id, convId, brandId, direction, body, now);
}

function insertSuggestion(db, id, convId, brandId, text) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO suggestions (id, conversation_id, brand_id, suggestion_text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, convId, brandId, text, now, now);
}

/**
 * Simulates the ingest-evolution.js flow for a single incoming message.
 * Returns { conversationId, existing, created, merged }
 */
function simulateIngest(mod, { brandId, phone, isLid, pushName, body, direction = 'inbound' }) {
  const normalizedPhone = phone;
  let existing = mod.stmts.findConvByPhoneOrAlias.get(normalizedPhone, normalizedPhone);
  let merged = false;
  let conversationId;
  let created = false;
  const now = mod.nowIso();

  // Self-heal brand_id
  if (existing && existing.brand_id !== brandId) {
    mod.db.prepare('UPDATE conversations SET brand_id = ?, updated_at = ? WHERE id = ?')
      .run(brandId, now, existing.id);
    existing.brand_id = brandId;
  }

  if (existing) {
    conversationId = existing.id;

    // Backfill phone when LID conv gets real phone
    if (!existing.customer_phone && !isLid) {
      mod.db.prepare('UPDATE conversations SET customer_phone = ?, updated_at = ? WHERE id = ?')
        .run(normalizedPhone, now, existing.id);

      // Auto-merge: check for duplicate with same phone
      const duplicate = mod.stmts.findDuplicateConv.get(existing.id, normalizedPhone, normalizedPhone);
      if (duplicate) {
        const existingMsgCount = mod.stmts.countMessages.get(existing.id)?.total || 0;
        const dupMsgCount = mod.stmts.countMessages.get(duplicate.id)?.total || 0;
        const keepId = dupMsgCount > existingMsgCount ? duplicate.id : existing.id;
        const mergeId = keepId === existing.id ? duplicate.id : existing.id;
        mod.mergeConversations(keepId, mergeId);
        conversationId = keepId;
        merged = true;
      }
    }

    // Cross-link: add LID to aliases if conv has real phone but message came via LID
    if (isLid && existing.customer_phone) {
      const aliases = existing.phone_aliases || '';
      if (!aliases.split(',').includes(normalizedPhone)) {
        const newAliases = aliases ? `${aliases},${normalizedPhone}` : normalizedPhone;
        mod.db.prepare('UPDATE conversations SET phone_aliases = ?, updated_at = ? WHERE id = ?')
          .run(newAliases, now, existing.id);
      }

      // Auto-merge: check for orphaned LID-only conv
      const lidDuplicate = mod.stmts.findDuplicateConv.get(existing.id, normalizedPhone, normalizedPhone);
      if (lidDuplicate) {
        mod.mergeConversations(existing.id, lidDuplicate.id);
        merged = true;
      }
    }

    // Update name from inbound
    if (pushName && direction === 'inbound') {
      mod.db.prepare('UPDATE conversations SET customer_name = ?, updated_at = ? WHERE id = ?')
        .run(pushName, now, existing.id);
    }
  } else {
    // Create new conversation
    conversationId = mod.randomId('conv');
    created = true;
    mod.db.prepare(`
      INSERT INTO conversations (id, brand_id, channel, customer_phone, customer_name, phone_aliases, status, priority, unread_count, last_message_at, created_at, updated_at)
      VALUES (?, ?, 'whatsapp', ?, ?, ?, 'open', 'normal', 0, ?, ?, ?)
    `).run(
      conversationId, brandId,
      isLid ? null : normalizedPhone,
      pushName || null,
      isLid ? normalizedPhone : null,
      now, now, now
    );
  }

  // Insert message
  mod.db.prepare(`
    INSERT INTO messages (id, conversation_id, brand_id, direction, source, body, created_at)
    VALUES (?, ?, ?, ?, 'webhook', ?, ?)
  `).run(mod.randomId('msg'), conversationId, brandId, direction, body, now);

  return { conversationId, existing: !!existing, created, merged };
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

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🧪 mergeConversations() — unit tests\n');
// ═══════════════════════════════════════════════════════════════════════════

test('basic merge deletes source and keeps target', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', 'Daniel', null);
  insertConv(db, 'conv-b', 'turbo_station', null, null, '9771352613108');
  insertMsg(db, 'msg1', 'conv-a', 'turbo_station', 'hello from A');
  insertMsg(db, 'msg2', 'conv-b', 'turbo_station', 'hello from B');

  const result = mod.mergeConversations('conv-a', 'conv-b');
  assert.ok(result.merged, 'should have merged');

  assert.equal(mod.stmts.getConversation.get('conv-b'), undefined, 'source conv should be deleted');

  const target = mod.stmts.getConversation.get('conv-a');
  assert.ok(target, 'target conv should still exist');

  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all('conv-a');
  assert.equal(msgs.length, 2, 'both messages should be on target');
});

test('merging LID-only conv into phone conv preserves phone and adds alias', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-phone', 'turbo_station', REAL_DATA.lori.phone, REAL_DATA.lori.name, null);
  insertConv(db, 'conv-lid', 'turbo_station', null, null, REAL_DATA.lori.lid);

  mod.mergeConversations('conv-phone', 'conv-lid');
  const target = mod.stmts.getConversation.get('conv-phone');

  assert.equal(target.customer_phone, REAL_DATA.lori.phone, 'phone should be preserved');
  assert.ok(target.phone_aliases?.includes(REAL_DATA.lori.lid), 'LID should be in aliases');
});

test('merging phone conv into LID-only conv backfills phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-lid', 'turbo_station', null, null, REAL_DATA.lori.lid);
  insertConv(db, 'conv-phone', 'turbo_station', REAL_DATA.lori.phone, REAL_DATA.lori.name, null);

  mod.mergeConversations('conv-lid', 'conv-phone');
  const target = mod.stmts.getConversation.get('conv-lid');

  assert.equal(target.customer_phone, REAL_DATA.lori.phone, 'target should get phone from source');
  assert.equal(target.customer_name, REAL_DATA.lori.name, 'target should get name from source');
});

test('merge backfills customer_name when target has none', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', null, 'Daniel V.', '9771352613108');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');

  assert.equal(target.customer_name, 'Daniel V.', 'name should be backfilled');
});

test('merge does NOT overwrite existing customer_name', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', 'Original Name', null);
  insertConv(db, 'conv-b', 'turbo_station', null, 'Other Name', '9771352613108');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');

  assert.equal(target.customer_name, 'Original Name', 'name should not be overwritten');
});

test('merging a conversation into itself is a no-op', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', 'Daniel', null);

  const result = mod.mergeConversations('conv-a', 'conv-a');
  assert.equal(result.merged, false, 'should not merge');
  assert.equal(result.reason, 'same_conversation');
});

test('merging non-existent conversation fails gracefully', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', 'Daniel', null);

  const result = mod.mergeConversations('conv-a', 'conv-nonexistent');
  assert.equal(result.merged, false, 'should not merge');
  assert.equal(result.reason, 'not_found');
});

test('suggestions are moved from source to target', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', null, null, '9771352613108');
  insertSuggestion(db, 'sug1', 'conv-b', 'turbo_station', 'Try X');

  mod.mergeConversations('conv-a', 'conv-b');

  const sugs = db.prepare('SELECT * FROM suggestions WHERE conversation_id = ?').all('conv-a');
  assert.equal(sugs.length, 1, 'suggestion should be moved to target');
  assert.equal(sugs[0].id, 'sug1');
});

test('audit log entry is created for auto_merge', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', null, null, '9771352613108');

  mod.mergeConversations('conv-a', 'conv-b');

  const logs = db.prepare("SELECT * FROM audit_log WHERE action = 'support.auto_merge'").all();
  assert.equal(logs.length, 1, 'should have exactly one auto_merge audit entry');
  const meta = JSON.parse(logs[0].metadata_json);
  assert.equal(meta.merged_from, 'conv-b');
});

test('merge combines aliases from both conversations without duplicates', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, '111111,222222');
  insertConv(db, 'conv-b', 'turbo_station', null, null, '222222,333333');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');
  const aliases = target.phone_aliases ? target.phone_aliases.split(',').sort() : [];

  assert.ok(aliases.includes('111111'), 'should include alias from target');
  assert.ok(aliases.includes('222222'), 'should include shared alias');
  assert.ok(aliases.includes('333333'), 'should include alias from source');
  assert.ok(!aliases.includes('556599421507'), 'primary phone should not be duplicated in aliases');
});

test('merge backfills profile_pic_url when target has none', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', null, null, '9771352613108');
  db.prepare('UPDATE conversations SET profile_pic_url = ? WHERE id = ?')
    .run('https://example.com/pic.jpg', 'conv-b');

  mod.mergeConversations('conv-a', 'conv-b');
  const target = mod.stmts.getConversation.get('conv-a');
  assert.equal(target.profile_pic_url, 'https://example.com/pic.jpg');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🧪 findDuplicateConv — brand-agnostic tests\n');
// ═══════════════════════════════════════════════════════════════════════════

test('findDuplicateConv finds conv with matching customer_phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', '556599421507', null, null);

  const dup = mod.stmts.findDuplicateConv.get('conv-a', '556599421507', '556599421507');
  assert.ok(dup, 'should find duplicate');
  assert.equal(dup.id, 'conv-b');
});

test('findDuplicateConv finds conv with matching alias', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', null, null, '556599421507');

  const dup = mod.stmts.findDuplicateConv.get('conv-a', '556599421507', '556599421507');
  assert.ok(dup, 'should find duplicate via alias');
  assert.equal(dup.id, 'conv-b');
});

test('findDuplicateConv does not return self', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);

  const dup = mod.stmts.findDuplicateConv.get('conv-a', '556599421507', '556599421507');
  assert.equal(dup, undefined, 'should not find self');
});

test('findDuplicateConv finds ACROSS brands (brand-agnostic)', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  // Conv created under old brand 'turbo'
  insertConv(db, 'conv-old', 'turbo', '556599421507', null, null);
  // Conv created under new brand 'turbo_station'
  insertConv(db, 'conv-new', 'turbo_station', '556599421507', null, null);

  // Should find cross-brand duplicate
  const dup = mod.stmts.findDuplicateConv.get('conv-new', '556599421507', '556599421507');
  assert.ok(dup, 'should find duplicate across brands');
  assert.equal(dup.id, 'conv-old');
});

test('findConvByPhoneOrAlias finds ACROSS brands (brand-agnostic)', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  // Conv was created under old brand
  insertConv(db, 'conv-old', 'turbo', '556599421507', 'João', null);

  // New message arrives under new brand — should still find existing conv
  const found = mod.stmts.findConvByPhoneOrAlias.get('556599421507', '556599421507');
  assert.ok(found, 'should find conv regardless of brand');
  assert.equal(found.id, 'conv-old');
  assert.equal(found.brand_id, 'turbo', 'brand should be the old one (self-heal happens in ingest)');
});

test('findDuplicateConv returns undefined when no duplicate exists', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-a', 'turbo_station', '556599421507', null, null);
  insertConv(db, 'conv-b', 'turbo_station', '5511988776655', null, null);

  const dup = mod.stmts.findDuplicateConv.get('conv-a', '556599421507', '556599421507');
  assert.equal(dup, undefined, 'should not find unrelated conv');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🧪 Real-world scenario: Lori (phone → LID → duplicate)\n');
// ═══════════════════════════════════════════════════════════════════════════

test('Lori scenario: phone conv exists, LID message creates duplicate, auto-merge fixes it', () => {
  const db = createTestDb();
  const mod = buildModule(db);
  const { phone, lid, name, brand } = REAL_DATA.lori;

  // Step 1: Lori contacts via real phone → conv created with phone
  const r1 = simulateIngest(mod, {
    brandId: brand, phone, isLid: false, pushName: name,
    body: 'uhum', direction: 'inbound',
  });
  assert.ok(r1.created, 'should create new conv for first message');

  // Step 2: Lori contacts via LID → no existing conv found (phone != LID) → new conv created
  const r2 = simulateIngest(mod, {
    brandId: brand, phone: lid, isLid: true, pushName: name,
    body: 'Taco fome já', direction: 'inbound',
  });
  assert.ok(r2.created, 'LID message should create second conv (before cross-link)');

  // At this point we have two conversations — the bug scenario
  const convs = db.prepare('SELECT * FROM conversations').all();
  assert.equal(convs.length, 2, 'should have two convs (duplicate state)');

  // Step 3: new message from Lori via real phone → finds conv 1, adds LID alias
  // But wait — we need to add the LID as alias to conv 1 first to trigger cross-link.
  // In production this happens when an outbound message resolves the LID → phone mapping.
  // Simulate: backfill conv 2 (LID only) with the real phone
  const lidConv = db.prepare('SELECT * FROM conversations WHERE customer_phone IS NULL').get();
  assert.ok(lidConv, 'should have LID-only conv');

  db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
    .run(phone, lidConv.id);

  // Now auto-merge should detect the duplicate
  const duplicate = mod.stmts.findDuplicateConv.get(lidConv.id, phone, phone);
  assert.ok(duplicate, 'should find duplicate conv with same phone');

  const existingMsgCount = mod.stmts.countMessages.get(lidConv.id)?.total || 0;
  const dupMsgCount = mod.stmts.countMessages.get(duplicate.id)?.total || 0;
  const keepId = dupMsgCount > existingMsgCount ? duplicate.id : lidConv.id;
  const mergeId = keepId === lidConv.id ? duplicate.id : lidConv.id;

  const mergeResult = mod.mergeConversations(keepId, mergeId);
  assert.ok(mergeResult.merged, 'auto-merge should succeed');

  // Verify: only one conversation remains
  const finalConvs = db.prepare('SELECT * FROM conversations').all();
  assert.equal(finalConvs.length, 1, 'should have exactly one conversation after merge');
  assert.equal(finalConvs[0].customer_phone, phone, 'surviving conv should have real phone');
  assert.ok(finalConvs[0].phone_aliases?.includes(lid), 'surviving conv should have LID as alias');

  // All messages on surviving conv
  const allMsgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(keepId);
  assert.equal(allMsgs.length, 2, 'all messages should be on surviving conv');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🧪 Real-world scenario: brand migration (turbo → turbo_station)\n');
// ═══════════════════════════════════════════════════════════════════════════

test('brand migration: conv created under turbo, new message under turbo_station — no duplicate', () => {
  const db = createTestDb();
  const mod = buildModule(db);
  const { phone, name, oldBrand, newBrand } = REAL_DATA.brandMigration;

  // Step 1: message ingested under old brand
  const r1 = simulateIngest(mod, {
    brandId: oldBrand, phone, isLid: false, pushName: name,
    body: 'Oi, preciso de ajuda', direction: 'inbound',
  });
  assert.ok(r1.created, 'should create conv under old brand');

  // Step 2: EVOLUTION_INSTANCE_MAP changed → new message comes as turbo_station
  const r2 = simulateIngest(mod, {
    brandId: newBrand, phone, isLid: false, pushName: name,
    body: 'Oi, tudo bem?', direction: 'inbound',
  });
  assert.ok(!r2.created, 'should NOT create new conv (found existing by phone)');
  assert.ok(!r2.merged, 'should NOT trigger merge (same conv)');

  // Verify: only one conversation, brand self-healed to new brand
  const convs = db.prepare('SELECT * FROM conversations').all();
  assert.equal(convs.length, 1, 'should have exactly one conversation');
  assert.equal(convs[0].brand_id, newBrand, 'brand_id should be self-healed to turbo_station');
  assert.equal(convs[0].customer_phone, phone, 'phone should be preserved');

  // Both messages on same conv
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(convs[0].id);
  assert.equal(msgs.length, 2, 'both messages on same conv');
});

test('brand migration does NOT duplicate when same phone ingested under different brand', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  // Simulate the exact scenario that caused duplicates:
  // turbostation:turbo → turbostation:turbo_station instance map change
  insertConv(db, 'conv-old', 'turbo', '556581634243', 'Lori', null);
  insertMsg(db, 'msg1', 'conv-old', 'turbo', 'old message');

  // New message arrives with brand 'turbo_station'
  const r = simulateIngest(mod, {
    brandId: 'turbo_station', phone: '556581634243', isLid: false, pushName: 'Lori',
    body: 'new message', direction: 'inbound',
  });

  assert.ok(!r.created, 'should NOT create new conv');
  const convs = db.prepare('SELECT * FROM conversations').all();
  assert.equal(convs.length, 1, 'should have exactly one conversation');
  assert.equal(convs[0].brand_id, 'turbo_station', 'brand should be self-healed');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🧪 Real-world scenario: Daniel V. (LID-only, no phone ever)\n');
// ═══════════════════════════════════════════════════════════════════════════

test('Daniel V. scenario: all messages via LID — single conv, no phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);
  const { lid, name, brand } = REAL_DATA.danielV;

  // Message 1 via LID
  const r1 = simulateIngest(mod, {
    brandId: brand, phone: lid, isLid: true, pushName: name,
    body: 'Bom dia', direction: 'inbound',
  });
  assert.ok(r1.created, 'first message should create conv');

  // Message 2 via same LID
  const r2 = simulateIngest(mod, {
    brandId: brand, phone: lid, isLid: true, pushName: name,
    body: 'Preciso de ajuda', direction: 'inbound',
  });
  assert.ok(!r2.created, 'second message should find existing conv via alias');
  assert.equal(r1.conversationId, r2.conversationId, 'both should be on same conv');

  const convs = db.prepare('SELECT * FROM conversations').all();
  assert.equal(convs.length, 1, 'should have exactly one conversation');
  assert.equal(convs[0].customer_phone, null, 'phone should remain null (LID only)');
  assert.ok(convs[0].phone_aliases?.includes(lid), 'LID should be stored as alias');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🧪 Edge cases\n');
// ═══════════════════════════════════════════════════════════════════════════

test('auto-merge keeps conversation with more messages', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-few', 'turbo_station', '556599421507', null, null);
  insertMsg(db, 'msg1', 'conv-few', 'turbo_station', 'only one message');

  insertConv(db, 'conv-many', 'turbo_station', null, 'Daniel', '9771352613108');
  insertMsg(db, 'msg2', 'conv-many', 'turbo_station', 'message 1');
  insertMsg(db, 'msg3', 'conv-many', 'turbo_station', 'message 2');
  insertMsg(db, 'msg4', 'conv-many', 'turbo_station', 'message 3');

  // Simulate backfill on conv-many
  db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
    .run('556599421507', 'conv-many');

  const duplicate = mod.stmts.findDuplicateConv.get('conv-many', '556599421507', '556599421507');
  assert.ok(duplicate, 'should find duplicate');

  const manyCount = mod.stmts.countMessages.get('conv-many')?.total || 0;
  const fewCount = mod.stmts.countMessages.get(duplicate.id)?.total || 0;
  const keepId = fewCount > manyCount ? duplicate.id : 'conv-many';

  assert.equal(keepId, 'conv-many', 'should keep conv with more messages');

  const result = mod.mergeConversations(keepId, duplicate.id);
  assert.ok(result.merged);

  const allMsgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all('conv-many');
  assert.equal(allMsgs.length, 4, 'all 4 messages should be on surviving conv');
});

test('no auto-merge when backfilling with unique phone', () => {
  const db = createTestDb();
  const mod = buildModule(db);

  insertConv(db, 'conv-lid', 'turbo_station', null, null, '9771352613108');
  insertConv(db, 'conv-other', 'turbo_station', '5511988776655', 'Other Person', null);

  const uniquePhone = '556599421507';
  db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
    .run(uniquePhone, 'conv-lid');

  const duplicate = mod.stmts.findDuplicateConv.get('conv-lid', uniquePhone, uniquePhone);
  assert.equal(duplicate, undefined, 'should NOT find duplicate for unique phone');

  const allConvs = db.prepare('SELECT * FROM conversations').all();
  assert.equal(allConvs.length, 2, 'both conversations should remain');
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
