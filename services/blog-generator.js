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

function writerPrompt(topic, data) {
  const dataBlock = data
    ? `\nDADOS REAIS DA NOSSA REDE (use SOMENTE estes números se citar dados; cite a mediana e o tamanho da amostra):\n${JSON.stringify(data).slice(0, 4000)}\n`
    : '\n(Sem dados numéricos disponíveis — escreva um guia útil e preciso sem inventar estatísticas específicas.)\n';
  return `Você é redator de conteúdo da Turbo Station, rede brasileira de estações de recarga para carros elétricos.
Escreva um artigo de blog em português do Brasil sobre: "${topic}".

Requisitos:
- Útil, preciso e acionável para motoristas/empresas brasileiras. Foco em ajudar e gerar tráfego de busca.
- NÃO invente leis, números, prazos ou estatísticas específicas. Se não tiver certeza de um número/lei, fale de forma geral.
- 600-900 palavras, headings H2/H3, listas quando útil, tom claro e confiável.
- Inclua 1 link interno para /blog e 1 para o app/contato quando fizer sentido (markdown).
- Termine com um resumo curto.
${dataBlock}
Responda APENAS com o arquivo markdown, começando EXATAMENTE com um bloco de frontmatter YAML:
---
title: "<título atraente, < 60 caracteres se possível>"
description: "<meta description 120-155 caracteres>"
category: "<uma categoria curta>"
tags: ["t1","t2","t3"]
---
<corpo em markdown>`;
}

function editorPrompt(topic, markdown) {
  return `Você é editor-chefe rigoroso. Revise criticamente o rascunho de blog abaixo (tópico: "${topic}").
Reprove se: contiver fatos/leis/estatísticas que parecem inventados ou não verificáveis; for raso/genérico demais; tiver erros de PT-BR; título/description ruins para SEO; menos de ~500 palavras; ou prometer algo enganoso.
Aprove apenas conteúdo realmente útil, preciso e publicável.

Responda APENAS com JSON:
{"approved": true|false, "reasons": ["..."], "fixes": ["..."]}

RASCUNHO:
${markdown.slice(0, 12000)}`;
}

async function recordRun(status, reason, slug) {
  try { await api('POST', '/gen-runs', { day: new Date().toISOString().slice(0, 10), status, reason, slug }); } catch {}
}

async function main() {
  if (!KEY) throw new Error('BLOG_API_KEY is required');

  const cfg = await api('GET', '/config');
  if (!cfg.enabled) { log('disabled via config; skipping'); await recordRun('skipped', 'disabled'); return; }

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
  log(`topic: ${topic}${data ? ' (with network data)' : ''}`);

  // Write -> review, one regen attempt.
  let markdown = null;
  let verdict = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`writing (attempt ${attempt})...`);
    markdown = claude(writerPrompt(topic, data));
    if (!markdown.startsWith('---')) { log('writer output missing frontmatter; retrying'); continue; }
    log('editor reviewing...');
    verdict = extractJson(claude(editorPrompt(topic, markdown)));
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

  await api('POST', '/posts', post);
  await api('POST', '/covered-topics', { topicKey: slugify(topic), title: topic, slug });
  await recordRun(cfg.autopublish ? 'published' : 'held', cfg.autopublish ? 'published' : 'draft_pending_review', slug);
  log(`stored: ${slug} (${post.draft ? 'DRAFT — pending review' : 'PUBLISHED'})`);

  if (cfg.autopublish && REVALIDATE_URL) {
    try { await fetch(REVALIDATE_URL, { method: 'POST', headers: { 'x-blog-api-key': KEY } }); log('revalidate pinged'); } catch { log('revalidate ping failed (non-fatal)'); }
  }
}

main().catch((e) => { log('ERROR:', e.message); recordRun('error', e.message.slice(0, 300)).finally(() => process.exit(1)); });
