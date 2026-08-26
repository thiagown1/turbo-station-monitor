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

/** A real build sha as reported by /api/version: 7-40 hex chars. */
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * The production build's git sha, or null when it cannot be determined.
 *
 * ONLY /api/version is trusted, and only when it answers something shaped like a
 * git sha. There used to be an `x-vercel-id` fallback here — that header carries
 * a per-REQUEST id (`<pop>-<timestamp>-<hash>`), NOT a deployment id, so it is
 * different on every single poll. One transient failure of /api/version was
 * therefore enough to look like a brand-new deploy: that is exactly what fired a
 * phantom 2h deploy-watch at 08:25Z on 2026-07-21 with sha
 * `7ncz8-1784622352485-f2df2ef2f245` (no Vercel deployment existed).
 *
 * Returning null just skips this tick. We poll every 60s and only fire on a
 * change, so a real deploy is still caught on the next poll — there is nothing
 * to gain from guessing.
 */
async function currentSha() {
  try {
    const r = await fetch(`${BASE}/api/version`, { method: 'GET', redirect: 'manual' });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const sha = j && (j.sha || j.commit || j.gitCommitSha);
      // GIT_SHA_RE also rejects the route's 'unknown' sentinel (non-hex chars).
      if (sha && GIT_SHA_RE.test(String(sha))) return String(sha);
    }
  } catch { /* fall through */ }
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
  const ok = await fire(sha);
  if (ok) {
    // Persist only on success — a failed fire leaves state at `last` so the
    // next poll retries this sha instead of silently skipping the deploy.
    fs.writeFileSync(STATE, sha);
    log(`fired for new deploy ${last} -> ${sha}`);
  } else {
    log(`fire FAILED for ${sha} (state not advanced, will retry next run)`);
  }
}

main().catch((e) => { log('error', e && e.message); process.exit(1); });
