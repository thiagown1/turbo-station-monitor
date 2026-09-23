'use strict';

const OPERATIONAL_SOURCES = new Set(['github-webhook', 'pagarme-status-webhook']);

function shouldInjectOutboundIntoAgent(source) {
  return !OPERATIONAL_SOURCES.has(source);
}

module.exports = { shouldInjectOutboundIntoAgent };
