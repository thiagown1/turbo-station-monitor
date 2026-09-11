const crypto = require('crypto');

const DEFAULT_CONTEXT_HOURS = 72;
const DEFAULT_MAX_MESSAGES = 40;
const PREFERRED_QUESTION_WINDOW_MS = 30 * 60 * 1000;
const STATION_STATE_WORDS = [
  'desarmou', 'caiu', 'parou', 'voltou', 'está', 'esta', 'tá', 'ta',
  'ficou', 'segue', 'continua', 'sumiu', 'travou', 'desligou', 'reiniciou',
  'perdeu', 'falhou', 'funciona', 'comunicou',
  'deu\\s+(?:erro|falha|problema)', 'teve\\s+(?:erro|falha|problema)',
  'apresentou\\s+(?:erro|falha|problema)',
];
const STATION_STATE_PATTERN = STATION_STATE_WORDS.join('|');
const STATION_STATE_MODIFIER_PATTERN = 'ainda|j[aá]|n[aã]o|se';
const STATION_INTERROGATIVE_PATTERN = 'qual|quais|algum(?:a|as)?|onde|que|por\\s+qu[eê]|como|quando|quem';
const STATION_INTERROGATIVE_PREFIX_PATTERN = new RegExp(`^(?:${STATION_INTERROGATIVE_PATTERN})\\b`, 'i');
const STATION_NON_NAME_FRAGMENT_PATTERN = [
  STATION_STATE_PATTERN,
  'agora', 'hoje', 'ontem', 'de\\s+manh[aã]', 'pela\\s+manh[aã]',
  '[àa]\\s+tarde', 'de\\s+tarde', '[àa]\\s+noite',
  'ainda', 'j[aá]', 'n[aã]o', 'atualmente', 'novamente', 'de\\s+novo',
  'no\\s+momento', 'offline', 'online', 'normal', 'funcionando', 'operacional',
  'com\\s+(?:falha|problema|erro)',
  'dando\\s+(?:falha|problema|erro)', 'de\\s+comunicar', 'comunica[cç][aã]o',
  'funcionar', 'de\\s+funcionar', 'sem\\s+funcionar',
  'por\\s+(?:causa|conta)(?:\\s+d[aeo])?(?:\\s+.+)?',
  'porque(?:\\s+.+)?',
  'devido\\s+(?:[àa]|ao|aos|[àa]s)(?:\\s+.+)?',
  'durante(?:\\s+.+)?', 'ap[oó]s(?:\\s+.+)?',
  '(?:depois|antes)\\s+d[aeo](?:\\s+.+)?', 'desde\\s+.+',
  'fora\\s+do\\s+ar', 'sem\\s+(?:energia|sinal|internet|comunica[cç][aã]o)',
  'tudo', 'todos?', 'todas?', 'algo', 'nada', 'todo\\s+mundo',
  'ess(?:e|a|es|as)', 'aquel(?:e|a|es|as)', 'isto', 'isso', 'aquilo',
  'aqui', 'ali', 'acol[aá]', 'l[aá]', 'a[ií]',
].join('|');
const GENERIC_STATION_NOUNS = [
  ['alimenta[cç][aã]o', 'alimentacao'], ['carregador', 'carregador'],
  ['conector', 'conector'], ['disjuntor', 'disjuntor'], ['energia', 'energia'],
  ['equipamento', 'equipamento'], ['esta[cç][aã]o', 'estacao'],
  ['fornecimento', 'fornecimento'], ['internet', 'internet'], ['local', 'local'],
  ['luz', 'luz'], ['posto', 'posto'], ['rede', 'rede'], ['servidor', 'servidor'],
  ['sinal', 'sinal'], ['sistema', 'sistema'], ['transformador', 'transformador'],
  ['unidade', 'unidade'],
];
const STATION_NOUN_PREFIX_PATTERN = GENERIC_STATION_NOUNS.map(([pattern]) => pattern).join('|');
const STATION_EQUIPMENT_IDENTIFIER_PATTERN = '(?:n(?:[.º°o])?\\s*)?(?:#?\\d{1,3}|[a-z])';
const STATION_NOUN_SEQUENCE_PATTERN = `(?:(?:esta[cç][aã]o\\s+de\\s+recarga|${STATION_NOUN_PREFIX_PATTERN})(?:\\s+(?:${STATION_EQUIPMENT_IDENTIFIER_PATTERN}))?\\s+(?:(?:do|da|de|no|na)\\s+)?)*`;
const GENERIC_STATION_SUBJECTS = new Set([
  ...GENERIC_STATION_NOUNS.map(([, normalized]) => normalized),
  'normal', 'ele', 'ela',
  'isso', 'ai', 'la',
]);

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
  const hasStationState = new RegExp(`(?:^|\\s)(?:${STATION_STATE_PATTERN})(?=\\s|$|[?!,.])`, 'i').test(value);
  return value.includes('?') || hasStationState
    || /\b(confirma|consegue|verifica|normal|vivo|sinal|aconteceu|houve|falha|erro|offline|online|pot[eê]ncia|carregador|esta[cç][aã]o)\b/i.test(value);
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
  const unanswered = prior.filter((candidate) => !messages.some((message) =>
    message.direction === 'outbound'
    && parseProviderTime(message) > parseProviderTime(candidate)
    && parseProviderTime(message) < parseProviderTime(trigger)));
  const preferred = unanswered.find((message) => triggerAt - parseProviderTime(message).getTime() <= PREFERRED_QUESTION_WINDOW_MS);
  if (preferred) return preferred;

  // A real group can mention the agent well after asking (the Lago Norte case
  // waited ~67 minutes). Fall back only when no operator/bot outbound answer
  // exists after the candidate, so an old resolved issue is never reopened.
  return unanswered[0] || trigger;
}

