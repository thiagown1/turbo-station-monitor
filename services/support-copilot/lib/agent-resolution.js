function parseBrandAgentMap(raw = process.env.BRAND_AGENT_MAP || '') {
  return raw
    .split(',')
    .filter(Boolean)
    .reduce((map, pair) => {
      const [brand, agent] = pair.split(':');
      if (brand && agent) map[brand.trim()] = agent.trim();
      return map;
    }, {});
}

function resolveSupportAgent(brandId, channel, options = {}) {
  const brandAgentMap = options.brandAgentMap || parseBrandAgentMap(options.brandAgentMapRaw);
  const defaultAgent = options.defaultAgent ?? process.env.OPENCLAW_AGENT ?? '';
  const groupAgent = options.groupAgent ?? process.env.GROUP_AGENT ?? process.env.OPENCLAW_GROUP_AGENT ?? '';

  if (channel === 'whatsapp-group') {
    if (groupAgent) return groupAgent;
    if (brandId) return brandAgentMap[brandId] || `support_${brandId}`;
    throw new Error('Unable to resolve group agent: configure GROUP_AGENT/OPENCLAW_GROUP_AGENT or provide a brand_id binding');
  }

  if (brandId) return brandAgentMap[brandId] || `support_${brandId}`;
  if (defaultAgent) return defaultAgent;

  throw new Error('Unable to resolve support agent: missing brand_id and OPENCLAW_AGENT fallback');
}

module.exports = {
  parseBrandAgentMap,
  resolveSupportAgent,
};
