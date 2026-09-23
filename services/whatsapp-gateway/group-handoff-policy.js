'use strict';

function ignoredGroupJids(value) {
  return new Set(String(value || '').split(',').map((jid) => jid.trim()).filter(Boolean));
}

function configuredIgnoredGroups(env) {
  return ignoredGroupJids(env.GATEWAY_IGNORED_GROUP_JIDS ?? env.SUPPORT_COPILOT_IGNORED_GROUP_JIDS);
}

function shouldForwardInbound(remoteJid, ignoredGroups) {
  return !(typeof remoteJid === 'string'
    && remoteJid.endsWith('@g.us')
    && ignoredGroups.has(remoteJid));
}

module.exports = { configuredIgnoredGroups, ignoredGroupJids, shouldForwardInbound };
