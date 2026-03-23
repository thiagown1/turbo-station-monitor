/**
 * Settings routes — /api/support/settings
 * GET  /api/support/settings/:brandId  → fetch copilot settings
 * PUT  /api/support/settings/:brandId  → upsert copilot settings
 */

const { Router } = require('express');
const { db, nowIso } = require('../lib/db');

const router = Router();
const LOG_TAG = '[support-copilot]';

// Default tone rules (used when no custom settings exist)
const DEFAULT_TONE_RULES = `- Escreva como um humano real no WhatsApp, curto e direto
- Espelhe o tom do cliente — se ele é informal, seja informal
- PROIBIDO soar como IA/chatbot: nada de "Boa!", "Compreendo", "Ficarei feliz em ajudar"
- Use abreviações naturais: "vc", "tá", "pra", "oq", "dps"
- Máximo 1-2 linhas. Sem cumprimentos desnecessários.
- Comece respondendo, não cumprimentando`;

const DEFAULT_BUSINESS_INFO = `Turbo Station — Rede de carregamento para veículos elétricos
- Horário de atendimento: 8h-22h
- Suporte técnico: remoto e presencial
- Pagamento: PIX, cartão de crédito, créditos no app`;

// ─── GET settings ─────────────────────────────────────────────────────────────

router.get('/:brandId', (req, res) => {
  const { brandId } = req.params;

  const row = db.prepare('SELECT * FROM copilot_settings WHERE brand_id = ?').get(brandId);

  if (!row) {
    return res.json({
      brand_id: brandId,
      tone_rules: DEFAULT_TONE_RULES,
      business_info: DEFAULT_BUSINESS_INFO,
      quick_replies: [],
      auto_suggest: false,
      auto_respond: false,
      is_default: true,
    });
  }

  let quickReplies = [];
  try {
    quickReplies = JSON.parse(row.quick_replies_json || '[]');
  } catch {}

  res.json({
    brand_id: row.brand_id,
    tone_rules: row.tone_rules || DEFAULT_TONE_RULES,
    business_info: row.business_info || DEFAULT_BUSINESS_INFO,
    quick_replies: quickReplies,
    auto_suggest: !!row.auto_suggest,
    auto_respond: !!row.auto_respond,
    is_default: false,
    updated_at: row.updated_at,
  });
});

// ─── PUT settings ─────────────────────────────────────────────────────────────

router.put('/:brandId', (req, res) => {
  const { brandId } = req.params;
  const { tone_rules, business_info, quick_replies, auto_suggest, auto_respond } = req.body;

  const now = nowIso();
  const quickRepliesJson = JSON.stringify(quick_replies || []);

  db.prepare(`
    INSERT INTO copilot_settings (brand_id, tone_rules, business_info, quick_replies_json, auto_suggest, auto_respond, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(brand_id) DO UPDATE SET
      tone_rules = excluded.tone_rules,
      business_info = excluded.business_info,
      quick_replies_json = excluded.quick_replies_json,
      auto_suggest = excluded.auto_suggest,
      auto_respond = excluded.auto_respond,
      updated_at = excluded.updated_at
  `).run(brandId, tone_rules || '', business_info || '', quickRepliesJson, auto_suggest ? 1 : 0, auto_respond ? 1 : 0, now);

  // Invalidate all session contexts for this brand so the next suggestion
  // sends the full context with the updated rules
  const invalidated = db.prepare(`
    DELETE FROM session_context
    WHERE conversation_id IN (
      SELECT id FROM conversations WHERE brand_id = ?
    )
  `).run(brandId);

  console.log(`${LOG_TAG} Settings updated for brand ${brandId} — ${invalidated.changes} session(s) invalidated`);

  res.json({
    brand_id: brandId,
    tone_rules,
    business_info,
    quick_replies: quick_replies || [],
    auto_suggest: !!auto_suggest,
    auto_respond: !!auto_respond,
    updated_at: now,
  });
});

// ─── Learned Rules ────────────────────────────────────────────────────────────

// GET all learned rules for a brand
router.get('/:brandId/learned-rules', (req, res) => {
  const { brandId } = req.params;
  const rules = db.prepare(
    'SELECT * FROM copilot_learned_rules WHERE brand_id = ? ORDER BY created_at DESC'
  ).all(brandId);
  res.json(rules);
});

