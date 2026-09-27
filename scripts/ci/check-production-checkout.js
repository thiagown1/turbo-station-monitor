'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PRODUCTION_DIR = '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor';

function checkProductionCheckout(repoDir = PRODUCTION_DIR, runGit = execFileSync) {
  if (!fs.existsSync(repoDir)) {
    throw new Error(`production checkout is missing: ${repoDir}`);
  }
  const run = (args) => runGit('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
  const root = run(['rev-parse', '--show-toplevel']);
  if (path.resolve(root) !== path.resolve(repoDir)) {
    throw new Error(`expected production checkout at ${repoDir}, found ${root}`);
  }
  const dirty = run(['status', '--porcelain', '--untracked-files=all']);
  if (dirty) {
    const paths = dirty.split(/\r?\n/).slice(0, 10).join(', ');
    throw new Error(`production checkout is dirty; move reviewed changes into Git before merging: ${paths}`);
  }
  // Read main from the remote and fetch only its objects. Writing
  // refs/remotes/origin/main or FETCH_HEAD here races the auto-deploy's own
  // fetch in this same checkout ("cannot lock ref"), which on 2026-09-27 failed
  // this required check and left a merged commit undeployed.
  const mainSha = run(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (!/^[0-9a-f]{40,64}$/.test(mainSha)) throw new Error(`could not read origin main: ${mainSha}`);
  run(['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', 'origin', mainSha]);
  try {
    run(['merge-base', '--is-ancestor', 'HEAD', mainSha]);
  } catch {
    throw new Error('production HEAD diverges from origin/main; review local commits before merging');
  }
  return root;
}

if (require.main === module) {
  try {
    const root = checkProductionCheckout();
    console.log(`Production checkout clean: ${root}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkProductionCheckout };
