#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runScenarios } = require('../lib/partner-whatsapp-simulator');

const HELP = `Simulate partner WhatsApp messages end to end, without WhatsApp.

Usage:
  node scripts/simulate-partner-whatsapp.js --scenarios <file.json> [--hermes <path>] [--json] [--timeout-ms <n>]

The scenarios file is a JSON array (or { "scenarios": [...] }) of:
  { "id": "...", "conversationId": "conv_...", "question": "...",
    "groupJid"?: "...@g.us", "context"?: [{ "sender": "...", "text": "...", "at"?: ISO }],
    "mention"?: true, "allowed"?: true, "autoSend"?: false, "sender"?: "..." }

Each scenario boots the real support-copilot process against a throwaway SQLite
database, seeds the conversation and context, posts a simulated Evolution webhook
(structured mention by default) and prints { claimed, answer, tools, reviewId,
sentToGroup }.

Safety:
  - The Evolution gateway is ALWAYS a loopback stub that counts sends and delivers
    nothing. Real Evolution credentials and the real central are never read or
    forwarded; there is no option to change that, and the run aborts if the
    gateway is not the stub.
  - Replies are only proposals to a stub central; nothing is persisted outside
    a temporary directory that is deleted at the end.

Hermes:
  --hermes <path>   Hermes binary (default: $HERMES_BIN, then ~/.local/bin/hermes).
                    A *.js path runs through Node (fake Hermes for dry runs).
  Real Hermes calls partner tools through its own profile
  (~/.hermes/profiles/parceiro/.env). Point TURBO_PARTNER_TOOLS_BASE_URL there at a
  LOCAL Next started with PARTNER_AGENT_LOCAL_OVERRIDE=1, and use conversation ids
  that exist in that local data. NEVER point it at production.

Options:
  --json            Print the raw result array instead of the compact report.
  --timeout-ms <n>  Per-scenario wait for the assistant (default 240000 with real
                    Hermes; set lower for fakes).
  --help            Show this help.
`;

function parseCliArgs(argv) {
  const options = { scenarios: null, hermes: null, json: false, timeoutMs: 240_000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--scenarios') options.scenarios = value();
    else if (arg === '--hermes') options.hermes = value();
    else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(value());
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function loadScenarios(file) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.scenarios;
}

function oneLine(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatReport(results) {
  const lines = results.map((r) => {
    const flags = `claimed=${r.claimed} sentToGroup=${r.sentToGroup}`;
    if (!r.claimed) return `- ${r.id}: ${flags} (not answered)`;
    const detail = r.answer
      ? `tools=[${r.tools.join(',')}] reviewId=${r.reviewId || '-'}\n    ${oneLine(r.answer)}`
      : `status=${r.status} error=${oneLine(r.error, 100)}`;
    return `- ${r.id}: ${flags} ${detail}`;
  });
  const failed = results.filter((r) => r.claimed && !r.answer).length;
  return `${lines.join('\n')}\n${results.length} scenario(s), ${results.filter((r) => r.claimed).length} claimed, ${failed} without an answer, ${results.filter((r) => r.sentToGroup).length} sent to the (stub) group`;
}

async function main(argv) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) { console.log(HELP); return 0; }
  if (!options.scenarios) { console.error(`--scenarios is required\n\n${HELP}`); return 2; }

  let results;
  try {
    results = await runScenarios(loadScenarios(options.scenarios), { hermesBin: options.hermes || undefined, timeoutMs: options.timeoutMs });
  } catch (error) {
    console.error(`simulation failed: ${error.message}`);
    if (error.childOutput) console.error(error.childOutput);
    return 1;
  }
  console.log(options.json ? JSON.stringify(results, null, 2) : formatReport(results));
  return results.some((r) => r.claimed && !r.answer) ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
}

module.exports = { HELP, formatReport, main, parseCliArgs };
