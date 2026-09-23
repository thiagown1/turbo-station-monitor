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
