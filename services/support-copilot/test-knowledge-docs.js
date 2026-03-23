#!/usr/bin/env node
/**
 * Integration test: Knowledge Documents API
 * Tests CRUD operations, filesystem sync, and TOOLS.md auto-update.
 *
 * Run: node e2e/test-knowledge-docs.js
 */

const API = process.env.SUPPORT_API_URL || 'http://localhost:3005';
const SECRET = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '';
const BRAND = 'turbo_station';
const fs = require('fs');
const path = require('path');

const headers = {
  'Content-Type': 'application/json',
  ...(SECRET ? { 'x-api-secret': SECRET } : {}),
};

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

async function api(method, path, body) {
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log('\n🧪 Knowledge Documents API — Integration Test\n');

  // ─── 1. GET — list (should auto-seed from filesystem) ───────────────

  console.log('1️⃣  GET /knowledge-docs (auto-seed)');
  const { status: listStatus, data: listData } = await api('GET',
    `/api/support/settings/${BRAND}/knowledge-docs`);
  assert(listStatus === 200, `Status 200 (got ${listStatus})`);
  assert(Array.isArray(listData), 'Returns array');
  assert(listData.length >= 4, `Seeded at least 4 docs (got ${listData.length})`);

  // Verify seed categories
  const slugs = new Set(listData.map(d => d.slug));
  assert(slugs.has('app'), 'Seeded: app.md');
  assert(slugs.has('estacoes'), 'Seeded: estacoes.md');
  assert(slugs.has('precos-planos'), 'Seeded: precos-planos.md');
  assert(slugs.has('problemas-comuns'), 'Seeded: problemas-comuns.md');

  const appDoc = listData.find(d => d.slug === 'app');
  assert(appDoc.category === 'faq', `app.md category is "faq" (got "${appDoc.category}")`);

  // ─── 2. POST — create a new document ────────────────────────────────

  console.log('\n2️⃣  POST /knowledge-docs (create)');
  const { status: createStatus, data: created } = await api('POST',
    `/api/support/settings/${BRAND}/knowledge-docs`, {
      title: 'Teste E2E',
      content: '# Teste E2E\n\nConteúdo de teste para validação end-to-end.',
      category: 'general',
    });
  assert(createStatus === 201, `Status 201 (got ${createStatus})`);
  assert(created.id?.startsWith('kdoc_'), `ID starts with kdoc_ (got "${created.id}")`);
  assert(created.slug === 'teste-e2e', `Slug is "teste-e2e" (got "${created.slug}")`);
  assert(created.is_active === 1, 'Created as active');
  assert(created.title === 'Teste E2E', `Title matches (got "${created.title}")`);

  const createdId = created.id;

  // Verify filesystem sync
  const knowledgeDir = path.join(process.env.HOME, '.openclaw', 'workspace-support-turbo_station', 'knowledge');
  const createdFile = path.join(knowledgeDir, 'teste-e2e.md');
  assert(fs.existsSync(createdFile), 'File created on disk: teste-e2e.md');
  if (fs.existsSync(createdFile)) {
    const content = fs.readFileSync(createdFile, 'utf8');
    assert(content.includes('# Teste E2E'), 'File content matches');
  }

  // Verify TOOLS.md updated
  const toolsPath = path.join(process.env.HOME, '.openclaw', 'workspace-support-turbo_station', 'TOOLS.md');
  if (fs.existsSync(toolsPath)) {
    const tools = fs.readFileSync(toolsPath, 'utf8');
    assert(tools.includes('teste-e2e.md'), 'TOOLS.md lists new doc');
  }

  // ─── 3. POST — slug collision ───────────────────────────────────────

  console.log('\n3️⃣  POST /knowledge-docs (slug collision)');
  const { status: dupeStatus, data: dupeData } = await api('POST',
    `/api/support/settings/${BRAND}/knowledge-docs`, {
      title: 'Teste E2E',  // Same slug
      content: 'Duplicado',
      category: 'faq',
    });
  assert(dupeStatus === 409, `Status 409 conflict (got ${dupeStatus})`);
  assert(dupeData.error?.includes('already exists'), `Error mentions exists (got "${dupeData.error}")`);

  // ─── 4. PUT — update document ───────────────────────────────────────

  console.log('\n4️⃣  PUT /knowledge-docs/:docId (update)');
  const { status: updateStatus, data: updated } = await api('PUT',
    `/api/support/settings/${BRAND}/knowledge-docs/${createdId}`, {
      title: 'Teste E2E Atualizado',
      content: '# Teste E2E Atualizado\n\nConteúdo editado.',
      category: 'troubleshooting',
    });
  assert(updateStatus === 200, `Status 200 (got ${updateStatus})`);
  assert(updated.slug === 'teste-e2e-atualizado', `Slug updated (got "${updated.slug}")`);
  assert(updated.category === 'troubleshooting', `Category updated (got "${updated.category}")`);

  // Old file should be gone, new file should exist
  assert(!fs.existsSync(createdFile), 'Old file removed from disk');
  const updatedFile = path.join(knowledgeDir, 'teste-e2e-atualizado.md');
  assert(fs.existsSync(updatedFile), 'New file created on disk: teste-e2e-atualizado.md');

  // ─── 5. PATCH — toggle inactive ────────────────────────────────────

  console.log('\n5️⃣  PATCH /knowledge-docs/:docId (toggle inactive)');
  const { status: patchStatus, data: patched } = await api('PATCH',
    `/api/support/settings/${BRAND}/knowledge-docs/${createdId}`, {
      is_active: false,
    });
  assert(patchStatus === 200, `Status 200 (got ${patchStatus})`);
  assert(patched.is_active === 0, `is_active is 0 (got ${patched.is_active})`);
  assert(!fs.existsSync(updatedFile), 'File removed from disk when deactivated');

  // TOOLS.md should no longer list it
  if (fs.existsSync(toolsPath)) {
    const tools2 = fs.readFileSync(toolsPath, 'utf8');
    assert(!tools2.includes('teste-e2e-atualizado.md'), 'TOOLS.md no longer lists deactivated doc');
  }

  // ─── 6. PATCH — re-activate ────────────────────────────────────────

  console.log('\n6️⃣  PATCH /knowledge-docs/:docId (re-activate)');
  const { status: reactivateStatus, data: reactivated } = await api('PATCH',
    `/api/support/settings/${BRAND}/knowledge-docs/${createdId}`, {
      is_active: true,
    });
  assert(reactivateStatus === 200, `Status 200 (got ${reactivateStatus})`);
  assert(reactivated.is_active === 1, `is_active is 1 (got ${reactivated.is_active})`);
  assert(fs.existsSync(updatedFile), 'File restored on disk when re-activated');

  // ─── 7. DELETE — remove document ───────────────────────────────────

  console.log('\n7️⃣  DELETE /knowledge-docs/:docId');
  const { status: deleteStatus, data: deleted } = await api('DELETE',
    `/api/support/settings/${BRAND}/knowledge-docs/${createdId}`);
  assert(deleteStatus === 200, `Status 200 (got ${deleteStatus})`);
  assert(deleted.ok === true, 'Response ok: true');
  assert(!fs.existsSync(updatedFile), 'File removed from disk after delete');

  // Verify it's gone from list
  const { data: finalList } = await api('GET',
    `/api/support/settings/${BRAND}/knowledge-docs`);
  assert(!finalList.find(d => d.id === createdId), 'Doc no longer in list');

  // ─── 8. Verify original docs untouched ─────────────────────────────

  console.log('\n8️⃣  Verify original docs untouched');
  assert(finalList.length >= 4, `Still have at least 4 docs (got ${finalList.length})`);
  const originalSlugs = ['app', 'estacoes', 'precos-planos', 'problemas-comuns'];
  for (const slug of originalSlugs) {
    const file = path.join(knowledgeDir, `${slug}.md`);
    assert(fs.existsSync(file), `Original file still on disk: ${slug}.md`);
  }

  // ─── Summary ────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
