function parseBrandAgentMap(raw = '') {
  return String(raw)
    .split(',')
    .filter(Boolean)
    .reduce((map, pair) => {
      const [brand, agent] = pair.split(':');
      if (brand && agent) map[brand.trim()] = agent.trim();
      return map;
    }, {});
}

function explicitAgentForBrand(brandId, brandAgentMap = {}) {
  if (!brandId) return '';
  if (brandAgentMap[brandId]) return brandAgentMap[brandId];
  return `support_${brandId}`;
}

function requireSafeAgent(agentId, reason) {
  if (agentId) return agentId;
  const err = new Error(reason);
  err.code = 'COPILOT_AGENT_UNRESOLVED';
  throw err;
}

function resolveAgentForBrand({ brandId, channel, groupAgent = '', defaultAgent = '', brandAgentMap = {} }) {
  const tenantAgent = explicitAgentForBrand(brandId, brandAgentMap);

  if (channel === 'whatsapp-group') {
    return requireSafeAgent(
      groupAgent || tenantAgent || defaultAgent,
      'Unable to resolve support copilot agent for WhatsApp group conversation; configure GROUP_AGENT/OPENCLAW_AGENT or provide a brand binding.'
    );
  }

  return requireSafeAgent(
    tenantAgent || defaultAgent,
    'Unable to resolve support copilot agent; configure OPENCLAW_AGENT or provide a brand binding.'
  );
}

module.exports = {
  parseBrandAgentMap,
  explicitAgentForBrand,
  requireSafeAgent,
  resolveAgentForBrand,
};
