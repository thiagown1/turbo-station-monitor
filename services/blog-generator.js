#!/usr/bin/env node
/**
 * Turbo Station blog-generator
 *
 * Daily job (pm2 cron_restart): pick a topic, write a post with `claude -p`,
 * have a second `claude -p` editor adversarially review it, and — only if it
 * clears the bar — store it in the blog-api (draft-first). The editor is allowed
 * to HOLD the day (publish nothing) rather than ship a weak post.
 *
 * Runs once per invocation and exits (pm2 schedules it). Talks to the local
 * blog-api over loopback with the shared secret; never touches prod Firestore.
 *
 * Flags: --dry (generate + review, do not write) | --force (ignore today's stamp)
 *
 * Env: BLOG_API_KEY (required), BLOG_API_BASE_LOCAL (default 127.0.0.1:3300),
 *      CLAUDE_BIN, NEXT_BLOG_DATA_URL (optional data moat), NEXT_REVALIDATE_URL
 *      (optional; called on autopublish).
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/openclaw/.npm-global/bin/claude';
const API = (process.env.BLOG_API_BASE_LOCAL || 'http://127.0.0.1:3300').replace(/\/+$/, '');
const KEY = (process.env.BLOG_API_KEY || '').trim();
const DATA_URL = (process.env.NEXT_BLOG_DATA_URL || '').trim();
const REVALIDATE_URL = (process.env.NEXT_REVALIDATE_URL || '').trim();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const log = (...a) => console.log(new Date().toISOString(), '[blog-gen]', ...a);

// High-value, business-relevant pt-BR topics (regulations, incentives, guides).
// Each is only written once (deduped via the covered_topics ledger).
const BACKLOG = [
  'Carro elétrico vale a pena no Brasil? Custos, economia e autonomia',
  'Incentivos e isenções fiscais para carros elétricos no Brasil',
  'IPVA para carros elétricos: regras e isenções por estado',
  'Como instalar um carregador de carro elétrico em casa',
  'Carregador de carro elétrico em condomínio: regras, custo e instalação',
  'Carregamento rápido DC vs carregamento AC: diferenças e quando usar cada um',
  'Tipos de conectores de recarga no Brasil (Tipo 2, CCS, GB/T)',
  'Quanto tempo leva para carregar um carro elétrico',
  'Frota elétrica para empresas: economia, infraestrutura e gestão',
  'Como a regulação da ANEEL trata a recarga de veículos elétricos',
];

function slugify(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function api(method, path, body, attempt = 1) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      // `connection: close` avoids reusing a keep-alive socket that express may
      // have closed during the long (synchronous) claude -p calls.
      headers: { 'x-blog-api-key': KEY, connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json();
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return api(method, path, body, attempt + 1);
    }
    throw e;
  }
}

function claude(prompt) {
  const r = spawnSync(CLAUDE_BIN, ['-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 240000,
  });
  if (r.status !== 0) throw new Error(`claude failed: ${(r.stderr || r.error?.message || '').slice(0, 300)}`);
  return (r.stdout || '').trim();
}

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^﻿/, ''));
  if (!m) return { data: {}, body: raw.trim() };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    data[k] = v;
  }
  return { data, body: m[2].trim() };
}

function readingTime(md) {
  const words = md.replace(/[#>*_`~|\-]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function extractJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function fetchDataMoat() {
  if (!DATA_URL) return null;
  try {
    const res = await fetch(DATA_URL, { headers: { 'x-blog-api-key': KEY } });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j.networkAggregates) && j.networkAggregates.length ? j.networkAggregates : null;
  } catch { return null; }
}

function guidelinesBlock(guidelines, label) {
  return guidelines && guidelines.trim()
    ? `\n${label}:\n${guidelines.trim()}\n`
    : '';
}

function writerPrompt(topic, data, guidelines, related) {
  const dataBlock = data
    ? `\nDADOS REAIS DA NOSSA REDE (use SOMENTE estes números se citar dados; cite a mediana e o tamanho da amostra):\n${JSON.stringify(data).slice(0, 4000)}\n`
    : '\n(Sem dados numéricos disponíveis — escreva um guia útil e preciso sem inventar estatísticas específicas.)\n';
  const relatedBlock = (Array.isArray(related) && related.length)
    ? '\nPOSTS JÁ PUBLICADOS (linke 1-2 destes no corpo, se forem relacionados, no formato [titulo](/blog/slug); NÃO invente slugs):\n' +
      related.slice(0, 20).map((p) => `- ${p.title} -> /blog/${p.slug}`).join('\n') + '\n'
    : '';
  return `Você é redator de conteúdo da Turbo Station, uma REDE DE RECARGA PÚBLICA / EM DESTINO para carros elétricos no Brasil (estações em shoppings, condomínios, estacionamentos, rodovias). O conteúdo precisa ajudar o leitor E servir ao negócio da Turbo Station.
Escreva um artigo de blog em português do Brasil sobre: "${topic}".

Requisitos:
- Útil, preciso e acionável para motoristas/empresas brasileiras. Foco em ajudar e gerar tráfego de busca.
- ALINHAMENTO COM O NEGÓCIO (importante): trate recarga em casa e recarga pública/em destino como COMPLEMENTARES, nunca como concorrentes. NUNCA conclua que o carro elétrico "só vale a pena se carregar em casa", nem desencoraje a recarga pública. Destaque os cenários em que a recarga pública/em destino é essencial: viagens e estradas, quem mora em apartamento ou não tem tomada própria, recarga rápida (DC), recarregar enquanto faz compras/trabalha, frotas e condomínios. Posicione a conveniência e a confiança de autonomia que uma boa rede de recarga (como a Turbo Station) oferece. Cite a Turbo Station de forma natural quando fizer sentido.
- Seja honesto e equilibrado (não engane nem omita fatos), mas com enquadramento favorável ao negócio.
- NÃO invente leis, números, prazos ou estatísticas específicas. Se não tiver certeza de um número/lei, fale de forma geral.
- 600-900 palavras, headings H2/H3, listas quando útil, tom claro e confiável.
- Inclua links internos APENAS para rotas que existem de fato: /blog, a home / e o contato /#contato (âncora na home). NUNCA use /contato, /contact ou outras rotas inexistentes.
- Se a lista de POSTS JÁ PUBLICADOS (abaixo) trouxer algo relacionado, linke 1-2 deles naturalmente no corpo, no formato [titulo](/blog/slug).
- Termine com um resumo curto que reforce o valor da recarga pública/em destino.
${guidelinesBlock(guidelines, 'DIRETRIZES DA MARCA (nossas ideias — siga à risca)')}${dataBlock}${relatedBlock}
Responda APENAS com o arquivo markdown, começando EXATAMENTE com um bloco de frontmatter YAML:
---
title: "<título atraente, < 60 caracteres se possível>"
description: "<meta description 120-155 caracteres>"
category: "<uma categoria curta>"
tags: ["t1","t2","t3"]
---
<corpo em markdown>`;
}

function editorPrompt(topic, markdown, guidelines) {
  return `Você é editor-chefe rigoroso da Turbo Station (rede de recarga PÚBLICA / em destino). Revise criticamente o rascunho de blog abaixo (tópico: "${topic}").
Reprove se: contiver fatos/leis/estatísticas que parecem inventados ou não verificáveis; for raso/genérico demais; tiver erros de PT-BR; título/description ruins para SEO; menos de ~500 palavras; ou prometer algo enganoso; ou usar links internos para rotas inexistentes (as únicas válidas são /, /blog e /#contato).
Reprove TAMBÉM por desalinhamento com o negócio: se o post desencorajar ou depreciar a recarga pública/em destino, concluir que o carro elétrico só vale a pena carregando em casa, tratar recarga pública como mero "plano B", ou não posicionar o valor da recarga pública (e da Turbo Station) de forma natural. O post deve servir ao negócio da Turbo Station mantendo-se honesto e útil.
Aprove apenas conteúdo realmente útil, preciso, publicável E alinhado ao negócio.
${guidelinesBlock(guidelines, 'DIRETRIZES DA MARCA que o post DEVE respeitar (reprove se violar)')}
Responda APENAS com JSON:
{"approved": true|false, "reasons": ["..."], "fixes": ["..."]}

RASCUNHO:
${markdown.slice(0, 12000)}`;
}

async function recordRun(status, reason, slug) {
  try { await api('POST', '/gen-runs', { day: new Date().toISOString().slice(0, 10), status, reason, slug }); } catch {}
}

function revisePrompt(post, feedback, guidelines) {
  return `Você é redator da Turbo Station (rede de recarga PÚBLICA / em destino). Reescreva e MELHORE o artigo abaixo aplicando as considerações do revisor humano e as diretrizes da marca. Mantenha o que está bom; mude o que o feedback pede; preserve o foco em recarga pública/em destino.
${guidelinesBlock(guidelines, 'DIRETRIZES DA MARCA (siga à risca)')}
CONSIDERAÇÕES DO REVISOR (prioridade máxima):
${(feedback && feedback.trim()) || '(sem considerações específicas — melhore qualidade, clareza e alinhamento de negócio.)'}

ARTIGO ATUAL (título: "${post.title}"):
${(post.body || '').slice(0, 12000)}

Responda APENAS com o markdown revisado, começando EXATAMENTE com o frontmatter YAML:
---
title: "<título>"
description: "<meta description 120-155 caracteres>"
category: "<categoria>"
tags: ["t1","t2","t3"]
---
<corpo revisado em markdown>`;
}

async function runRevise(slug) {
  const cfg = await api('GET', '/config');
  const post = await api('GET', `/admin/posts/${encodeURIComponent(slug)}`);
  log(`revising "${slug}"${post.revisionFeedback ? ' with operator feedback' : ''}`);

  let markdown = claude(revisePrompt(post, post.revisionFeedback || '', cfg.guidelines));
  if (!markdown.startsWith('---')) markdown = claude(revisePrompt(post, post.revisionFeedback || '', cfg.guidelines));
  if (!markdown.startsWith('---')) {
    log('revise: writer output invalid; leaving post as draft');
    await api('POST', `/posts/${encodeURIComponent(slug)}/unpublish`).catch(() => {});
    return;
  }
  const verdict = extractJson(claude(editorPrompt(post.title, markdown, cfg.guidelines)));
  const { data: fm, body } = parseFrontmatter(markdown);
  await api('POST', '/posts', {
    slug, // keep the original slug so the revision replaces it in place
    title: (fm.title || post.title).toString(),
    description: (fm.description || post.description || '').toString(),
    date: post.date || new Date().toISOString().slice(0, 10),
    author: 'Equipe Turbo Station',
    category: (fm.category || post.category || 'Guias').toString(),
    tags: Array.isArray(fm.tags) ? fm.tags : post.tags || [],
    body,
    coverImage: post.coverImage || null, // preserve the existing cover across a text revision
    draft: true, // revisions land as draft for re-review
    status: 'draft',
    readingTime: readingTime(body),
    generationModel: 'claude -p (revise)',
    generationSources: post.generationSources || [],
  });
  await recordRun('revised', `editor_approved=${verdict?.approved}`, slug);
  log(`revised "${slug}" (editor approved=${verdict?.approved})`);
}

const HIGGSFIELD_BIN = process.env.HIGGSFIELD_BIN || '/usr/local/bin/higgsfield';
const IMG_PUBLIC_BASE = (process.env.BLOG_PUBLIC_BASE || 'https://logs.turbostation.com.br/blog/api').replace(/\/+$/, '');
const IMG_DB_PATH = process.env.BLOG_DB_PATH || path.join(__dirname, '..', 'db', 'blog.db');

function buildImagePrompt(style, category, sceneOverride) {
  const map = style.subjectByCategory || {};
  const subject = sceneOverride || map[category] || map.default || 'an electric car charging at a public charging station';
  const tpl = style.promptTemplate || '{style}, 16:9 aspect ratio. {subject}. {brandHint}. {negative}.';
  return tpl
    .replace('{style}', style.style || '')
    .replace('{subject}', subject)
    .replace('{brandHint}', style.brandHint || '')
    .replace('{negative}', style.negative || '');
}

// Turn a post title into a concrete, drawable illustration scene so the cover
// reflects the actual topic (not the generic per-category subject). Returns null
// on any problem; the caller then falls back to the category subject.
function coverSceneFromTopic(topic) {
  if (!topic) return null;
  try {
    const s = claude(`Para um artigo de blog intitulado "${topic}", descreva em UMA frase curta em inglês (máx 25 palavras) uma cena de ilustração CONCRETA e específica que represente o tema — com objetos e ação que remetam ao assunto, sempre incluindo um carro elétrico e uma estação de recarga pública. Responda só a cena, sem aspas e sem nenhum texto na imagem.`)
      .trim()
      .replace(/^["'\s]+|["'\s]+$/g, '');
    return s && s.length > 12 && s.length < 400 && !s.includes('\n') ? s : null;
  } catch {
    return null;
  }
}

// Generate a branded cover via the higgsfield CLI, optimize to webp, store the
// blob in blog.db, and return the public coverImage URL. Fail-soft: returns null
// on any problem (CLI missing/unauthed, gen/download/encode/db error) so the post
// is still created without a cover. No-ops when imageStyle is unset.
async function generateCoverImage(slug, category, imageStyleJson, topic) {
  try {
    if (!imageStyleJson) return null;
    const style = JSON.parse(imageStyleJson);
    if (!style || !style.style) return null;
    const st = spawnSync(HIGGSFIELD_BIN, ['account', 'status'], { encoding: 'utf8' });
    if (st.status !== 0) { log('cover: higgsfield CLI unavailable/unauthed — skipping image'); return null; }
    const scene = coverSceneFromTopic(topic);
    if (scene) log(`cover scene: ${scene.slice(0, 90)}`);
    const prompt = buildImagePrompt(style, category, scene);
    const r = spawnSync(HIGGSFIELD_BIN, ['generate', 'create', style.provider || 'recraft_v4_1',
      '--prompt', prompt, '--aspect_ratio', style.aspect_ratio || '16:9',
      '--resolution', style.resolution || '1k', '--model_type', style.model_type || 'standard',
      '--wait', '--wait-timeout', '8m', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) { log('cover: generate failed:', (r.stderr || r.stdout || '').slice(0, 200)); return null; }
    const url = (JSON.parse(r.stdout)[0] || {}).result_url;
    if (!url) { log('cover: no result_url in CLI output'); return null; }
    const dl = spawnSync('curl', ['-fsSL', url], { maxBuffer: 32 * 1024 * 1024 });
    if (!dl.stdout || !dl.stdout.length) { log('cover: download failed'); return null; }
    const sharp = require('sharp');
    let q = 86, webp;
    do { webp = await sharp(dl.stdout).resize({ width: 1344 }).webp({ quality: q }).toBuffer(); q -= 8; }
    while (webp.length > 200 * 1024 && q > 40);
    const hash = require('node:crypto').createHash('sha1').update(webp).digest('hex').slice(0, 8);
    const key = slug + '-' + hash + '.webp';
    const db = new (require('better-sqlite3'))(IMG_DB_PATH);
    db.exec("CREATE TABLE IF NOT EXISTS media (key TEXT PRIMARY KEY, slug TEXT, contentType TEXT DEFAULT 'image/webp', bytes BLOB NOT NULL, createdAt TEXT NOT NULL);");
    db.prepare('INSERT OR REPLACE INTO media (key, slug, contentType, bytes, createdAt) VALUES (?,?,?,?,?)')
      .run(key, slug, 'image/webp', webp, new Date().toISOString());
    db.prepare('DELETE FROM media WHERE slug = ? AND key != ?').run(slug, key);
    db.close();
    const cover = IMG_PUBLIC_BASE + '/media/' + key;
    log('cover: ' + Math.round(webp.length / 1024) + 'KB -> ' + cover);
    return cover;
  } catch (e) { log('cover: error —', ((e && e.message) || e).toString().slice(0, 200)); return null; }
}

// Regenerate ONLY the cover for an existing post (operator "gerar outra capa"),
// keeping the body/status. The new cover gets a fresh versioned key so caches bust.
async function runRegenCover(slug) {
  const cfg = await api('GET', '/config');
  const post = await api('GET', `/admin/posts/${encodeURIComponent(slug)}`);
  log(`regenerating cover for "${slug}"...`);
  const cover = await generateCoverImage(slug, post.category || 'Guias', cfg.imageStyle, post.title);
  if (!cover) { log('regen-cover: no cover produced (CLI unauthed or error)'); return; }
  await api('POST', '/posts', {
    slug,
    title: post.title,
    description: post.description || '',
    date: post.date,
    author: post.author || 'Equipe Turbo Station',
    category: post.category || 'Guias',
    tags: post.tags || [],
    body: post.body || '',
    coverImage: cover,
    draft: post.draft,
    status: post.status,
    readingTime: post.readingTime || 1,
    generationModel: post.generationModel || null,
    generationSources: post.generationSources || [],
  });
  await recordRun('cover_regen', 'manual', slug);
  log(`regenerated cover for "${slug}" -> ${cover}`);
}

async function main() {
  if (!KEY) throw new Error('BLOG_API_KEY is required');

  const reviseIdx = process.argv.indexOf('--revise');
  if (reviseIdx !== -1) {
    const slug = process.argv[reviseIdx + 1];
    if (!slug) throw new Error('--revise requires a slug');
    return runRevise(slug);
  }

  const regenIdx = process.argv.indexOf('--regen-cover');
  if (regenIdx !== -1) {
    const slug = process.argv[regenIdx + 1];
    if (!slug) throw new Error('--regen-cover requires a slug');
    return runRegenCover(slug);
  }

  const cfg = await api('GET', '/config');
  if (!cfg.enabled && !FORCE) { log('disabled via config; skipping'); await recordRun('skipped', 'disabled'); return; }

  const today = new Date().toISOString().slice(0, 10);
  if (!FORCE && !DRY) {
    const { runs } = await api('GET', '/gen-runs');
    if (runs.some((r) => r.day === today && (r.status === 'published' || r.status === 'held'))) {
      log('already ran today; skipping (use --force to override)');
      return;
    }
  }

  // Topic discovery: skip already-covered topics.
  const { topics: covered } = await api('GET', '/covered-topics');
  const coveredKeys = new Set(covered.map((t) => t.topicKey));
  const topic = BACKLOG.find((t) => !coveredKeys.has(slugify(t)));
  if (!topic) { log('backlog exhausted; nothing new to write'); await recordRun('skipped', 'backlog_exhausted'); return; }

  const data = await fetchDataMoat();
  const related = await api('GET', '/posts').then((r) => (r.posts || []).map((p) => ({ slug: p.slug, title: p.title }))).catch(() => []);
  log(`topic: ${topic}${data ? ' (with network data)' : ''}${related.length ? ` (+${related.length} related for internal links)` : ''}`);

  // Write -> review, one regen attempt.
  let markdown = null;
  let verdict = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`writing (attempt ${attempt})...`);
    markdown = claude(writerPrompt(topic, data, cfg.guidelines, related));
    if (!markdown.startsWith('---')) { log('writer output missing frontmatter; retrying'); continue; }
    log('editor reviewing...');
    verdict = extractJson(claude(editorPrompt(topic, markdown, cfg.guidelines)));
    if (verdict?.approved) break;
    log(`editor held: ${(verdict?.reasons || ['unparseable verdict']).join('; ')}`);
    verdict = verdict || { approved: false, reasons: ['unparseable verdict'] };
  }

  if (!verdict?.approved) {
    log('HOLD — not publishing today');
    await recordRun('held', (verdict?.reasons || []).join('; ').slice(0, 300));
    return;
  }

  const { data: fm, body } = parseFrontmatter(markdown);
  const title = (fm.title || topic).toString();
  const slug = slugify(title) || slugify(topic);
  const post = {
    slug,
    title,
    description: (fm.description || '').toString(),
    date: today,
    author: 'Equipe Turbo Station',
    category: (fm.category || 'Guias').toString(),
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    body,
    draft: !cfg.autopublish,
    status: cfg.autopublish ? 'published' : 'draft',
    readingTime: readingTime(body),
    generationModel: 'claude -p',
    generationSources: data ? ['network_aggregates'] : [],
  };

  if (DRY) { log('DRY run — would publish:', JSON.stringify({ slug, title, draft: post.draft, words: body.split(/\s+/).length })); return; }

  post.coverImage = (await generateCoverImage(post.slug, post.category, cfg.imageStyle, post.title)) || undefined;
  await api('POST', '/posts', post);
  await api('POST', '/covered-topics', { topicKey: slugify(topic), title: topic, slug });
  await recordRun(cfg.autopublish ? 'published' : 'held', cfg.autopublish ? 'published' : 'draft_pending_review', slug);
  log(`stored: ${slug} (${post.draft ? 'DRAFT — pending review' : 'PUBLISHED'})`);

  if (cfg.autopublish && REVALIDATE_URL) {
    try { await fetch(REVALIDATE_URL, { method: 'POST', headers: { 'x-blog-api-key': KEY } }); log('revalidate pinged'); } catch { log('revalidate ping failed (non-fatal)'); }
  }
}

module.exports = { generateCoverImage, buildImagePrompt };

if (require.main === module) {
  main().catch((e) => { log('ERROR:', e.message); recordRun('error', e.message.slice(0, 300)).finally(() => process.exit(1)); });
}
