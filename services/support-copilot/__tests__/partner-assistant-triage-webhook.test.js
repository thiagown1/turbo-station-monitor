'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startSimulator } = require('../lib/partner-whatsapp-simulator');

const scenarios = [
  { id: 'allowed', conversationId: 'conv_triageallowed', question: 'Bom dia equipe', mention: false, autoSend: true },
  { id: 'unlisted', conversationId: 'conv_triageunlisted', question: 'Bom dia equipe', mention: false, allowed: false, autoSend: true },
];

for (const triageMode of ['off', 'unknown', 'shadow', 'active']) {
  test(`real ingest: ${triageMode}, replay and allowlist, no sends or reply jobs`, async () => {
    const sim = await startSimulator(scenarios, { triageMode });
    try {
      const result = await sim.run('allowed');
      assert.equal(result.claimed, false);
      assert.equal(sim.jobFor(result.messageId), undefined);
      assert.equal((await sim.replay('allowed')).duplicate, true);
      await sim.run('unlisted');
      assert.equal(sim.captured.triages.length, ['shadow', 'active'].includes(triageMode) ? 1 : 0);
      assert.equal(sim.captured.proposals.length, 0);
      assert.equal(sim.captured.interactions.length, 0);
      assert.equal(sim.captured.gatewaySends.length, 0);
      assert.equal(sim.captured.unexpected.length, 0);
    } finally { await sim.close(); }
  });
}

for (const failure of ['network', '4xx', 'malformed', 'timeout']) {
  test(`real ingest succeeds while triage has ${failure}`, async () => {
    let release;
    const sim = await startSimulator(scenarios, {
      triageMode: 'shadow',
      triageHandler: (req, res) => {
        if (failure === 'network') return req.socket.destroy();
        if (failure === '4xx') { res.writeHead(403); return res.end('{}'); }
        if (failure === 'malformed') return res.end('{"decision":"arbitrary message text"}');
        release = () => res.end('{}'); // leave HTTP pending beyond the ingest response
      },
    });
    try {
      const result = await sim.run('allowed'); // would hang if ingest awaited triage
      assert.equal(result.claimed, false);
      assert.equal(sim.captured.triages.length, 1);
      if (failure === 'timeout') {
        assert.equal(typeof release, 'function', 'triage is pending after ingest completed');
        await new Promise(resolve => setTimeout(resolve, 8200));
      }
      assert.equal((await sim.replay('allowed')).duplicate, true);
      assert.equal(sim.captured.triages.length, 1);
      assert.equal(sim.jobFor(result.messageId), undefined);
      assert.equal(sim.captured.gatewaySends.length, 0);
      assert.equal(sim.captured.proposals.length, 0);
      assert.doesNotMatch(sim.output(), /UnhandledPromiseRejection|arbitrary message text/);
    } finally { if (release) release(); await sim.close(); }
  });
}
