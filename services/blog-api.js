#!/usr/bin/env node
/**
 * Turbo Station blog-api
 *
 * Express + better-sqlite3 service that stores AI-generated blog posts on the
 * OpenClaw VPS and serves them to the Next.js site (which fetches via its
 * VpsApiBlogSource, cached + fail-soft). The daily blog-generator writes posts
 * here; the Next dashboard reads/manages them; the public blog reads published
 * posts.
 *
 * All endpoints (except /health) require the shared secret header
 * `x-blog-api-key` === BLOG_API_KEY. Next is the only client; nginx exposes this
 * at logs.turbostation.com.br/blog/api on a loopback port.
 *
 * Schema lives here (created on boot). The generator inserts; this api never
 * calls an LLM.
 */
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.BLOG_API_PORT || 3300);
const API_KEY = (process.env.BLOG_API_KEY || '').trim();
const DB_PATH = process.env.BLOG_DB_PATH || path.join(__dirname, '..', 'db', 'blog.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    date TEXT NOT NULL,
    updated TEXT,
    author TEXT DEFAULT 'Equipe Turbo Station',
    category TEXT DEFAULT 'Geral',
    tags TEXT DEFAULT '[]',            -- JSON array
    coverImage TEXT,
    body TEXT DEFAULT '',
    draft INTEGER NOT NULL DEFAULT 1,  -- 1 = hidden from public
    status TEXT NOT NULL DEFAULT 'draft', -- draft | published | rejected
    readingTime INTEGER DEFAULT 1,
    generationModel TEXT,
    generationSources TEXT DEFAULT '[]', -- JSON array
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    autopublish INTEGER NOT NULL DEFAULT 0,
    disabledReason TEXT,
    updatedBy TEXT,
    updatedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS covered_topics (
    topicKey TEXT PRIMARY KEY,
    title TEXT,
    slug TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gen_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT,
    status TEXT,        -- published | held | skipped | error
    reason TEXT,
    slug TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media (
    key TEXT PRIMARY KEY,                 -- e.g. "<slug>.webp"
    slug TEXT,                            -- owning post (for cleanup)
    contentType TEXT DEFAULT 'image/webp',
    bytes BLOB NOT NULL,
    createdAt TEXT NOT NULL
  );
  INSERT OR IGNORE INTO config (id, enabled, autopublish, updatedAt)
    VALUES (1, 1, 0, datetime('now'));
`);

// Lightweight migrations for columns added after the initial schema.
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
ensureColumn('config', 'guidelines', 'TEXT'); // editable content principles ("nossas ideias")
ensureColumn('posts', 'revisionFeedback', 'TEXT'); // operator considerations for a re-write
ensureColumn('config', 'imageStyle', 'TEXT'); // JSON template for AI cover-image generation

function rowToMeta(r) {
  return {
    slug: r.slug,
    title: r.title,
    description: r.description || '',
    date: r.date,
    updated: r.updated || undefined,
    author: r.author || 'Equipe Turbo Station',
    category: r.category || 'Geral',
    tags: safeJson(r.tags, []),
    coverImage: r.coverImage || undefined,
    draft: r.draft === 1,
    readingTime: r.readingTime || 1,
  };
}
function rowToPost(r) {
  return { ...rowToMeta(r), body: r.body || '' };
}
function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Constant-time-ish secret gate (skips /health).
app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/media/')) return next();
  const provided = (req.get('x-blog-api-key') || '').trim();
  if (!API_KEY || provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- public cover images (no auth: loaded directly by end-user browsers) ----
app.get('/media/:key', (req, res) => {
  const row = db.prepare('SELECT contentType, bytes FROM media WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.set('Content-Type', row.contentType || 'image/webp');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.send(row.bytes);
});

// ---- public-read endpoints (consumed by Next VpsApiBlogSource) ----
app.get('/posts', (_req, res) => {
  const rows = db.prepare(
    "SELECT * FROM posts WHERE draft = 0 AND status = 'published' ORDER BY date DESC"
  ).all();
  res.json({ posts: rows.map(rowToMeta) });
});

app.get('/slugs', (_req, res) => {
  const rows = db.prepare("SELECT slug FROM posts WHERE draft = 0 AND status = 'published'").all();
  res.json({ slugs: rows.map((r) => r.slug) });
});

app.get('/posts/:slug', (req, res) => {
  const row = db.prepare(
    "SELECT * FROM posts WHERE slug = ? AND draft = 0 AND status = 'published'"
  ).get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(rowToPost(row));
});

// ---- admin endpoints (dashboard via Next proxy, + the generator) ----
app.get('/admin/posts', (_req, res) => {
  const rows = db.prepare('SELECT * FROM posts ORDER BY createdAt DESC').all();
  res.json({ posts: rows.map((r) => ({ ...rowToPost(r), status: r.status, revisionFeedback: r.revisionFeedback || null })) });
});

app.get('/admin/posts/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...rowToPost(row), status: row.status, revisionFeedback: row.revisionFeedback || null });
});

function configOut(c) {
  return {
    enabled: c.enabled === 1,
    autopublish: c.autopublish === 1,
    disabledReason: c.disabledReason || null,
    guidelines: c.guidelines || '',
    imageStyle: c.imageStyle || '',
    updatedBy: c.updatedBy || null,
    updatedAt: c.updatedAt || null,
  };
}

app.get('/config', (_req, res) => {
  res.json(configOut(db.prepare('SELECT * FROM config WHERE id = 1').get()));
});

app.put('/config', (req, res) => {
  const { enabled, autopublish, updatedBy, disabledReason, guidelines, imageStyle } = req.body || {};
  const now = new Date().toISOString();
  const cur = db.prepare('SELECT * FROM config WHERE id = 1').get();
  db.prepare('UPDATE config SET enabled = ?, autopublish = ?, disabledReason = ?, guidelines = ?, imageStyle = ?, updatedBy = ?, updatedAt = ? WHERE id = 1').run(
    typeof enabled === 'boolean' ? (enabled ? 1 : 0) : cur.enabled,
    typeof autopublish === 'boolean' ? (autopublish ? 1 : 0) : cur.autopublish,
    enabled === false ? (disabledReason || null) : null,
    typeof guidelines === 'string' ? guidelines : (cur.guidelines || null),
    typeof imageStyle === 'string' ? imageStyle : (cur.imageStyle || null),
    updatedBy || cur.updatedBy || null,
    now,
  );
  res.json(configOut(db.prepare('SELECT * FROM config WHERE id = 1').get()));
});

// Create / upsert a post (used by the generator).
app.post('/posts', (req, res) => {
  const p = req.body || {};
  if (!p.slug || !p.title || !p.date) return res.status(400).json({ error: 'slug, title, date required' });
  const now = new Date().toISOString();
  const exists = db.prepare('SELECT slug FROM posts WHERE slug = ?').get(p.slug);
  db.prepare(`
    INSERT INTO posts (slug,title,description,date,updated,author,category,tags,coverImage,body,draft,status,readingTime,generationModel,generationSources,createdAt,updatedAt)
    VALUES (@slug,@title,@description,@date,@updated,@author,@category,@tags,@coverImage,@body,@draft,@status,@readingTime,@generationModel,@generationSources,@createdAt,@updatedAt)
    ON CONFLICT(slug) DO UPDATE SET
      title=@title, description=@description, date=@date, updated=@updated, author=@author,
      category=@category, tags=@tags, coverImage=@coverImage, body=@body, draft=@draft, status=@status,
      readingTime=@readingTime, generationModel=@generationModel, generationSources=@generationSources, updatedAt=@updatedAt
  `).run({
    slug: p.slug,
    title: p.title,
    description: p.description || '',
    date: p.date,
    updated: p.updated || null,
    author: p.author || 'Equipe Turbo Station',
    category: p.category || 'Geral',
    tags: JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
    coverImage: p.coverImage || null,
    body: p.body || '',
    draft: p.draft === false ? 0 : 1,
    status: p.status || (p.draft === false ? 'published' : 'draft'),
    readingTime: Number(p.readingTime) > 0 ? Math.round(Number(p.readingTime)) : 1,
    generationModel: p.generationModel || null,
    generationSources: JSON.stringify(Array.isArray(p.generationSources) ? p.generationSources : []),
    createdAt: exists ? (db.prepare('SELECT createdAt FROM posts WHERE slug = ?').get(p.slug).createdAt) : now,
    updatedAt: now,
  });
  res.json({ ok: true, slug: p.slug, created: !exists });
});

app.post('/posts/:slug/publish', (req, res) => {
  const now = new Date().toISOString();
  const r = db.prepare("UPDATE posts SET draft = 0, status = 'published', updatedAt = ? WHERE slug = ?").run(now, req.params.slug);
  res.json({ ok: r.changes > 0 });
});
app.post('/posts/:slug/unpublish', (req, res) => {
  const now = new Date().toISOString();
  const r = db.prepare("UPDATE posts SET draft = 1, status = 'draft', updatedAt = ? WHERE slug = ?").run(now, req.params.slug);
  res.json({ ok: r.changes > 0 });
});

// Operator-requested revision: store the feedback and kick off the generator's
// --revise mode in the background (the claude calls take ~1 min).
app.post('/posts/:slug/revise', (req, res) => {
  const slug = req.params.slug;
  const feedback = req.body && typeof req.body.feedback === 'string' ? req.body.feedback : '';
  const exists = db.prepare('SELECT slug FROM posts WHERE slug = ?').get(slug);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE posts SET revisionFeedback = ?, status = 'revising', updatedAt = ? WHERE slug = ?")
    .run(feedback, new Date().toISOString(), slug);
  try {
    const logFd = fs.openSync(path.join(__dirname, '..', 'logs', 'blog-revise.log'), 'a');
    const child = spawn(process.execPath, ['services/blog-generator.js', '--revise', slug], {
      cwd: path.join(__dirname, '..'),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
  } catch (e) {
    return res.status(500).json({ error: 'failed to start revision: ' + e.message });
  }
  res.json({ ok: true, status: 'revising' });
});

// Covered-topics ledger (generator dedup).
app.get('/covered-topics', (_req, res) => {
  res.json({ topics: db.prepare('SELECT * FROM covered_topics ORDER BY createdAt DESC').all() });
});
app.post('/covered-topics', (req, res) => {
  const { topicKey, title, slug } = req.body || {};
  if (!topicKey) return res.status(400).json({ error: 'topicKey required' });
  db.prepare('INSERT OR IGNORE INTO covered_topics (topicKey, title, slug, createdAt) VALUES (?,?,?,?)')
    .run(topicKey, title || null, slug || null, new Date().toISOString());
  res.json({ ok: true });
});

// Generation-run audit log.
app.post('/gen-runs', (req, res) => {
  const { day, status, reason, slug } = req.body || {};
  db.prepare('INSERT INTO gen_runs (day, status, reason, slug, createdAt) VALUES (?,?,?,?,?)')
    .run(day || null, status || null, reason || null, slug || null, new Date().toISOString());
  res.json({ ok: true });
});
app.get('/gen-runs', (_req, res) => {
  res.json({ runs: db.prepare('SELECT * FROM gen_runs ORDER BY id DESC LIMIT 30').all() });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[blog-api] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
});
