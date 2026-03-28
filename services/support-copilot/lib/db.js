/**
 * Database Layer — Support Copilot
 *
 * SQLite connection + schema + prepared statements.
 * @module lib/db
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH, LOG_TAG } = require('./constants');

// Ensure directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  console.log(`${LOG_TAG} Database connected: ${DB_PATH}`);
} catch (err) {
  console.error(`${LOG_TAG} Failed to connect to database:`, err.message);
  process.exit(1);
}

// ─── Schema ──────────────────────────────────────────────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_user_id TEXT,
      external_conversation_id TEXT,
      customer_phone TEXT,
      customer_name TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_agent_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      last_message_at TEXT,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      source TEXT NOT NULL,
      body TEXT NOT NULL,
      author_id TEXT,
      external_message_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      suggestion_text TEXT NOT NULL,
      model_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      conversation_id TEXT,
      action TEXT NOT NULL,
      actor_user_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conv_brand_updated ON conversations (brand_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages (conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_msg_external_id ON messages (external_message_id);
    CREATE INDEX IF NOT EXISTS idx_sug_conv_created ON suggestions (conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations (customer_phone);
  `);
  console.log(`${LOG_TAG} Schema ready (brands, conversations, messages, suggestions, audit_log)`);
} catch (err) {
  console.error(`${LOG_TAG} Failed to initialise schema:`, err.message);
  process.exit(1);
}

// ─── Migrations ──────────────────────────────────────────────────────────────

function safeAddColumn(table, column, type) {
  try {
    const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map(r => r.name);
    if (!cols.includes(column)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
      console.log(`${LOG_TAG} Migration: added ${table}.${column}`);
    }
  } catch (err) {
    console.warn(`${LOG_TAG} Migration warning (${table}.${column}):`, err.message);
  }
}

// Staff toggle
safeAddColumn('conversations', 'is_staff', 'INTEGER DEFAULT 0');
// Escalation flow
safeAddColumn('conversations', 'escalated_at', 'TEXT DEFAULT NULL');
safeAddColumn('conversations', 'escalated_to', 'TEXT DEFAULT NULL');
// Learning from edits
safeAddColumn('suggestions', 'edited_text', 'TEXT DEFAULT NULL');

// Session context tracking — remembers what was sent to the agent to avoid repeating
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_context (
      conversation_id TEXT PRIMARY KEY,
      last_msg_index INTEGER NOT NULL DEFAULT 0,
      context_hash TEXT,
      last_sent_at TEXT,
      full_context_sent INTEGER NOT NULL DEFAULT 0,
      compacted_at TEXT DEFAULT NULL
    );
  `);
} catch (err) {
  console.warn(`${LOG_TAG} session_context migration:`, err.message);
}
safeAddColumn('session_context', 'compacted_at', 'TEXT DEFAULT NULL');
safeAddColumn('session_context', 'compaction_summary', 'TEXT DEFAULT NULL');

// Copilot settings — per-brand configuration for the AI assistant
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_settings (
      brand_id TEXT PRIMARY KEY,
      tone_rules TEXT,
      business_info TEXT,
      quick_replies_json TEXT,
      updated_at TEXT NOT NULL
    );
  `);
} catch (err) {
  console.warn(`${LOG_TAG} copilot_settings migration:`, err.message);
}
safeAddColumn('copilot_settings', 'auto_suggest', 'INTEGER DEFAULT 0');
safeAddColumn('copilot_settings', 'auto_respond', 'INTEGER DEFAULT 0');

// Copilot learned rules — extracted from operator edits to suggestions
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_learned_rules (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      example_original TEXT,
      example_edited TEXT,
      source_suggestion_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
  `);
} catch (err) {
  console.warn(`${LOG_TAG} copilot_learned_rules migration:`, err.message);
}

// Knowledge documents — per-brand knowledge base managed from the dashboard
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_knowledge_docs (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(brand_id, slug)
    );
  `);
} catch (err) {
  console.warn(`${LOG_TAG} copilot_knowledge_docs migration:`, err.message);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').trim();
}

// ─── Prepared Statements ─────────────────────────────────────────────────────

const stmts = {
  listConversations: db.prepare(
    `SELECT c.*,
       (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY datetime(m.created_at) DESC LIMIT 1) AS last_message_preview
     FROM conversations c WHERE c.brand_id = ? ORDER BY datetime(COALESCE(c.last_message_at, c.updated_at)) DESC`
  ),
  getConversation: db.prepare(
    `SELECT * FROM conversations WHERE id = ?`
  ),
  listMessages: db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY datetime(created_at) ASC`
  ),
  countMessages: db.prepare(
    `SELECT COUNT(*) as total FROM messages WHERE conversation_id = ?`
  ),
  listMessagesPaginated: db.prepare(
    `SELECT * FROM (
       SELECT * FROM messages WHERE conversation_id = ? ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?
     ) sub ORDER BY datetime(created_at) ASC`
  ),
  listSuggestions: db.prepare(
    `SELECT * FROM suggestions WHERE conversation_id = ? ORDER BY datetime(created_at) ASC`
  ),
  getSuggestion: db.prepare(
    `SELECT * FROM suggestions WHERE id = ?`
  ),
  listAuditLog: db.prepare(
    `SELECT * FROM audit_log WHERE conversation_id = ? ORDER BY datetime(created_at) ASC`
  ),
  findConvByPhone: db.prepare(
    `SELECT * FROM conversations WHERE brand_id = ? AND channel = 'whatsapp' AND customer_phone = ? LIMIT 1`
  ),
  findConvByAlias: db.prepare(
    `SELECT * FROM conversations WHERE brand_id = ? AND channel = 'whatsapp' AND (',' || phone_aliases || ',') LIKE ('%,' || ? || ',%') LIMIT 1`
  ),
  // Unified: find by phone OR alias (fixes LID ↔ phone dedup)
  findConvByPhoneOrAlias: db.prepare(
    `SELECT * FROM conversations
     WHERE brand_id = ? AND channel = 'whatsapp'
     AND (customer_phone = ? OR (',' || phone_aliases || ',') LIKE ('%,' || ? || ',%'))
     LIMIT 1`
  ),
  findMsgByExternalId: db.prepare(
    `SELECT id, created_at as createdAt FROM messages WHERE conversation_id = ? AND brand_id = ? AND external_message_id = ? LIMIT 1`
  ),
  // Learning: recent approved/edited suggestions for prompt injection
  recentApprovedSuggestions: db.prepare(
    `SELECT s.suggestion_text, s.status, s.edited_text
     FROM suggestions s
     JOIN conversations c ON s.conversation_id = c.id
     WHERE s.brand_id = ? AND s.status IN ('accepted', 'edited')
     AND (c.is_staff IS NULL OR c.is_staff = 0)
     ORDER BY datetime(s.decided_at) DESC
     LIMIT ?`
  ),
  // Other conversations from the same phone (for multi-session awareness)
  otherConvsByPhone: db.prepare(
    `SELECT id, status, created_at, last_message_at,
       (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as msg_count
     FROM conversations c
     WHERE customer_phone = ? AND id != ?
     ORDER BY datetime(created_at) DESC
     LIMIT 5`
  ),
  // Find a duplicate conversation with the same phone or alias (for auto-merge)
  // Excludes the given conversation ID to avoid self-match
  findDuplicateConv: db.prepare(
    `SELECT * FROM conversations
     WHERE brand_id = ? AND channel = 'whatsapp' AND id != ?
     AND (customer_phone = ? OR (',' || phone_aliases || ',') LIKE ('%,' || ? || ',%'))
     LIMIT 1`
  ),
  // Session context tracking
  getSessionContext: db.prepare(
    `SELECT * FROM session_context WHERE conversation_id = ?`
  ),
  upsertSessionContext: db.prepare(
    `INSERT INTO session_context (conversation_id, last_msg_index, context_hash, last_sent_at, full_context_sent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       last_msg_index = excluded.last_msg_index,
       context_hash = excluded.context_hash,
       last_sent_at = excluded.last_sent_at,
       full_context_sent = excluded.full_context_sent`
  ),
};

/**
 * Merge source conversation into target conversation.
 * Moves all messages, suggestions, and audit logs from source to target.
 * Combines phone numbers and aliases. Deletes the source conversation.
 *
 * @param {string} targetId - The conversation ID to keep
 * @param {string} sourceId - The conversation ID to merge and delete
 * @returns {{ merged: boolean, targetId: string, sourceId: string }} result
 */
