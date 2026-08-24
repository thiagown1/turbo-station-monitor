const crypto = require('crypto');

const DEFAULT_CONTEXT_HOURS = 72;
const DEFAULT_MAX_MESSAGES = 40;
const PREFERRED_QUESTION_WINDOW_MS = 30 * 60 * 1000;

function cleanBody(message) {
  const raw = String(message.raw_body || message.body || '').trim();
  if (!message.raw_body && message.sender_name) {
    return raw.replace(new RegExp(`^\\[${escapeRegex(message.sender_name)}\\]:\\s*`), '').trim();
  }
  return raw;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsedJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function withoutMentions(text) {
  return String(text || '')
    .replace(/@(?:Turbo\s*Station\s*Suporte|\d{5,})/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeQuestion(text) {
  const value = withoutMentions(text);
  return value.includes('?') || /\b(confirma|consegue|verifica|voltou|normal|vivo|sinal|aconteceu|houve|falha|erro|pot[eê]ncia|carregador|esta[cç][aã]o)\b/i.test(value);
}

function isMentionOnly(message) {
  const mentioned = parsedJson(message.mentioned_jids_json, []);
  return mentioned.length > 0 && withoutMentions(cleanBody(message)).length < 4;
}

function parseProviderTime(message) {
  const value = message.provider_timestamp || message.created_at;
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function effectiveQuestion(messages, trigger) {
  if (!isMentionOnly(trigger) && looksLikeQuestion(cleanBody(trigger))) return trigger;
  const triggerAt = parseProviderTime(trigger).getTime();
  const prior = messages
    .filter((message) => message.id !== trigger.id
      && message.direction === 'inbound'
      && message.sender_id === trigger.sender_id
      && parseProviderTime(message).getTime() <= triggerAt
      && looksLikeQuestion(cleanBody(message)))
    .sort((a, b) => parseProviderTime(b).getTime() - parseProviderTime(a).getTime());
  const preferred = prior.find((message) => triggerAt - parseProviderTime(message).getTime() <= PREFERRED_QUESTION_WINDOW_MS);
  if (preferred) return preferred;

  // A real group can mention the agent well after asking (the Lago Norte case
  // waited ~67 minutes). Fall back only when no operator/bot outbound answer
  // exists after the candidate, so an old resolved issue is never reopened.
  return prior.find((candidate) => !messages.some((message) =>
    message.direction === 'outbound'
    && parseProviderTime(message) > parseProviderTime(candidate)
    && parseProviderTime(message) < parseProviderTime(trigger))) || trigger;
}

function stationIdsFrom(text) {
  const values = String(text || '').match(/\b(?:[A-Z]{1,8}\d{6,16}|\d{10,16})\b/g) || [];
  return [...new Set(values.map((value) => value.toUpperCase()))];
}

function stationNamesFrom(text) {
  const value = String(text || '');
  const candidates = [];
  for (const match of value.matchAll(/(?:🏢|esta[cç][aã]o\s*[:\-]?|se\s+o\s+)([^\n,.!?]{3,80}?)(?=\s+voltou\b|\n|$|[,!?])/gi)) {
    const name = match[1].replace(/\b(?:voltou|est[aá]|ficou|segue)\b.*$/i, '').trim();
    if (name && !/^(carregador|normal)$/i.test(name)) candidates.push(name);
  }
  return [...new Set(candidates.map((name) => name.replace(/\s+/g, ' ')))];
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function incidentSignal(message) {
  const text = cleanBody(message);
  const errorCode = firstMatch(text, [/errorCode\s*[:=]\s*([^\s,;\n]+)/i, /erro\s*[:=]\s*([^\s,;\n]+)/i]);
  const info = firstMatch(text, [/info\s*[:=]\s*([^\n]+)/i]);
  const vendorErrorCode = firstMatch(text, [/vendorErrorCode\s*[:=]\s*([^\s,;\n]+)/i]);
  const status = firstMatch(text, [/status\s*[:=]\s*([^\s,;\n]+)/i]);
  const connector = firstMatch(text, [/connectorId\s*[:=]\s*(\d+)/i, /conector\s+(\d+)/i]);
  const occurredAt = firstMatch(text, [/(?:UTC-3|BRT)\s*[:=]\s*([0-3]?\d\/[01]?\d\/\d{4},?\s*[0-2]?\d:[0-5]\d(?::[0-5]\d)?)/i, /UTC\s*[:=]\s*([0-3]?\d\/[01]?\d\/\d{4},?\s*[0-2]?\d:[0-5]\d(?::[0-5]\d)?)/i]);
  if (!errorCode && !info && !vendorErrorCode && !/\bFaulted\b/i.test(text)) return null;
  return {
    sourceMessageId: message.external_message_id || message.id,
    provenance: message.is_forwarded ? 'forwarded_alert' : 'conversation_report',
    verified: false,
    connectorId: connector ? Number(connector) : null,
    status,
    errorCode,
    vendorErrorCode,
    info,
    occurredAt,
  };
}

function participantClaim(message) {
  if (message.direction !== 'inbound' || message.is_forwarded) return null;
  const text = cleanBody(message);
  if (!/\b(acho|parece|deve|pode ser|[eé]\s+(?:a\s+)?rede|transformador|provavelmente|causa)\b/i.test(text)) return null;
  return {
    sourceMessageId: message.external_message_id || message.id,
    speaker: message.sender_id || 'participant',
    claim: text.slice(0, 300),
    verified: false,
    provenance: 'participant_report',
  };
}

function requestedAspects(question, messages) {
  const joined = [question, ...messages.slice(-8).map(cleanBody)].join('\n');
  const aspects = [];
  if (/\b(voltou|normal|recuper|resolveu)\b/i.test(joined)) aspects.push('recovery');
  if (/\b(vivo|sinal|online|offline|comunic|heartbeat)\b/i.test(joined)) aspects.push('connectivity');
  if (/\b(pot[eê]ncia|kw|kwh|energia|entreg)\b/i.test(joined)) aspects.push('power');
  if (/\b(causa|aconteceu|houve|por qu[eê]|transformador|rede)\b/i.test(joined)) aspects.push('cause');
  if (/\b(recarga|transa[cç][aã]o|tentativa|recusa|inici)\b/i.test(joined)) aspects.push('transactions');
  return aspects.length ? [...new Set(aspects)] : ['current_health'];
}

function reconstructIncidentContext(messages, triggerMessageId, options = {}) {
  const ordered = [...messages].sort((a, b) => parseProviderTime(a) - parseProviderTime(b));
  const trigger = ordered.find((message) => message.id === triggerMessageId || message.external_message_id === triggerMessageId);
  if (!trigger) throw new Error('trigger_message_not_found');
  const questionMessage = effectiveQuestion(ordered, trigger);
  const question = withoutMentions(cleanBody(questionMessage));
  const relevant = ordered.filter((message) => parseProviderTime(message) <= parseProviderTime(trigger));
  const allText = relevant.map(cleanBody).join('\n');
  const stationIds = stationIdsFrom(allText);
  const stationNames = stationNamesFrom([question, allText].join('\n'));
  const incidentSignals = relevant.map(incidentSignal).filter(Boolean);
  const participantClaims = relevant.map(participantClaim).filter(Boolean);
  const ambiguities = [];
  if (!question || questionMessage.id === trigger.id && isMentionOnly(trigger)) ambiguities.push('missing_effective_question');
  if (!stationIds.length && !stationNames.length) ambiguities.push('station_not_identified');
  const confidence = question && stationIds.length && incidentSignals.length ? 'high'
    : question && (stationIds.length || stationNames.length) ? 'medium'
      : 'low';
  const messageRefs = relevant.map((message, index) => ({
    id: message.external_message_id || message.id,
    speaker: message.id === trigger.id || message.sender_id === trigger.sender_id ? 'requester' : `participant_${index + 1}`,
    direction: message.direction,
    at: parseProviderTime(message).toISOString(),
    body: cleanBody(message).slice(0, 1000),
    quotedMessageId: message.quoted_message_id || null,
    forwarded: Boolean(message.is_forwarded),
  }));
  const context = {
    triggerMessageId: trigger.external_message_id || trigger.id,
    questionMessageId: questionMessage.external_message_id || questionMessage.id,
    effectiveQuestion: question,
    contextConfidence: confidence,
    stationHints: [
      ...stationIds.map((value) => ({ kind: 'id', value })),
      ...stationNames.map((value) => ({ kind: 'name', value })),
    ],
    incidentSignals,
    participantClaims,
    requestedAspects: requestedAspects(question, relevant),
    messageRefs,
    ambiguities,
  };
  return {
    ...context,
    contextFingerprint: crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex'),
  };
}

function buildConversationIncidentContext(conversationId, triggerMessageId, options = {}) {
  const { db } = require('./db');
  const hours = Math.max(1, Math.min(Number(options.contextHours || DEFAULT_CONTEXT_HOURS), 168));
  const limit = Math.max(1, Math.min(Number(options.maxMessages || DEFAULT_MAX_MESSAGES), 100));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT id, external_message_id, direction, body, raw_body, sender_id, sender_name,
           created_at, provider_timestamp, quoted_message_id, mentioned_jids_json,
           is_forwarded, forwarding_score
      FROM messages
     WHERE conversation_id = ? AND datetime(created_at) >= datetime(?)
     ORDER BY datetime(created_at) DESC
     LIMIT ?
  `).all(conversationId, since, limit).reverse();
  return reconstructIncidentContext(rows, triggerMessageId, options);
}

module.exports = {
  buildConversationIncidentContext,
  reconstructIncidentContext,
  isMentionOnly,
  stationIdsFrom,
};
