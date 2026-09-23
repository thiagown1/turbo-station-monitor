'use strict';

function isLegacyOpenClawHookEnabled(env = process.env) {
  return env.SHORT_TRADER_OPENCLAW_HOOK_ENABLED === 'true';
}

module.exports = { isLegacyOpenClawHookEnabled };
