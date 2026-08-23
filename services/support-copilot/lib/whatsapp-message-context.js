function contextInfoCandidates(message) {
  return [
    message?.extendedTextMessage?.contextInfo,
    message?.imageMessage?.contextInfo,
    message?.documentMessage?.contextInfo,
    message?.videoMessage?.contextInfo,
    message?.audioMessage?.contextInfo,
    message?.buttonsResponseMessage?.contextInfo,
    message?.listResponseMessage?.contextInfo,
  ].filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

function extractWhatsappMessageContext(message, messageTimestamp) {
  const infos = contextInfoCandidates(message);
  const primary = infos[0] || {};
  const mentionedJids = uniqueStrings(infos.flatMap((info) => [
    ...(Array.isArray(info.mentionedJid) ? info.mentionedJid : []),
    ...(Array.isArray(info.mentionedJids) ? info.mentionedJids : []),
    ...(Array.isArray(info.mentionedJidList) ? info.mentionedJidList : []),
  ]));
  const forwardingScore = Math.max(0, ...infos.map((info) => Number(info.forwardingScore) || 0));
  const numericTimestamp = Number(messageTimestamp);
  let providerTimestamp = null;
  if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) {
    providerTimestamp = new Date(numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp).toISOString();
  } else if (typeof messageTimestamp === 'string') {
    const parsed = new Date(messageTimestamp);
    if (!Number.isNaN(parsed.getTime())) providerTimestamp = parsed.toISOString();
  }
  return {
    providerTimestamp,
    quotedMessageId: typeof primary.stanzaId === 'string' ? primary.stanzaId : null,
    quotedSenderId: typeof primary.participant === 'string' ? primary.participant : null,
    mentionedJids,
    isForwarded: infos.some((info) => info.isForwarded === true) || forwardingScore > 0,
    forwardingScore,
  };
}

function hasAllowedStructuredMention(context, allowedJids) {
  const allowed = new Set(uniqueStrings(allowedJids).map((jid) => jid.toLowerCase()));
  return context.mentionedJids.some((jid) => allowed.has(String(jid).toLowerCase()));
}

module.exports = { extractWhatsappMessageContext, hasAllowedStructuredMention };