// DELETE a learned rule
router.delete('/:brandId/learned-rules/:ruleId', (req, res) => {
  db.prepare('DELETE FROM copilot_learned_rules WHERE id = ? AND brand_id = ?')
    .run(req.params.ruleId, req.params.brandId);
  res.json({ ok: true });
});

// PATCH — toggle rule status (active/inactive)
router.patch('/:brandId/learned-rules/:ruleId', (req, res) => {
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'status must be active|inactive' });
  }
  db.prepare('UPDATE copilot_learned_rules SET status = ? WHERE id = ? AND brand_id = ?')
    .run(status, req.params.ruleId, req.params.brandId);
  res.json({ ok: true });
});

// ─── Analyze Edit (returns rule without saving) ───────────────────────────────

const { analyzeEdit, saveLearnedRule } = require('../lib/copilot');

router.post('/:brandId/analyze-edit', async (req, res) => {
  const { brandId } = req.params;
  const { original, edited, conversationId } = req.body;

  if (!original || !edited) {
    return res.status(400).json({ error: 'original and edited are required' });
  }

  try {
    const result = await analyzeEdit(brandId, original, edited, conversationId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Save Rule (after user confirmed the analysis) ───────────────────────────

router.post('/:brandId/save-rule', (req, res) => {
  const { brandId } = req.params;
  const { rule_text, original, edited, suggestion_id } = req.body;

  if (!rule_text) {
    return res.status(400).json({ error: 'rule_text is required' });
  }

  try {
    const id = saveLearnedRule(brandId, rule_text, original || '', edited || '', suggestion_id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Knowledge Documents ──────────────────────────────────────────────────────

const { agentForBrand } = require('../lib/copilot');
const fs = require('fs');
const path = require('path');

/**
 * Resolve the knowledge/ directory path for a brand's agent workspace.
 * OpenClaw workspace naming: agent "support_turbo_station" → dir "workspace-support-turbo_station"
 * (first underscore between prefix and brand becomes hyphen, rest preserved)
 * We try multiple patterns to be resilient to naming variations.
 */
function knowledgeDirForBrand(brandId) {
  const agentId = agentForBrand(brandId);
  const base = path.join(process.env.HOME || '/home/openclaw', '.openclaw');

  // Try multiple naming patterns (OpenClaw isn't 100% consistent)
  const candidates = [
    `workspace-${agentId.replace(/_/, '-')}`, // support_turbo_station → workspace-support-turbo_station
    `workspace-${agentId}`,                    // workspace-support_turbo_station (literal)
    `workspace-${agentId.replace(/_/g, '-')}`, // workspace-support-turbo-station (all hyphens)
  ];

  for (const dir of candidates) {
    const knowledgePath = path.join(base, dir, 'knowledge');
    if (fs.existsSync(path.join(base, dir))) {
      return knowledgePath;
    }
  }

  // Fallback to the first pattern (will be created if needed)
  return path.join(base, candidates[0], 'knowledge');
}

/**
 * Generate a slug from a title.
 * "Problemas Comuns" → "problemas-comuns"
 */
function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s-]/g, '')                     // remove special chars
    .trim()
    .replace(/\s+/g, '-')                              // spaces → hyphens
    .replace(/-+/g, '-');                               // collapse hyphens
}

/**
 * Sync active knowledge docs from DB → filesystem.
 * Writes active docs as .md files and removes inactive/deleted ones.
 * Also regenerates TOOLS.md to list available knowledge files.
 */
function syncKnowledgeFiles(brandId) {
  const knowledgeDir = knowledgeDirForBrand(brandId);

  // Ensure directory exists
  try {
    fs.mkdirSync(knowledgeDir, { recursive: true });
  } catch (err) {
    console.warn(`${LOG_TAG} Failed to create knowledge dir ${knowledgeDir}:`, err.message);
    return;
  }

  // Get all docs from DB (active and inactive) 
  const allDocs = db.prepare(
    'SELECT slug, content, is_active FROM copilot_knowledge_docs WHERE brand_id = ?'
  ).all(brandId);

  const activeSlugs = new Set();

  for (const doc of allDocs) {
    const filePath = path.join(knowledgeDir, `${doc.slug}.md`);
    if (doc.is_active) {
      // Write active doc to filesystem
      try {
        fs.writeFileSync(filePath, doc.content, 'utf8');
        activeSlugs.add(doc.slug);
        console.log(`${LOG_TAG} Knowledge file synced: ${doc.slug}.md`);
      } catch (err) {
        console.warn(`${LOG_TAG} Failed to write ${filePath}:`, err.message);
      }
    } else {
      // Remove inactive doc from filesystem
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`${LOG_TAG} Knowledge file removed (inactive): ${doc.slug}.md`);
        }
      } catch (err) {
        console.warn(`${LOG_TAG} Failed to remove ${filePath}:`, err.message);
      }
    }
  }

  // Update TOOLS.md to list available knowledge files
  updateToolsMd(brandId, activeSlugs);
}

/**
 * Regenerate TOOLS.md to list currently available knowledge files.
 */
function updateToolsMd(brandId, activeSlugs) {
  // Derive workspace dir from knowledgeDirForBrand (go up one level from knowledge/)
  const knowledgeDir = knowledgeDirForBrand(brandId);
  const workspaceDir = path.dirname(knowledgeDir);
  const toolsPath = path.join(workspaceDir, 'TOOLS.md');

  // Get active docs with titles for better listing
  const activeDocs = db.prepare(
    'SELECT slug, title, category FROM copilot_knowledge_docs WHERE brand_id = ? AND is_active = 1 ORDER BY category, title'
  ).all(brandId);

  const fileList = activeDocs.map(d => `- \`knowledge/${d.slug}.md\` — ${d.title}`).join('\n');

  const toolsContent = `# TOOLS.md - Ferramentas do Copiloto de Suporte

## Ferramentas Disponíveis

Este agente tem acesso **restrito** para segurança. Apenas:

- \`read\` — ler arquivos da base de conhecimento (\`knowledge/\`)
- \`memory_search\` / \`memory_get\` — consultar memória do agente
- \`web_search\` — buscas básicas (usar com moderação)

## Ferramentas NÃO Disponíveis

- Não execute comandos no servidor (\`exec\`, \`shell\`, etc.)
- Não acesse bancos de dados diretamente
- Não envie mensagens diretamente ao cliente (o operador faz isso)
- Não acesse APIs externas

## Base de Conhecimento

Antes de gerar uma sugestão, **leia os arquivos relevantes** em \`knowledge/\`:

${fileList || '- _(nenhum documento cadastrado)_'}
`;

  try {
    fs.writeFileSync(toolsPath, toolsContent, 'utf8');
    console.log(`${LOG_TAG} TOOLS.md updated for agent ${agentId} (${activeDocs.length} docs)`);
  } catch (err) {
    console.warn(`${LOG_TAG} Failed to update TOOLS.md:`, err.message);
  }
}

// Helper to generate unique IDs
function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// GET all knowledge docs for a brand
router.get('/:brandId/knowledge-docs', (req, res) => {
  const { brandId } = req.params;

  let docs = db.prepare(
    'SELECT * FROM copilot_knowledge_docs WHERE brand_id = ? ORDER BY category, title'
  ).all(brandId);

  // Auto-seed from existing filesystem files if table is empty for this brand
  if (docs.length === 0) {
    docs = seedFromFilesystem(brandId);
  }

  res.json(docs);
});

// POST — create a new knowledge doc
router.post('/:brandId/knowledge-docs', (req, res) => {
  const { brandId } = req.params;
  const { title, content, category } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' });
  }

  const slug = slugify(title);
  const now = nowIso();
  const id = randomId('kdoc');

  // Check for slug collision
  const existing = db.prepare(
    'SELECT id FROM copilot_knowledge_docs WHERE brand_id = ? AND slug = ?'
  ).get(brandId, slug);
  if (existing) {
    return res.status(409).json({ error: `Document with slug "${slug}" already exists` });
  }

  db.prepare(`
    INSERT INTO copilot_knowledge_docs (id, brand_id, title, slug, content, category, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, brandId, title, slug, content, category || 'general', now, now);

  syncKnowledgeFiles(brandId);

  const doc = db.prepare('SELECT * FROM copilot_knowledge_docs WHERE id = ?').get(id);
  res.status(201).json(doc);
});

// PUT — update an existing knowledge doc
router.put('/:brandId/knowledge-docs/:docId', (req, res) => {
  const { brandId, docId } = req.params;
  const { title, content, category } = req.body;

  const existing = db.prepare(
    'SELECT * FROM copilot_knowledge_docs WHERE id = ? AND brand_id = ?'
  ).get(docId, brandId);
  if (!existing) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const now = nowIso();
  const newSlug = title ? slugify(title) : existing.slug;

  // Check for slug collision with OTHER docs
  if (newSlug !== existing.slug) {
    const collision = db.prepare(
      'SELECT id FROM copilot_knowledge_docs WHERE brand_id = ? AND slug = ? AND id != ?'
    ).get(brandId, newSlug, docId);
    if (collision) {
      return res.status(409).json({ error: `Document with slug "${newSlug}" already exists` });
    }

    // Remove old file if slug changed
    const knowledgeDir = knowledgeDirForBrand(brandId);
    const oldPath = path.join(knowledgeDir, `${existing.slug}.md`);
    try {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch {}
  }

  db.prepare(`
    UPDATE copilot_knowledge_docs
    SET title = ?, slug = ?, content = ?, category = ?, updated_at = ?
    WHERE id = ? AND brand_id = ?
  `).run(
    title || existing.title,
    newSlug,
    content !== undefined ? content : existing.content,
    category || existing.category,
    now,
    docId, brandId
  );

  syncKnowledgeFiles(brandId);

  const doc = db.prepare('SELECT * FROM copilot_knowledge_docs WHERE id = ?').get(docId);
  res.json(doc);
});

// DELETE — remove a knowledge doc
router.delete('/:brandId/knowledge-docs/:docId', (req, res) => {
  const { brandId, docId } = req.params;

  const existing = db.prepare(
    'SELECT slug FROM copilot_knowledge_docs WHERE id = ? AND brand_id = ?'
  ).get(docId, brandId);

  if (existing) {
    // Remove file
    const knowledgeDir = knowledgeDirForBrand(brandId);
    const filePath = path.join(knowledgeDir, `${existing.slug}.md`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}

    db.prepare('DELETE FROM copilot_knowledge_docs WHERE id = ? AND brand_id = ?')
      .run(docId, brandId);

    syncKnowledgeFiles(brandId);
  }

  res.json({ ok: true });
});

// PATCH — toggle a knowledge doc active/inactive
router.patch('/:brandId/knowledge-docs/:docId', (req, res) => {
  const { brandId, docId } = req.params;
  const { is_active } = req.body;

  if (is_active === undefined) {
    return res.status(400).json({ error: 'is_active is required' });
  }

  db.prepare(
    'UPDATE copilot_knowledge_docs SET is_active = ?, updated_at = ? WHERE id = ? AND brand_id = ?'
  ).run(is_active ? 1 : 0, nowIso(), docId, brandId);

  syncKnowledgeFiles(brandId);

  const doc = db.prepare('SELECT * FROM copilot_knowledge_docs WHERE id = ?').get(docId);
  res.json(doc);
});

/**
 * Seed knowledge docs from existing filesystem files.
 * Called automatically on first GET when table is empty for a brand.
 */
function seedFromFilesystem(brandId) {
  const knowledgeDir = knowledgeDirForBrand(brandId);

  if (!fs.existsSync(knowledgeDir)) return [];

  const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return [];

  const categoryMap = {
    'problemas-comuns': 'troubleshooting',
    'app': 'faq',
    'precos-planos': 'policy',
    'estacoes': 'general',
  };

  const now = nowIso();
  const docs = [];

  for (const file of files) {
    const slug = file.replace('.md', '');
    const filePath = path.join(knowledgeDir, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch { continue; }

    // Extract title from first heading or use slug
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const id = randomId('kdoc');
    const category = categoryMap[slug] || 'general';

    try {
      db.prepare(`
        INSERT INTO copilot_knowledge_docs (id, brand_id, title, slug, content, category, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, brandId, title, slug, content, category, now, now);
      docs.push({ id, brand_id: brandId, title, slug, content, category, is_active: 1, created_at: now, updated_at: now });
      console.log(`${LOG_TAG} Seeded knowledge doc: ${slug} (${category})`);
    } catch (err) {
      console.warn(`${LOG_TAG} Failed to seed ${slug}:`, err.message);
    }
  }

  console.log(`${LOG_TAG} Seeded ${docs.length} knowledge docs for brand ${brandId}`);
  return docs;
}

module.exports = router;

