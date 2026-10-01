#!/usr/bin/env node
'use strict';

/**
 * End-to-end through the real support-copilot process: a WhatsApp group message
 * that mentions the support number reaches the partner assistant (fake Hermes
 * binary), which proposes the answer to the central for human review. The
 * station investigator, also allowlisted for the group, must not answer, and
 * nothing is sent to the group in shadow mode.
 *
 * The process, stub central and stub gateway come from lib/partner-whatsapp-simulator.js
 * (the same harness the simulation CLI uses); this file keeps the original
 * single-scenario assertions on top of it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startSimulator } = require('../lib/partner-whatsapp-simulator');

const CONVERSATION_ID = 'conv_arenapartner01';
const RUN = `${process.pid}-${Date.now()}`;
const FAKE_HERMES = path.join(os.tmpdir(), `fake-hermes-${RUN}.js`);

const FAKE_HERMES_SOURCE = [
  "let input = '';",
  "process.stdin.on('data', (c) => { input += c; });",
  "process.stdin.on('end', () => {",
  `  if (process.env.TURBO_PARCEIRO_CONVERSATION_ID !== ${JSON.stringify(CONVERSATION_ID)}) process.exit(3);`,
  "  if (!input.includes('o Fornassa caiu?')) process.exit(4);",
  "  console.log('session_id: 20260927_000000_000000');",
  "  console.log('O *Restaurante Fornassa* está funcionando normalmente.');",
  '});',
].join('\n');

(async () => {
  fs.writeFileSync(FAKE_HERMES, FAKE_HERMES_SOURCE);
  let sim;
  try {
    sim = await startSimulator([
      // Without a structured mention the partner assistant stays silent.
      { id: 'quiet', conversationId: CONVERSATION_ID, question: 'o Fornassa caiu?', mention: false, sender: 'Leonardo' },
      { id: 'mentioned', conversationId: CONVERSATION_ID, question: 'o Fornassa caiu?', sender: 'Leonardo' },
    ], { hermesBin: FAKE_HERMES });

    const quiet = await sim.run('quiet');
    assert.equal(quiet.claimed, false);

    const mentioned = await sim.run('mentioned');
    assert.equal(mentioned.claimed, true);
    assert.equal(sim.captured.proposals.length, 1);
    const [proposal] = sim.captured.proposals;
    assert.equal(proposal.action, 'propose_reply');
    assert.deepEqual(proposal.subject, { type: 'whatsapp_group', conversationId: CONVERSATION_ID });
    assert.equal(proposal.reply.answer, 'O *Restaurante Fornassa* está funcionando normalmente.');
    assert.equal(proposal.reply.sourceMessageId, mentioned.messageId);

    // A provider replay of the same message is not answered twice.
    const replay = await sim.replay('mentioned');
    assert.equal(replay.duplicate, true);
    assert.equal(sim.captured.proposals.length, 1);

    assert.equal(mentioned.investigatorCalls, 0, 'the station investigator must not answer a message the partner assistant owns');
    assert.equal(sim.captured.investigations, 0);
    assert.equal(sim.captured.gatewaySends.length, 0, 'shadow mode never sends to the group');

    assert.deepEqual({ status: mentioned.status, reviewId: mentioned.reviewId }, { status: 'review', reviewId: 'review-sim-1' });
    console.log('PASS partner assistant webhook: structured mention, shadow review, precedence over investigator, idempotent replay');
  } catch (error) {
    if (sim) console.error(sim.output().slice(-3000));
    throw error;
  } finally {
    if (sim) await sim.close();
    fs.rmSync(FAKE_HERMES, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
