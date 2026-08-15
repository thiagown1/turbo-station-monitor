#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.OPENCLAW_SRC_ROOT || '/home/openclaw/openclaw';
const allowedAgentIds = new Set(
  String(process.env.AI_SUBSCRIPTION_ALLOWED_AGENT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 512 * 1024) throw new Error('runner input too large');
}

const payload = JSON.parse(input || '{}');
if (!allowedAgentIds.has(payload.agentId)) throw new Error('agent id not allowed');
if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('empty message');

const gatewayModule = pathToFileURL(`${sourceRoot}/src/gateway/call.ts`).href;
const { callGateway } = await import(gatewayModule);
const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 110_000, 1_000), 120_000);
const response = await callGateway({
  method: 'agent',
  params: {
    message: payload.message,
    agentId: payload.agentId,
    sessionId: payload.sessionId,
    idempotencyKey: payload.sessionId,
    timeout: Math.ceil(timeoutMs / 1000),
  },
  expectFinal: true,
  timeoutMs,
});

process.stdout.write(JSON.stringify(response));