function mergeConversations(targetId, sourceId) {
  const target = stmts.getConversation.get(targetId);
  const source = stmts.getConversation.get(sourceId);
  if (!target || !source) return { merged: false, targetId, sourceId, reason: 'not_found' };
  if (target.id === source.id) return { merged: false, targetId, sourceId, reason: 'same_conversation' };

  const now = nowIso();
  db.transaction(() => {
    // Move messages
    db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?')
      .run(target.id, source.id);
    // Move suggestions
    db.prepare('UPDATE suggestions SET conversation_id = ? WHERE conversation_id = ?')
      .run(target.id, source.id);
    // Move audit log
    db.prepare('UPDATE audit_log SET conversation_id = ? WHERE conversation_id = ?')
      .run(target.id, source.id);
    // Merge phone info: prefer the real phone number
    if (source.customer_phone && !target.customer_phone) {
      db.prepare('UPDATE conversations SET customer_phone = ? WHERE id = ?')
        .run(source.customer_phone, target.id);
    }
    if (source.customer_name && !target.customer_name) {
      db.prepare('UPDATE conversations SET customer_name = ? WHERE id = ?')
        .run(source.customer_name, target.id);
    }
    // Profile pic: keep whichever exists
    if (source.profile_pic_url && !target.profile_pic_url) {
      db.prepare('UPDATE conversations SET profile_pic_url = ? WHERE id = ?')
        .run(source.profile_pic_url, target.id);
    }
    // Merge aliases — combine all known identifiers
    const allAliases = new Set();
    if (target.phone_aliases) target.phone_aliases.split(',').forEach(a => allAliases.add(a));
    if (source.phone_aliases) source.phone_aliases.split(',').forEach(a => allAliases.add(a));
    if (source.customer_phone) allAliases.add(source.customer_phone);
    if (target.customer_phone) allAliases.add(target.customer_phone);
    // Remove the primary phone from aliases (it's already in customer_phone)
    const primaryPhone = target.customer_phone || source.customer_phone;
    if (primaryPhone) allAliases.delete(primaryPhone);
    const mergedAliases = [...allAliases].filter(Boolean).join(',') || null;
    db.prepare('UPDATE conversations SET phone_aliases = ?, updated_at = ? WHERE id = ?')
      .run(mergedAliases, now, target.id);
    // Delete source conversation
    db.prepare('DELETE FROM conversations WHERE id = ?').run(source.id);
    // Audit
    db.prepare(`INSERT INTO audit_log (id, brand_id, conversation_id, action, actor_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomId('audit'), target.brand_id, target.id, 'support.auto_merge', null, JSON.stringify({ merged_from: source.id, source_phone: source.customer_phone, source_aliases: source.phone_aliases }), now);
  })();

  return { merged: true, targetId: target.id, sourceId: source.id };
}

module.exports = { db, stmts, nowIso, randomId, normalizePhone, mergeConversations };
