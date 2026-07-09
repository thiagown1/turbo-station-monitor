#!/usr/bin/env node
/**
 * Sweep Orchestrator — Serialized White-Label Validation Loop
 *
 * State machine:  SWEEP → IMPLEMENT → WAIT_CI → WAIT_REVIEW → MERGE → (repeat)
 * Exit condition:  SWEEP finds 0 issues → DONE
 * Merge gate:      Cycle N+1 only starts after ALL PRs from cycle N are merged
 *
 * Usage:
 *   node sweep-orchestrator.js              # Normal run (resumes from saved state)
 *   node sweep-orchestrator.js --reset      # Reset state and start fresh
 *   node sweep-orchestrator.js --status     # Show current status
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────
const STATE_PATH = path.join(__dirname, '..', 'state', 'sweep-loop.json');
const FINDINGS_PATH = path.join(__dirname, '..', 'state', 'sweep-findings.json');
const REPO = 'thiagown1/turbo_station';
const TARGET_BRANCH = 'final/white-label';
const TURBO_DIR = '/home/openclaw/.openclaw/workspace-coder/turbo_station';
const SCOUT_DIR = '/home/openclaw/.openclaw/workspace-scout/turbo_station';
const TELEGRAM_TARGET = '-5103508388';

const MAX_CYCLES = 10;
const BATCH_SIZE = 3;                            // Process findings in batches of 3
const POLL_INTERVAL_MS = 2 * 60 * 1000;        // 2 min between polls
const SCOUT_TIMEOUT_MS = 25 * 60 * 1000;        // 25 min for scout to finish
const IMPLEMENT_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per batch for PRs to appear
const CI_POLL_TIMEOUT_MS = 30 * 60 * 1000;      // 30 min per batch for CI
const REVIEW_POLL_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min per batch for reviews
const TOTAL_TIMEOUT_MS = 10 * 60 * 60 * 1000;   // 10 hours total hard stop
const CI_FIX_MAX_ATTEMPTS = 3;

const startTime = Date.now();

// ─── Utilities ─────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [sweep] ${msg}`);
}

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 60000, ...opts }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendTelegram(text) {
  try {
    const escaped = text.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    execSync(
      `openclaw message send --channel telegram --target "${TELEGRAM_TARGET}" --message "${escaped}"`,
      { timeout: 30000, stdio: 'pipe' }
    );
    log(`Telegram sent: ${text.substring(0, 60)}...`);
  } catch (err) {
    console.error(`[sweep] Telegram error: ${err.message?.substring(0, 100)}`);
  }
}

function isTimedOut() {
  return Date.now() - startTime > TOTAL_TIMEOUT_MS;
}

function disableCron(name) {
  try {
    exec(`openclaw cron disable ${name}`, { allowFail: true, timeout: 10000 });
    log(`Cron disabled: ${name}`);
  } catch (err) {
    log(`Cron disable failed for ${name}: ${err.message?.substring(0, 60)}`);
  }
}

function enableCron(name) {
  try {
    exec(`openclaw cron enable ${name}`, { allowFail: true, timeout: 10000 });
    log(`Cron re-enabled: ${name}`);
  } catch (err) {
    log(`Cron enable failed for ${name}: ${err.message?.substring(0, 60)}`);
  }
}

// Clean up: re-enable heartbeats on process exit
const SCOUT_CRON = 'f60e2e2d-3413-41c2-bc56-1d033af59f0e';  // scout-heartbeat-10m
const CODER_CRON = 'c0d3r-hb-30m-a1b2c3d4e5f6';              // coder-heartbeat-10m
function cleanupCrons() {
  enableCron(SCOUT_CRON);
  enableCron(CODER_CRON);
}
process.on('exit', cleanupCrons);
process.on('SIGINT', () => { cleanupCrons(); process.exit(130); });
process.on('SIGTERM', () => { cleanupCrons(); process.exit(143); });

// ─── State Management ──────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return createFreshState();
  }
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function createFreshState() {
  return {
    version: 1,
    status: 'SWEEP',
    cycle: 1,
    startedAt: new Date().toISOString(),
    currentCycle: null,
    history: [],
    config: { maxCycles: MAX_CYCLES, targetBranch: TARGET_BRANCH, repo: REPO },
  };
}

// ─── Phase: SWEEP ──────────────────────────────────────────────────

function buildSweepPrompt() {
  return `🌙 White-Label Night Sweep — Ciclo autônomo de validação.

Tu é o Scout do time. Tua missão é varrer o branch final/white-label e encontrar TODOS os problemas white-label restantes.

WORKSPACE: ${SCOUT_DIR}
BRANCH: ${TARGET_BRANCH}

═══ PASSO 1: ATUALIZAR CÓDIGO ═══
cd ${SCOUT_DIR} && git fetch origin && git checkout ${TARGET_BRANCH} && git pull origin ${TARGET_BRANCH}

═══ PASSO 2: LER A MATRIX ═══
cat ${SCOUT_DIR}/docs/WHITE_LABEL_MATRIX.md

═══ PASSO 3: SCANS INTELIGENTES ═══

Para cada scan, analise o CONTEXTO, não apenas a string. Use teu julgamento:

A) HARDCODED BRANDING
   Grep: grep -rn "Turbo Station\\|turbostation\\|TURBO_STATION" ${SCOUT_DIR}/next/app/ ${SCOUT_DIR}/next/lib/ ${SCOUT_DIR}/functions/src/ --include="*.ts" --include="*.tsx" --include="*.js" 2>/dev/null | grep -vi "test\\|spec\\|__test"
   Para cada hit, decida: é produção e deveria usar getBrandConfig()? Ou é config, tipo, comentário, import que é OK?
   REPORTAR APENAS produção real.

B) ROTAS SEM TENANT GUARD
   Listar routes: find ${SCOUT_DIR}/next/app/api -name "route.ts" -not -path "*/public/*" -not -path "*/webhook/*" -not -path "*/auth/*" -not -path "*/internal/*" -not -path "*/_*"
   Para cada: grep -l "enforceRequestBrand\\|enforceUserBrand\\|getRequestBrandId" <file> || echo "MISSING"
   REPORTAR rotas sem guard que manipulem dados de usuário, pagamento, ou estações.
   NÃO reportar rotas que são legitimamente cross-tenant (health checks, public endpoints).

