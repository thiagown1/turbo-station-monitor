#!/usr/bin/env node
/**
 * Auto-update GitHub Release notes for iOS TestFlight tags.
 *
 * Usage:
 *   node release-autonotes.js --repo thiagown1/turbo_station --tag ios/tf/2076
 *
 * Behavior:
 * - Finds previous ios/tf/* tag (by creatordate, excluding current)
 * - Collects merged PRs between prev..tag
 * - Generates human-oriented release notes + manual test checklist
 * - Edits the release title to "iOS TestFlight #<num>" and replaces body
 */

const { execSync } = require('child_process');

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') out.repo = args[++i];
    else if (a === '--tag') out.tag = args[++i];
  }
  if (!out.repo || !out.tag) {
    console.error('Missing --repo or --tag');
    process.exit(2);
  }
  return out;
}

function getPrevTag(tag) {
  const tags = sh(`git tag --list 'ios/tf/*' --sort=-creatordate`).split('\n').filter(Boolean);
  for (const t of tags) {
    if (t !== tag) return t;
  }
  return null;
}

function getMergedPrNumbers(prevTag, tag) {
  const log = sh(`git log --merges --pretty=format:%s ${prevTag}..${tag} || true`);
  const prs = [];
  for (const line of log.split('\n')) {
    const m = line.match(/Merge pull request #(\d+)/);
    if (m) prs.push(Number(m[1]));
  }
  // de-dupe keep order
  const seen = new Set();
  const uniq = [];
  for (const n of prs) {
    if (seen.has(n)) continue;
    seen.add(n);
    uniq.push(n);
  }
  return uniq;
}

function fetchPr(repo, n) {
  try {
    const raw = sh(
      `gh pr view ${n} --repo ${repo} --json number,title,url,labels,files --jq '{number,title,url,labels:[.labels[].name],files:[.files[].path]}'`
    );
    return JSON.parse(raw);
  } catch {
    return { number: n, title: '(failed to fetch)', url: `https://github.com/${repo}/pull/${n}`, labels: [], files: [] };
  }
}

function classify(pr) {
  const labels = new Set((pr.labels || []).map((x) => x.toLowerCase()));
  const files = pr.files || [];

  const isMobile = labels.has('mobile') || files.some((p) => p.startsWith('mobile/'));
  const isBackend = labels.has('backend') || files.some((p) => p.startsWith('next/'));
  const isOcpp = labels.has('ocpp') || files.some((p) => p.includes('ocpp'));
  const isCi = pr.title.toLowerCase().startsWith('ci:') || labels.has('ci') || files.some((p) => p.startsWith('.github/workflows'));
  const isTest = pr.title.toLowerCase().startsWith('test:') || labels.has('test');

  if (isMobile) return 'Mobile';
  if (isBackend) return 'Backend/Dashboard';
  if (isOcpp) return 'OCPP/Monitor';
  if (isCi || isTest) return 'CI/Qualidade';
  return 'Outros';
}

function buildManualTests(prs) {
  const files = prs.flatMap((p) => p.files || []);
  const tests = [];

  // Base checklist
  tests.push('Login/logout');
  tests.push('Abrir uma estação → entrar na tela do carregador');
  tests.push('Iniciar recarga (online) e validar que inicia no conector correto');
  tests.push('Finalizar sessão / voltar / reabrir app');

  // Heuristics
  if (files.some((p) => p.includes('onboard') || p.includes('login'))) {
    tests.push('Onboarding completo (cadastro/verificação)');
  }
  if (files.some((p) => p.toLowerCase().includes('transaction') || p.toLowerCase().includes('recharge') || p.toLowerCase().includes('charger_page'))) {
    tests.push('Start com rede instável (modo avião liga/desliga durante start)');
  }
  if (files.some((p) => p.toLowerCase().includes('coupon') || p.toLowerCase().includes('pricing'))) {
    tests.push('Cupons e precificação no carregador (tag promo / gráfico de agenda)');
  }
  if (files.some((p) => p.toLowerCase().includes('payments') || p.toLowerCase().includes('pix') || p.toLowerCase().includes('pagarme'))) {
    tests.push('Fluxo de pagamento (pix/cartão) — se aplicável');
  }

  // De-dupe
  return [...new Set(tests)];
}

function mdEscape(s) {
  return String(s || '').replace(/\r/g, '');
}

function main() {
  const { repo, tag } = parseArgs();

  // Ensure tags
  sh('git fetch --tags --force');

  const prev = getPrevTag(tag) || 'HEAD~50';
  const compareUrl = `https://github.com/${repo}/compare/${encodeURIComponent(prev)}...${encodeURIComponent(tag)}`;

  const prNums = prev.startsWith('ios/tf/') ? getMergedPrNumbers(prev, tag) : [];
  const prs = prNums.map((n) => fetchPr(repo, n));

  // Group PRs
  const buckets = new Map();
  for (const pr of prs) {
    const b = classify(pr);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(pr);
  }

  const runNumber = tag.split('/').pop();

  const manualTests = buildManualTests(prs);

  const lines = [];
  lines.push(`# iOS TestFlight #${runNumber}`);
  lines.push('');
  lines.push(`Tag: **${tag}**`);
  if (prev.startsWith('ios/tf/')) lines.push(`Base: **${prev}**`);
  lines.push('');

  lines.push('## O que mudou (por área)');
  if (!prs.length) {
    lines.push('- (sem PRs identificados entre as tags — ver compare técnico abaixo)');
  } else {
    for (const [bucket, arr] of buckets.entries()) {
      lines.push(`**${bucket}**`);
      for (const pr of arr) {
        lines.push(`- ${mdEscape(pr.title)} (PR #${pr.number})`);
      }
      lines.push('');
    }
  }

  lines.push('## Links (PRs)');
  if (prs.length) {
    for (const pr of prs) lines.push(`- #${pr.number} — ${mdEscape(pr.title)} — ${pr.url}`);
  } else {
    lines.push('- (ver compare técnico)');
  }
  lines.push('');

  lines.push('## Testes manuais (checklist)');
  for (const t of manualTests) lines.push(`- ${t}`);
  lines.push('');

  lines.push('## Changelog técnico (commits)');
  lines.push(`Compare: ${compareUrl}`);
  lines.push('');

  const body = lines.join('\n');

  // Write temp notes
  const tmp = `/tmp/release-notes-${runNumber}.md`;
  require('fs').writeFileSync(tmp, body);

  // Edit release
  sh(
    `gh release edit '${tag}' --repo ${repo} --title "iOS TestFlight #${runNumber}" --notes-file '${tmp}'`
  );

  console.log(JSON.stringify({ ok: true, repo, tag, prevTag: prev, prs: prNums.length }, null, 2));
}

main();
