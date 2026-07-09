#!/usr/bin/env node
/**
 * nextjs-deploy-trigger.js — detect a new PRODUCTION deploy of the Next.js
 * backend and POST it to /api/deploy-watch/start (once per sha).
 *
 * The Vercel log drain carries NO deploy-lifecycle event and NO git sha, so we
 * detect deploys by polling the prod app's reported build sha (/api/version) and
 * firing on a change. Dedupes on the sha via a state file. Secret + prod URL come
 * from the skill .env (loaded by pm2 ecosystem). Never hardcode secrets.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = (process.env.DASHBOARD_URL || 'https://www.turbostation.com.br').replace(/\/+$/, '');
const SECRET = process.env.MONITOR_API_SECRET || process.env.SUPPORT_API_SECRET || '';
const STATE = path.join(__dirname, '..', 'db', 'nextjs-deploy-trigger.state');

function log(...a) { console.log(new Date().toISOString(), '[nextjs-deploy-trigger]', ...a); }

async function currentSha() {
  try {
    const r = await fetch(`${BASE}/api/version`, { method: 'GET', redirect: 'manual' });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const sha = j && (j.sha || j.commit || j.gitCommitSha);
      if (sha && String(sha).length >= 4 && String(sha) !== 'unknown') return String(sha);
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch(`${BASE}/`, { method: 'HEAD', redirect: 'manual' });
    const id = r.headers.get('x-vercel-id') || r.headers.get('x-vercel-deployment-url');
    if (id) {
      const slug = String(id).split('::').pop().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      if (slug.length >= 4) return slug;
    }
  } catch { /* ignore */ }
  return null;
}

async function fire(sha) {
  const body = JSON.stringify({ sha, deployedAt: new Date().toISOString(), environment: 'production' });
  const r = await fetch(`${BASE}/api/deploy-watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-secret': SECRET },
    body,
  });
  const txt = await r.text().catch(() => '');
  log(`POST /api/deploy-watch/start sha=${sha} -> ${r.status} ${txt.slice(0, 200)}`);
  return r.status === 201 || r.status === 200;
}

async function main() {
  if (!SECRET) { log('no MONITOR_API_SECRET/SUPPORT_API_SECRET set — abort'); process.exit(1); }
  const sha = await currentSha();
  if (!sha) { log('could not determine current sha — skip'); return; }
  const last = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8').trim() : '';
  if (!last) {
    fs.writeFileSync(STATE, sha);
    log(`seed state=${sha} (no fire)`);
    return;
  }
  if (sha === last) { log(`no change (sha=${sha})`); return; }
  fs.writeFileSync(STATE, sha);
  const ok = await fire(sha);
  log(ok ? `fired for new deploy ${last} -> ${sha}` : `fire FAILED for ${sha} (state already advanced)`);
}

main().catch((e) => { log('error', e && e.message); process.exit(1); });