function stationIdsFrom(text) {
  const values = String(text || '').match(/\b(?:[A-Z]{1,8}\d{6,16}|\d{10,16})\b/g) || [];
  return [...new Set(values.map((value) => value.toUpperCase()))];
}

function normalizedStationName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function uniqueStationNames(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = normalizedStationName(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function stateFirstStationName(raw) {
  const leadingPredicate = new RegExp(`^(?:${STATION_NON_NAME_FRAGMENT_PATTERN})(?:\\s+(?:o|a))?\\s+`, 'i');
  const trailingPredicate = new RegExp(`(?:^|\\s)(?:${STATION_NON_NAME_FRAGMENT_PATTERN})$`, 'i');
  const leadingStationNouns = new RegExp(`^${STATION_NOUN_SEQUENCE_PATTERN}`, 'i');
  let name = String(raw || '').trim();
  if (/^(?:por\s+(?:causa|conta)\b|porque\b|devido\s+(?:[àa]|ao|aos|[àa]s)(?=\s|$)|durante\b|ap[oó]s\b|(?:depois|antes)\s+d[aeo]\b|desde\b)/i.test(name)) return '';
  let previous;
  do {
    previous = name;
    name = name
      .replace(leadingPredicate, '')
      .replace(/^(?:ao\s+normal|ao\s+ar)(?:(?:\s+(?:o|a))?\s+|$)/i, '')
      .replace(/^(?:no|na)\s+/i, '')
      .replace(leadingStationNouns, '')
      .replace(trailingPredicate, '')
      .trim();
  } while (name !== previous);
  return name;
}

function stationNamesFrom(text, options = {}) {
  const includeExplicit = options.includeExplicit !== false;
  const includeNatural = options.includeNatural !== false;
  const value = String(text || '');
  const candidates = [];

  const addCandidate = (raw) => {
    const name = String(raw || '')
      .replace(/^[\s,.;:!?…–—-]+|[\s,.;:!?…–—-]+$/g, '')
      .replace(/^(?:o|a)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const normalized = normalizedStationName(name);
    if (name.length < 3) return;
    if (STATION_INTERROGATIVE_PREFIX_PATTERN.test(name)) return;
    if (GENERIC_STATION_SUBJECTS.has(normalized)) return;
    if (new RegExp(`^(?:${STATION_NON_NAME_FRAGMENT_PATTERN})$`, 'i').test(name)) return;
    candidates.push(name);
  };

  if (includeExplicit) {
    // Explicit station labels remain useful throughout the incident context,
    // including forwarded equipment alerts that precede the request.
    for (const match of value.matchAll(/(?:🏢\s*|esta[cç][aã]o\s*(?::|-)\s*)([^\n,.!?]{0,80})/gi)) {
      const tail = match[1].trim();
      const state = new RegExp(`(?:^|\\s)(?:${STATION_STATE_PATTERN})(?=\\s|$|[?!,.])`, 'i').exec(tail);
      addCandidate(state ? tail.slice(0, state.index) : tail);
    }
  }

  // Natural group-chat phrasing: “Habibs desarmou?”, “o carregador do
  // Habibs está offline?”, “será que o Primor caiu?”. The state word is a
  // delimiter, never part of the candidate station name. Natural names are
  // only extracted from the effective question, never unrelated history.
  if (includeNatural) {
    for (const line of value.split(/\r?\n/)) {
      const conversational = withoutMentions(line)
        .replace(/^(?:bom\s+dia|boa\s+tarde|boa\s+noite|oi|ol[aá])(?:[\s,.;:!?…\-–—]+pessoal)?[\s,.;:!?…\-–—]*/i, '')
        .replace(/^(?:pessoal|gente|por\s+(?:favor|gentileza))[\s,.;:!?…\-–—]+/i, '')
        .replace(/^(?:eu\s+)?(?:acho|parece)\s+que\s+/i, '')
        .replace(/^(?:algu[eé]m\s+sabe|queria\s+saber)\s+se\s+/i, '')
        .replace(/^(?:por\s+(?:favor|gentileza)[\s,!:\-–—]*)?(?:(?:voc[eê]s?|vcs?)\s+)?(?:ser[aá]\s+que|sabe(?:m)?\s+(?:se|como|qual(?:is)?)|(?:consegue(?:m)?|pode(?:m)?)\s+(?:verificar|confirmar|ver)\b(?:\s+(?:pra|para)\s+(?:mim|(?:a\s+)?gente|n[oó]s))?(?:\s+se)?|(?:confirma(?:m)?|verifica(?:m)?|v[eê](?:em)?)(?:\s+(?:pra|para)\s+(?:mim|(?:a\s+)?gente|n[oó]s))?(?:\s+se)?)[\s,!:\-–—]*/i, '')
        .replace(/^[^?!\n]{0,80}?\bse\s+(?=(?:o|a)\s+)/i, '')
        .replace(new RegExp(`^(?:ess[ae]|aquel[ae])\\s+(?=(?:${STATION_NOUN_PREFIX_PATTERN})\\b)`, 'i'), '')
        .replace(/^esta[cç][aã]o\s*[:\-]\s*/i, '')
        .replace(/^(?:eu\s+)?(?:acho|parece)\s+que\s+/i, '')
        .replace(/^(?:(?:agora|hoje|ontem|de\s+manh[aã]|pela\s+manh[aã]|[àa]\s+tarde|de\s+tarde|[àa]\s+noite|ainda|j[aá]|atualmente|novamente|de\s+novo|no\s+momento)\s+)+/i, '')
        .trim();
      const stateFirst = new RegExp(
        `^(?:como\\s+)?(?:(?:${STATION_NON_NAME_FRAGMENT_PATTERN})\\s+)*(?:${STATION_STATE_PATTERN}|anda)\\s+(?:(?:o|a)\\s+)?${STATION_NOUN_SEQUENCE_PATTERN}(.{2,80}?)(?=\\s*[?!,.…]*$)`,
        'i',
      ).exec(conversational);
      if (stateFirst) {
        addCandidate(stateFirstStationName(stateFirst[1]));
        continue;
      }
      const natural = new RegExp(
        `^(?:(?:o|a)\\s+)?${STATION_NOUN_SEQUENCE_PATTERN}(.{2,80}?)\\s+(?:(?:${STATION_STATE_MODIFIER_PATTERN})\\s+)*(?:${STATION_STATE_PATTERN})(?=\\s|$|[?!,.])`,
        'i',
      ).exec(conversational);
      if (natural) addCandidate(natural[1]);
    }
  }
  return uniqueStationNames(candidates);
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
  const stationNames = uniqueStationNames([
    ...stationNamesFrom(allText, { includeNatural: false }),
    ...stationNamesFrom(question, { includeExplicit: false }),
  ]);
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