C) PAGAMENTO SEM TENANT SCOPING
   Grep: grep -rn "process.env.PAGARME_\\|PAGARME_API_KEY\\|PAGARME_ENCRYPTION" ${SCOUT_DIR}/next/app/ ${SCOUT_DIR}/next/lib/ --include="*.ts" 2>/dev/null | grep -vi "test\\|spec\\|factory\\|config"
   Reportar apenas usos diretos que deveriam passar pelo PaymentGatewayFactory.

D) FIREBASE CONFIG
   Grep: grep -rn "turbostation-c4b1a\\|turbo-station-zev" ${SCOUT_DIR}/mobile/lib/ --include="*.dart" 2>/dev/null | grep -vi "test\\|flavor\\|firebase_options"
   Reportar hardcodes que deveriam usar flavor config.

E) WHITE_LABEL_MATRIX DRIFT
   Leia os checkboxes [x] marcados na matrix. Para os 5 mais críticos, confirme que realmente estão implementados.
   Reportar qualquer regressão.

═══ PASSO 4: ESCREVER RESULTADO ═══

Escreva o resultado em JSON EXATO neste path:
${FINDINGS_PATH}

Formato:
{
  "timestamp": "<ISO timestamp>",
  "scanComplete": true,
  "totalFilesScanned": <number>,
  "findings": [
    {
      "id": "<category>-<short-slug>",
      "category": "hardcoded_branding|missing_tenant_guard|payment_leak|firebase_config|matrix_drift",
      "severity": "high|medium|low",
      "file": "<relative path from repo root>",
      "line": <line number or 0>,
      "description": "<1-2 frase explicando o problema>",
      "suggestedFix": "<breve descrição da correção esperada>"
    }
  ]
}

SE NÃO ENCONTRAR NENHUM PROBLEMA: escreva o JSON com "findings": [] e "scanComplete": true.

IMPORTANTE:
- Só reporte problemas REAIS. Falso positivo é pior que não reportar.
- Teste unitário, arquivo de spec, comentário, README = NÃO é problema.
- Se um hardcode está dentro de um objeto de configuração de flavor/brand com switch = OK.
- Escreva o arquivo SEMPRE, mesmo se findings for []. O orchestrator depende disso.`;
}

async function runSweep(state) {
  log(`═══ SWEEP — Ciclo ${state.cycle} ═══`);
  sendTelegram(`🔍 Sweep Ciclo ${state.cycle} iniciando...`);

  // Pause scout heartbeat to avoid session lock conflict
  disableCron(SCOUT_CRON);
  // Wait a bit for any in-progress scout session to finish
  await sleep(15000);

  // Remove previous findings file
  try { fs.unlinkSync(FINDINGS_PATH); } catch {}

  // Kill any stale scout session locks
  try {
    exec(`find /home/openclaw/.openclaw/agents/scout/sessions/ -name "*.lock" -mmin +2 -delete 2>/dev/null || true`, { allowFail: true });
    log('Cleared stale scout session locks');
  } catch {}

  // Dispatch scout agent with unique session
  const prompt = buildSweepPrompt();
  const promptFile = '/tmp/sweep-prompt.txt';
  fs.writeFileSync(promptFile, prompt);
  const sessionId = `sweep-${state.cycle}-${Date.now()}`;

  log(`Dispatching scout agent (session: ${sessionId})...`);
  try {
    exec(
      `openclaw agent --agent scout --thinking high --timeout 1200 --session-id "${sessionId}" --message "$(cat ${promptFile})"`,
      { timeout: SCOUT_TIMEOUT_MS + 30000, allowFail: true }
    );
  } catch (err) {
    log(`Scout dispatch returned: ${err.message?.substring(0, 100)}`);
  }

  // Poll for findings file
  const deadline = Date.now() + SCOUT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(FINDINGS_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(FINDINGS_PATH, 'utf-8'));
        if (data.scanComplete) {
          log(`Scout complete. ${data.findings?.length || 0} findings.`);
          return data.findings || [];
        }
      } catch { /* file not ready yet */ }
    }
    log('Waiting for scout findings...');
    await sleep(30000); // 30s poll for scout
  }

  // Timeout fallback: run basic deterministic scan ourselves
  log('Scout timeout — running deterministic fallback scan');
  return runDeterministicScan();
}

function runDeterministicScan() {
  const findings = [];

  // A) Hardcoded branding in production code
  const brandHits = exec(
    `grep -rn "Turbo Station" ${TURBO_DIR}/next/app/ ${TURBO_DIR}/next/lib/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -vi "test\\|spec\\|__test\\|node_modules" || true`,
    { allowFail: true, timeout: 30000 }
  );
  for (const line of brandHits.split('\n').filter(Boolean)) {
    const match = line.match(/^(.+?):(\d+):(.+)$/);
    if (!match) continue;
    const [, filePath, lineNum, context] = match;
    const rel = filePath.replace(TURBO_DIR + '/', '');
    findings.push({
      id: `hardcode-${rel.replace(/[^a-z0-9]/gi, '-').substring(0, 40)}-L${lineNum}`,
      category: 'hardcoded_branding',
      severity: 'medium',
      file: rel,
      line: parseInt(lineNum),
      description: `Hardcoded "Turbo Station" found: ${context.trim().substring(0, 100)}`,
      suggestedFix: 'Replace with dynamic brand config from getBrandConfig() or tenant context',
    });
  }

  // B) Routes without tenant guard
  const routes = exec(
    `find ${TURBO_DIR}/next/app/api -name "route.ts" -not -path "*/public/*" -not -path "*/webhook/*" -not -path "*/auth/*" -not -path "*/internal/*" -not -path "*/_*" 2>/dev/null || true`,
    { allowFail: true, timeout: 15000 }
  );
  for (const routeFile of routes.split('\n').filter(Boolean)) {
    const content = fs.readFileSync(routeFile, 'utf-8');
    if (!/enforceRequestBrand|enforceUserBrand|getRequestBrandId/.test(content)) {
      // Only report if it handles user data (has db/firebase calls)
      if (/firestore|getDoc|setDoc|updateDoc|collection|adminAuth/.test(content)) {
        const rel = routeFile.replace(TURBO_DIR + '/', '');
        findings.push({
          id: `guard-${rel.replace(/[^a-z0-9]/gi, '-').substring(0, 40)}`,
          category: 'missing_tenant_guard',
          severity: 'high',
          file: rel,
          line: 0,
          description: `API route accesses data but has no tenant guard (enforceRequestBrand/getRequestBrandId)`,
          suggestedFix: 'Add enforceRequestBrandAllowedOrForbidden() or getRequestBrandId() at handler start',
        });
      }
    }
  }

  return findings;
}

// ─── Dedup: check existing open PRs for same files ─────────────────

function dedupFindings(findings) {
  // Get all open PRs targeting the branch
  const openPRsRaw = exec(
    `gh pr list --repo ${REPO} --state open --base ${TARGET_BRANCH} --json number,title,files --jq '[.[] | {number, title, files: [.files[].path]}]' 2>/dev/null || echo "[]"`,
    { allowFail: true, timeout: 30000 }
  );

  let openPRs = [];
  try { openPRs = JSON.parse(openPRsRaw || '[]'); } catch {}

  // Build set of files already covered by open PRs
  const coveredFiles = new Set();
  for (const pr of openPRs) {
    for (const f of (pr.files || [])) {
      coveredFiles.add(f);
    }
  }

  // Also check open issues with auto:implement label
  const openIssuesRaw = exec(
    `gh issue list --repo ${REPO} --state open --label "auto:implement" --json number,title --jq '[.[].title]' 2>/dev/null || echo "[]"`,
    { allowFail: true, timeout: 15000 }
  );
  let openIssueTitles = [];
  try { openIssueTitles = JSON.parse(openIssuesRaw || '[]'); } catch {}

  const deduped = [];
  const skipped = [];

  for (const finding of findings) {
    // Skip if file is already touched by an open PR
    if (coveredFiles.has(finding.file)) {
      skipped.push(finding.id);
      continue;
    }

    // Skip if a similar issue title already exists
    const slug = finding.description.substring(0, 50).toLowerCase();
    const isDupe = openIssueTitles.some(t => t.toLowerCase().includes(slug.substring(0, 30)));
    if (isDupe) {
      skipped.push(finding.id);
      continue;
    }

    deduped.push(finding);
  }

  if (skipped.length > 0) {
    log(`Dedup: skipped ${skipped.length} findings already covered by open PRs/issues`);
  }

  return deduped;
}

// ─── Phase: IMPLEMENT (batch) ──────────────────────────────────────

async function createIssuesForBatch(state, batchFindings, batchIndex, totalBatches) {
  log(`═══ IMPLEMENT — Batch ${batchIndex}/${totalBatches} (${batchFindings.length} issues) ═══`);
  sendTelegram(`🔧 Ciclo ${state.cycle} Batch ${batchIndex}/${totalBatches}: ${batchFindings.length} issues. Criando e ativando Coder...`);

  const batchData = [];

  for (const finding of batchFindings) {
    // Check for existing open issue with similar title
    const searchTitle = finding.description.substring(0, 50).replace(/"/g, '\\"');
    const existing = exec(
      `gh issue list --repo ${REPO} --state open --search "${searchTitle}" --json number --jq '.[0].number' 2>/dev/null || echo ""`,
      { allowFail: true }
    );

    let issueNumber;
    if (existing && existing !== 'null' && existing !== '') {
      issueNumber = parseInt(existing);
      log(`Issue already exists: #${issueNumber} (skipping creation)`);
    } else {
      // Create issue
      const body = [
        `## 🔍 White-Label Sweep — Achado Automático`,
        ``,
        `**Ciclo:** ${state.cycle} | **Batch:** ${batchIndex}/${totalBatches}`,
        `**Categoria:** \`${finding.category}\``,
        `**Severidade:** ${finding.severity}`,
        `**Arquivo:** \`${finding.file}\`${finding.line ? ` (linha ${finding.line})` : ''}`,
        ``,
        `### Problema`,
        finding.description,
        ``,
        `### Correção Sugerida`,
        finding.suggestedFix,
        ``,
        `### Contexto`,
        `Este issue foi criado automaticamente pelo sweep orchestrator.`,
        `Branch alvo: \`${TARGET_BRANCH}\``,
      ].join('\n');

      const bodyFile = `/tmp/sweep-issue-${finding.id}.md`;
      fs.writeFileSync(bodyFile, body);

      const title = `fix(white-label): ${finding.description.substring(0, 72)}`;
      const labels = 'agent:coder,auto:implement,white-label,Priority: P1-important';

    try {
        const result = exec(
          `gh issue create --repo ${REPO} --title "${title.replace(/"/g, '\\"')}" --body-file "${bodyFile}" --label "${labels}"`,
          { timeout: 15000 }
        );
        const urlMatch = result.match(/\/issues\/(\d+)/);
        issueNumber = urlMatch ? parseInt(urlMatch[1]) : null;
        log(`Created issue #${issueNumber}: ${finding.id}`);
      } catch (err) {
        log(`Failed to create issue for ${finding.id}: ${err.message}`);
        continue;
      }
    }

    batchData.push({
      ...finding,
      issueNumber,
      prNumber: null,
      prStatus: 'pending',
      merged: false,
      ciFixAttempts: 0,
    });
  }

  // Set current batch as the active cycle data
  state.currentCycle = {
    sweepFindings: batchData,
    allPRsMerged: false,
    batchIndex,
    totalBatches,
    cycleStartedAt: new Date().toISOString(),
  };
  state.status = 'IMPLEMENT';
  saveState(state);

  // === Phase: Wake Coder for Sweep Batch ===
  // CRITICAL: The coder has a heartbeat cron that runs reconcile.js which overwrites
  // task-state.json with rebase tasks. We must:
  // 1. Disable the coder cron BEFORE writing task-state
  // 2. Kill existing sessions AFTER cron is disabled
  // 3. Write a sweep-lock file to signal reconcile to skip
  // 4. Keep coder cron disabled until the batch is done

  disableCron(CODER_CRON);
  log('Coder cron disabled for sweep batch');
  await sleep(20000); // Wait for any running heartbeat to finish

  // Kill ALL existing coder sessions — must kill PROCESS, not just lock file
  try {
    // Read PIDs from lock files and kill them
    exec(`for f in /home/openclaw/.openclaw/agents/coder/sessions/*.lock; do [ -f "$f" ] && PID=$(python3 -c "import json; print(json.load(open('$f')).get('pid',''))" 2>/dev/null) && [ -n "$PID" ] && kill $PID 2>/dev/null; done; sleep 2; find /home/openclaw/.openclaw/agents/coder/sessions/ -name "*.lock" -delete 2>/dev/null || true`, { allowFail: true });
    log('Killed all coder session processes and cleared locks');
  } catch {}
  await sleep(5000);

  // Write sweep-lock file to prevent reconcile from overwriting task-state
  const sweepLockPath = '/home/openclaw/.openclaw/workspace-coder/sweep-lock.json';
  fs.writeFileSync(sweepLockPath, JSON.stringify({
    active: true,
    batchIndex,
    totalBatches,
    issues: batchData.map(f => f.issueNumber),
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  log('Wrote sweep-lock.json');

  // Write task-state.json directly with ONLY sweep issues (skip reconcile entirely)
  const taskState = {
    schema: 'v3',
    ciFixAttempts: {},
    blockedPRs: [],
    lastHeartbeat: new Date().toISOString(),
    queue: batchData.map(f => ({
      action: 'implement',
      number: f.issueNumber,
      repo: REPO,
      branch: `fix/issue-${f.issueNumber}-sweep`,
      title: `fix(white-label): ${f.description.substring(0, 60)}`,
      reason: `Sweep batch ${batchIndex}: ${f.description.substring(0, 80)}`,
    })),
  };
  const taskStatePath = '/home/openclaw/.openclaw/workspace-coder/task-state.json';
  fs.writeFileSync(taskStatePath, JSON.stringify(taskState, null, 2) + '\n');
  log(`Wrote ${taskState.queue.length} implement tasks to task-state.json`);

  const issueNums = batchData.map(f => `#${f.issueNumber}`).join(', ');
  const coderSessionId = `sweep-coder-${state.cycle}-b${batchIndex}-${Date.now()}`;

  // Build explicit per-issue instructions
  const issueInstructions = batchData.map((f, i) => {
    return `${i + 1}. Issue #${f.issueNumber}: ${f.description.substring(0, 80)}\n   Arquivo: ${f.file}${f.line ? `:${f.line}` : ''}\n   Fix: ${(f.suggestedFix || '').substring(0, 80)}`;
  }).join('\n');

  const coderMessage = `🚨 SWEEP BATCH — PRIORIDADE MÁXIMA

⚠️ NÃO rode reconcile.js --apply. O sweep-lock.json está ativo.
⚠️ NÃO rode o HEARTBEAT.md fast path. Leia estas instruções DIRETAMENTE.

O task-state.json já foi escrito com as ${batchData.length} issues deste batch.

Implemente CADA issue sequencialmente:

${issueInstructions}

Para CADA issue:
1. cd /home/openclaw/.openclaw/workspace-coder/turbo_station && git fetch origin
2. git worktree add ../worktrees/issue-N origin/${TARGET_BRANCH} -b fix/issue-N-desc
3. Leia a issue: gh issue view N --repo ${REPO}
4. Faça o fix (use getBrandConfig() ou brand context pra resolver branding dinâmico)
5. cd ../worktrees/issue-N/next && npm run type-check
6. git add -A && git commit -m 'fix(white-label): descrição'
7. git push origin fix/issue-N-desc
8. gh pr create --repo ${REPO} --base ${TARGET_BRANCH} --title 'fix(white-label): ...' --body 'Closes #N' --label 'needs:test-review,needs:sec-review,backend'
9. cd /home/openclaw/.openclaw/workspace-coder/turbo_station && git worktree remove --force ../worktrees/issue-N

Branch base: ${TARGET_BRANCH}. NUNCA faça merge de PRs.`;

  try {
    exec(
      `openclaw agent --agent coder --deliver --thinking high --timeout 900 --session-id "${coderSessionId}" --message "${coderMessage.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`,
      { timeout: 30000, allowFail: true }
    );
    log('Coder agent woken with direct sweep instructions');
  } catch (err) {
    log(`Coder wake: ${err.message?.substring(0, 80)}`);
  }

  return batchData;
}

// ─── Phase: WAIT for PRs (batch-aware) ─────────────────────────────

async function waitForPRs(state) {
  const batchLabel = state.currentCycle.batchIndex
    ? ` (Batch ${state.currentCycle.batchIndex}/${state.currentCycle.totalBatches})`
    : '';
  log(`═══ WAIT_IMPLEMENT${batchLabel} — Polling for ${state.currentCycle.sweepFindings.length} PRs ═══`);
  const deadline = Date.now() + IMPLEMENT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline && !isTimedOut()) {
    let allFound = true;

    for (const finding of state.currentCycle.sweepFindings) {
      if (finding.prNumber) continue;

      if (finding.issueNumber) {
        const prSearch = exec(
          `gh pr list --repo ${REPO} --state open --search "issue-${finding.issueNumber}" --json number,headRefName --jq '.[0].number' 2>/dev/null || echo ""`,
          { allowFail: true }
        );
        if (prSearch && prSearch !== 'null' && prSearch !== '') {
          finding.prNumber = parseInt(prSearch);
          finding.prStatus = 'pr_created';
          log(`Found PR #${finding.prNumber} for issue #${finding.issueNumber}`);
          saveState(state);
        } else {
          allFound = false;
        }
      }
    }

    if (allFound) {
      log('All batch PRs found!');
      return true;
    }

    const pendingCount = state.currentCycle.sweepFindings.filter(f => !f.prNumber).length;
    log(`Waiting for ${pendingCount} PRs${batchLabel}... (poll in 2min)`);
    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout — continue with whatever PRs we have
  const found = state.currentCycle.sweepFindings.filter(f => f.prNumber).length;
  const total = state.currentCycle.sweepFindings.length;
  log(`Implementation timeout${batchLabel}. ${found}/${total} PRs created.`);
  sendTelegram(`⚠️ Ciclo ${state.cycle}${batchLabel}: Timeout implementação. ${found}/${total} PRs.`);

  state.currentCycle.sweepFindings = state.currentCycle.sweepFindings.filter(f => f.prNumber);
  saveState(state);
  return state.currentCycle.sweepFindings.length > 0;
}

// ─── Pre-sweep: merge already-reviewed PRs ─────────────────────────

async function mergeExistingReadyPRs(state) {
  log('═══ PRE-SWEEP — Checking for existing reviewed PRs to merge ═══');

  const readyPRsRaw = exec(
    `gh pr list --repo ${REPO} --state open --base ${TARGET_BRANCH} --label "reviewed:tests" --label "reviewed:security" --json number,title,mergeable --jq '[.[] | select(.mergeable == "MERGEABLE") | {number, title}]' 2>/dev/null || echo "[]"`,
    { allowFail: true, timeout: 30000 }
  );

  let readyPRs = [];
  try { readyPRs = JSON.parse(readyPRsRaw || '[]'); } catch {}

  if (readyPRs.length === 0) {
    log('No existing reviewed PRs ready to merge.');
    return 0;
  }

  log(`Found ${readyPRs.length} reviewed PRs ready to merge`);
  sendTelegram(`🔀 Pre-sweep: Mergeando ${readyPRs.length} PRs já revisadas...`);

  let merged = 0;
  for (const pr of readyPRs) {
    // Safety: only merge PRs targeting our branch, not master/main
    const baseBranch = exec(
      `gh pr view ${pr.number} --repo ${REPO} --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "unknown"`,
      { allowFail: true }
    );
    if (baseBranch === 'master' || baseBranch === 'main') {
      log(`⚠️ PR #${pr.number} targets ${baseBranch} — SKIPPING`);
      continue;
    }

    try {
      exec(`gh pr merge ${pr.number} --repo ${REPO} --merge`, { timeout: 30000 });
      log(`PR #${pr.number} merged ✅ (${pr.title})`);
      merged++;
    } catch (err) {
      log(`PR #${pr.number} merge failed: ${err.message?.substring(0, 80)}`);
    }
    await sleep(5000); // let GitHub process
  }

  if (merged > 0) {
    sendTelegram(`✅ Pre-sweep: ${merged} PRs mergeadas. Esperando branch atualizar...`);
    await sleep(30000); // wait for branch to update
  }

  return merged;
}

// ─── Phase: WAIT_CI ────────────────────────────────────────────────

async function waitForCI(state) {
  log(`═══ WAIT_CI — Polling CI status ═══`);
  state.status = 'WAIT_CI';
  saveState(state);

  const deadline = Date.now() + CI_POLL_TIMEOUT_MS;

  while (Date.now() < deadline && !isTimedOut()) {
    let allGreen = true;

    for (const finding of state.currentCycle.sweepFindings) {
      if (!finding.prNumber || finding.prStatus === 'ci_green') continue;

      const checksJson = exec(
        `gh pr checks ${finding.prNumber} --repo ${REPO} --json name,state,conclusion 2>/dev/null || echo "[]"`,
        { allowFail: true }
      );

      try {
        const checks = JSON.parse(checksJson || '[]');
        if (checks.length === 0) {
          allGreen = false;
          continue;
        }

        const failing = checks.filter(c =>
          c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'TIMED_OUT'
        );
        const pending = checks.filter(c => !c.conclusion || c.state === 'IN_PROGRESS' || c.state === 'QUEUED');
        const passing = checks.filter(c =>
          c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
        );

        if (pending.length > 0) {
          finding.prStatus = 'ci_pending';
          allGreen = false;
        } else if (failing.length > 0) {
          finding.prStatus = 'ci_failed';
          allGreen = false;

          if (finding.ciFixAttempts < CI_FIX_MAX_ATTEMPTS) {
            finding.ciFixAttempts++;
            log(`PR #${finding.prNumber} CI failed (attempt ${finding.ciFixAttempts}). Existing webhook pipeline will auto-fix.`);
          } else {
            log(`PR #${finding.prNumber} CI failed ${CI_FIX_MAX_ATTEMPTS} times — marking blocked`);
            finding.prStatus = 'blocked';
            exec(`gh pr edit ${finding.prNumber} --repo ${REPO} --add-label "status:blocked"`, { allowFail: true });
          }
        } else {
          finding.prStatus = 'ci_green';
          log(`PR #${finding.prNumber} CI green ✅`);
        }
      } catch {
        allGreen = false;
      }
    }

    saveState(state);

    // Filter out blocked PRs
    const actionable = state.currentCycle.sweepFindings.filter(f => f.prStatus !== 'blocked');
    if (actionable.length === 0) {
      log('All PRs blocked — aborting cycle');
      return false;
    }

    if (actionable.every(f => f.prStatus === 'ci_green')) {
      log('All actionable PRs have green CI!');
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  log('CI wait timeout');
  sendTelegram(`⚠️ Ciclo ${state.cycle}: CI timeout. Continuando com PRs verdes.`);
  return state.currentCycle.sweepFindings.some(f => f.prStatus === 'ci_green');
}

// ─── Phase: WAIT_REVIEW ────────────────────────────────────────────

async function waitForReviews(state) {
  log(`═══ WAIT_REVIEW — Polling review status ═══`);
  state.status = 'WAIT_REVIEW';
  saveState(state);

  const deadline = Date.now() + REVIEW_POLL_TIMEOUT_MS;

  while (Date.now() < deadline && !isTimedOut()) {
    let allReviewed = true;

    for (const finding of state.currentCycle.sweepFindings) {
      if (!finding.prNumber || finding.prStatus === 'blocked') continue;
      if (finding.prStatus === 'reviewed') continue;

      const labelsJson = exec(
        `gh pr view ${finding.prNumber} --repo ${REPO} --json labels --jq '[.labels[].name]' 2>/dev/null || echo "[]"`,
        { allowFail: true }
      );

      try {
        const labels = JSON.parse(labelsJson || '[]');
        const hasTestReview = labels.includes('reviewed:tests');
        const hasSecReview = labels.includes('reviewed:security');
        const needsCoderFix = labels.includes('needs:coder-fix');

        if (needsCoderFix) {
          finding.prStatus = 'changes_requested';
          allReviewed = false;
          // The existing webhook pipeline will wake coder automatically
          log(`PR #${finding.prNumber} needs coder fix — existing pipeline handles this`);
        } else if (hasTestReview && hasSecReview) {
          finding.prStatus = 'reviewed';
          log(`PR #${finding.prNumber} fully reviewed ✅`);
        } else if (finding.prStatus !== 'ci_green') {
          // Still waiting
          allReviewed = false;
        } else {
          allReviewed = false;
          // Ensure review labels are set
          if (!labels.includes('needs:test-review') && !hasTestReview) {
            exec(`gh pr edit ${finding.prNumber} --repo ${REPO} --add-label "needs:test-review"`, { allowFail: true });
          }
          if (!labels.includes('needs:sec-review') && !hasSecReview) {
            exec(`gh pr edit ${finding.prNumber} --repo ${REPO} --add-label "needs:sec-review"`, { allowFail: true });
          }
        }
      } catch {
        allReviewed = false;
      }
    }

    saveState(state);

    const actionable = state.currentCycle.sweepFindings.filter(f =>
      f.prStatus !== 'blocked' && f.prNumber
    );

    if (actionable.every(f => f.prStatus === 'reviewed')) {
      log('All actionable PRs reviewed!');
      return true;
    }

    // If we have SOME reviewed + rest are stuck, continue with reviewed ones after timeout/2
    if (Date.now() > deadline - REVIEW_POLL_TIMEOUT_MS / 2) {
      const reviewed = actionable.filter(f => f.prStatus === 'reviewed');
      if (reviewed.length > 0) {
        log(`Partial review: ${reviewed.length}/${actionable.length} reviewed. Proceeding with reviewed.`);
        return true;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  log('Review wait timeout — proceeding with whatever is reviewed');
  return state.currentCycle.sweepFindings.some(f => f.prStatus === 'reviewed');
}

// ─── Phase: MERGE ──────────────────────────────────────────────────

async function mergePRs(state) {
  log(`═══ MERGE — Merging PRs sequentially ═══`);
  state.status = 'MERGE';
  saveState(state);

  // Only merge PRs that are reviewed (or at least CI green if reviews timed out)
  const toMerge = state.currentCycle.sweepFindings.filter(f =>
    f.prNumber && !f.merged && (f.prStatus === 'reviewed' || f.prStatus === 'ci_green') && f.prStatus !== 'blocked'
  );

  sendTelegram(`🔀 Ciclo ${state.cycle}: Mergeando ${toMerge.length} PRs...`);

  for (const finding of toMerge) {
    log(`Merging PR #${finding.prNumber}...`);

    // Check base branch — only merge if target is NOT master/main
    const baseBranch = exec(
      `gh pr view ${finding.prNumber} --repo ${REPO} --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "unknown"`,
      { allowFail: true }
    );

    if (baseBranch === 'master' || baseBranch === 'main') {
      log(`⚠️ PR #${finding.prNumber} targets ${baseBranch} — SKIPPING (safety)`);
      finding.prStatus = 'skip_master';
      continue;
    }

    // Check mergeable status
    const mergeable = exec(
      `gh pr view ${finding.prNumber} --repo ${REPO} --json mergeable --jq '.mergeable' 2>/dev/null || echo "UNKNOWN"`,
      { allowFail: true }
    );

    if (mergeable === 'CONFLICTING') {
      log(`PR #${finding.prNumber} has conflicts — waking coder to rebase`);
      try {
        exec(
          `openclaw agent --agent coder --deliver --timeout 600 --message "PR #${finding.prNumber} tem conflito de merge. Rebasa a branch no ${TARGET_BRANCH} e faz push --force-with-lease."`,
          { timeout: 30000, allowFail: true }
        );
      } catch {}

      // Wait for rebase (up to 10 min)
      const rebaseDeadline = Date.now() + 10 * 60 * 1000;
      let rebased = false;
      while (Date.now() < rebaseDeadline) {
        await sleep(60000);
        const status = exec(
          `gh pr view ${finding.prNumber} --repo ${REPO} --json mergeable --jq '.mergeable' 2>/dev/null || echo "UNKNOWN"`,
          { allowFail: true }
        );
        if (status === 'MERGEABLE') {
          rebased = true;
          break;
        }
      }
      if (!rebased) {
        log(`PR #${finding.prNumber} still conflicting after rebase attempt — skipping`);
        finding.prStatus = 'conflict_stuck';
        continue;
      }
    }

    // Attempt merge
    try {
      exec(
        `gh pr merge ${finding.prNumber} --repo ${REPO} --merge`,
        { timeout: 30000 }
      );
      finding.merged = true;
      finding.prStatus = 'merged';
      log(`PR #${finding.prNumber} merged ✅`);
    } catch (err) {
      log(`PR #${finding.prNumber} merge failed: ${err.message?.substring(0, 100)}`);
      finding.prStatus = 'merge_failed';
    }

    saveState(state);

    // Small delay between merges to let GitHub process
    await sleep(5000);
  }

  const merged = state.currentCycle.sweepFindings.filter(f => f.merged).length;
  const total = state.currentCycle.sweepFindings.length;
  log(`Merged ${merged}/${total} PRs`);
  sendTelegram(`✅ Ciclo ${state.cycle}: ${merged}/${total} PRs mergeadas.`);

  return merged > 0;
}

// ─── Main Loop ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--reset')) {
    const state = createFreshState();
    saveState(state);
    log('State reset.');
    process.exit(0);
  }

  if (args.includes('--status')) {
    const state = loadState();
    console.log(`Status: ${state.status} | Cycle: ${state.cycle} | Last: ${state.lastUpdated}`);
    if (state.currentCycle) {
      const findings = state.currentCycle.sweepFindings || [];
      const merged = findings.filter(f => f.merged).length;
      console.log(`  Findings: ${findings.length} | Merged: ${merged}`);
      for (const f of findings) {
        console.log(`    ${f.id}: issue=#${f.issueNumber} pr=#${f.prNumber} status=${f.prStatus} merged=${f.merged}`);
      }
    }
    console.log(`History: ${state.history?.length || 0} cycles completed`);
    for (const h of (state.history || [])) {
      console.log(`  Cycle ${h.cycle}: ${h.findings} found, ${h.prsMerged} merged, ${h.duration || '?'}`);
    }
    process.exit(0);
  }

  let state = loadState();

  // If we have a DONE or fresh state, start fresh
  if (state.status === 'DONE' || state.status === 'STALLED' || state.status === 'ERROR') {
    state = createFreshState();
    saveState(state);
  }

  log(`╔══════════════════════════════════════════════════════════════╗`);
  log(`║  SWEEP ORCHESTRATOR v2 — Batch Mode (batch=${BATCH_SIZE})          ║`);
  log(`║  Status: ${state.status.padEnd(10)} Cycle: ${String(state.cycle).padEnd(3)}                        ║`);
  log(`╚══════════════════════════════════════════════════════════════╝`);
  sendTelegram(`🚀 Sweep v2 (batch=${BATCH_SIZE}) iniciado! Ciclo ${state.cycle}, status: ${state.status}`);

  try {
    while (state.cycle <= MAX_CYCLES && !isTimedOut()) {
      const cycleStart = Date.now();

      // ═══ PRE-SWEEP: Merge any existing reviewed PRs first ═══
      if (state.status === 'SWEEP' || !state.currentCycle) {
        const preMerged = await mergeExistingReadyPRs(state);
        if (preMerged > 0) {
          log(`Pre-merged ${preMerged} PRs. Branch updated.`);
        }

        // Phase: SWEEP
        const rawFindings = await runSweep(state);

        if (rawFindings.length === 0) {
          state.status = 'DONE';
          saveState(state);
          log('🎉 SWEEP CLEAN — Zero issues found!');
          break;
        }

        // Dedup against existing PRs/issues
        const findings = dedupFindings(rawFindings);
        log(`After dedup: ${findings.length} actionable findings (was ${rawFindings.length})`);

        if (findings.length === 0) {
          log('All findings already covered by open PRs — waiting for them to merge');
          sendTelegram(`🔄 Ciclo ${state.cycle}: ${rawFindings.length} achados, todos já cobertos por PRs abertas. Mergeando existentes...`);
          // Try merging existing ones and loop
          state.cycle++;
          saveState(state);
          await sleep(30000);
          continue;
        }

        // ═══ BATCH LOOP: Process findings in batches of BATCH_SIZE ═══
        const batches = [];
        for (let i = 0; i < findings.length; i += BATCH_SIZE) {
          batches.push(findings.slice(i, i + BATCH_SIZE));
        }

        log(`Split ${findings.length} findings into ${batches.length} batches of ≤${BATCH_SIZE}`);
        sendTelegram(`📦 Ciclo ${state.cycle}: ${findings.length} issues → ${batches.length} batches de ≤${BATCH_SIZE}`);

        let totalMergedThisCycle = 0;
        let totalFindingsThisCycle = findings.length;
        let stalledBatches = 0;

        for (let bi = 0; bi < batches.length && !isTimedOut(); bi++) {
          const batch = batches[bi];
          const batchNum = bi + 1;

          log(`\n┌─── Batch ${batchNum}/${batches.length} (${batch.length} issues) ───┐`);

          // 1. Create issues and wake coder for THIS batch only
          await createIssuesForBatch(state, batch, batchNum, batches.length);

          // 2. Wait for PRs to be created
          const hasPRs = await waitForPRs(state);
          if (!hasPRs) {
            log(`Batch ${batchNum}: No PRs created — skipping to next batch`);
            stalledBatches++;
            state.currentCycle = null;
            saveState(state);
            continue;
          }

          // 3. Wait for CI
          const ciOk = await waitForCI(state);
          if (!ciOk) {
            log(`Batch ${batchNum}: No PRs passed CI — skipping to next batch`);
            stalledBatches++;
            state.currentCycle = null;
            saveState(state);
            continue;
          }

          // 4. Wait for reviews
          await waitForReviews(state);

          // 5. Merge
          const mergedAny = await mergePRs(state);
          const batchMerged = state.currentCycle.sweepFindings.filter(f => f.merged).length;
          totalMergedThisCycle += batchMerged;

          log(`└─── Batch ${batchNum}: ${batchMerged} merged ───┘\n`);

          // Clean up for next batch
          state.currentCycle = null;
          saveState(state);

          if (mergedAny) {
            // Wait for branch to update before next batch
            log('Waiting 30s for branch to update...');
            await sleep(30000);
          } else {
            stalledBatches++;
          }
        }

        // Record cycle results
        state.history.push({
          cycle: state.cycle,
          findings: totalFindingsThisCycle,
          batches: batches.length,
          stalledBatches,
          prsMerged: totalMergedThisCycle,
          duration: formatDuration(Date.now() - cycleStart),
          result: totalMergedThisCycle > 0 ? 'ok' : 'no_merges',
        });

        sendTelegram(`📊 Ciclo ${state.cycle} completo: ${totalMergedThisCycle} PRs mergeadas de ${totalFindingsThisCycle} achados (${batches.length} batches, ${stalledBatches} travados)`);

        // Advance to next cycle
        state.cycle++;
        state.currentCycle = null;
        state.status = 'SWEEP';
        saveState(state);

        if (totalMergedThisCycle === 0) {
          log('No PRs merged this cycle — stopping to avoid infinite loop');
          state.status = 'STALLED';
          saveState(state);
          break;
        }

        // Wait for branch to fully update
        log('Waiting 30s for next cycle...');
        await sleep(30000);
      }
    }
  } catch (err) {
    log(`FATAL: ${err.message}`);
    log(err.stack);
    state.status = 'ERROR';
    state.error = err.message;
    saveState(state);
    sendTelegram(`❌ Sweep Orchestrator crashed: ${err.message.substring(0, 200)}`);
    process.exit(1);
  }

  // Final report
  const totalFindings = (state.history || []).reduce((s, h) => s + h.findings, 0);
  const totalMerged = (state.history || []).reduce((s, h) => s + h.prsMerged, 0);
  const totalDuration = formatDuration(Date.now() - startTime);
  const statusEmoji = state.status === 'DONE' ? '🎉' : state.status === 'STALLED' ? '⚠️' : '🏁';

  const report = [
    `${statusEmoji} White-Label Night Sweep — Relatório Final`,
    ``,
    `Status: ${state.status}`,
    `Ciclos: ${(state.history || []).length}`,
    `Issues encontradas: ${totalFindings}`,
    `PRs mergeadas: ${totalMerged}`,
    `Duração total: ${totalDuration}`,
    ``,
    ...(state.history || []).map(h =>
      `  Ciclo ${h.cycle}: ${h.findings} achados, ${h.prsMerged} mergeados (${h.duration})`
    ),
  ].join('\n');

  log(report);
  sendTelegram(report);
  saveState(state);
}

function formatDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

main().catch(err => {
  console.error('Unhandled:', err);
  process.exit(1);
});
