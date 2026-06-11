/**
 * Auto-respond gate — Support Copilot
 *
 * Pure decision function: given a conversation, the customer's last inbound
 * text, the bot's generated suggestion, and the brand's settings, decide whether
 * the bot may auto-send the reply to the customer — and if so, with how much
 * humanized delay.
 *
 * Design goals:
 *  - FAIL CLOSED. Every unmet condition returns { allow:false } with a reason.
 *  - DETERMINISTIC. No Date.now()/Math.random() inside — caller passes nowMs.
 *    Percentage rollout is a stable hash of the conversation id, so a given
 *    conversation is consistently in or out of the rollout (no flapping).
 *  - SAFE BY DEFAULT. With auto_respond off, or allowlist empty AND percent 0,
 *    nothing is ever sent. The rollout path is: allowlist=[test numbers] first,
 *    then widen percent 5 -> 25 -> 100 with allowlist cleared.
 *
 * Rollout order of checks (first failing one wins):
 *   1. master flag           auto_respond truthy
 *   2. suggestion usable      non-empty, not template-fallback, not [NO_REPLY]
 *   3. conversation eligible  whatsapp 1:1, not staff, not closed, has phone
 *   4. escalation triggers    money/refund, anger, human-request, LGPD, etc.
 *   5. business hours         inside configured window (if configured)
 *   6. allowlist              if non-empty, phone or conv id must be listed
 *   7. percentage rollout     hash(convId) % 100 < auto_respond_percent
 *   -> otherwise allow, with a length-based humanized delay.
 */

'use strict';

// Escalation triggers. Match on the CUSTOMER message and/or the BOT suggestion.
// Any hit means a human must handle it — the bot never auto-sends.
const ESCALATION_PATTERNS = [
  // Money / refunds / disputes
  { type: 'financeiro', re: /\b(reembols\w*|estorn\w*|cobran[çc]a indevida|cobrad\w* a mais|chargeback|estelionato|golpe|fraude|n[ãa]o reconhe[çc]o|valor errad\w*|duplicad\w*)\b/i },
  // Legal / regulators
  { type: 'juridico', re: /\b(procon|advogad\w*|processar|processo judicial|a[çc][ãa]o judicial|justi[çc]a|c[óo]digo de defesa|lgpd|dados pessoais|direito ao esquecimento)\b/i },
  // Explicit request for a human / phone call
  { type: 'pedido_humano', re: /\b(falar com (um |uma )?(atendente|humano|pessoa|respons[áa]vel|gerente|supervisor)|atendente humano|pessoa de verdade|algu[ée]m de verdade|me liga\w*|ligar para mim|liga[çc][ãa]o|telefone para contato)\b/i },
  // Anger / strong dissatisfaction / profanity
  { type: 'furioso', re: /\b(absurd\w*|rid[íi]cul\w*|p[ée]ssim\w*|horr[íi]vel|vergonha|inadmiss[íi]vel|palha[çc]ada|descaso|merda|porra|caralh\w*|vsf|vtnc|fdp)\b/i },
];

// Tags emitted by the suggestion that always force a human.
const ESCALATION_TAGS = ['furioso', 'financeiro', 'lgpd', 'hack-tentativa', 'reclamacao'];

// Inline control tokens in the suggestion that mean "don't send a normal reply".
const NON_REPLY_TOKENS = /\[(NO_REPLY|aguardando_cliente|aguardando)\]/i;

/** Stable, dependency-free string hash -> unsigned 32-bit (djb2 xor variant). */
function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return h >>> 0;
}

/** Bucket a conversation id into [0,100) deterministically. */
function rolloutBucket(convId) {
  return stableHash(String(convId || '')) % 100;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

/** Detect an escalation trigger in either the customer text or the suggestion. */
function detectEscalation(customerText, suggestionText, suggestionTags) {
  const tags = Array.isArray(suggestionTags) ? suggestionTags.map(t => String(t).toLowerCase()) : [];
  for (const tag of ESCALATION_TAGS) {
    if (tags.includes(tag)) return `tag:${tag}`;
  }
  const haystacks = [customerText, suggestionText];
  for (const { type, re } of ESCALATION_PATTERNS) {
    if (haystacks.some(h => h && re.test(h))) return type;
  }
  return null;
}

function parseBusinessHours(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Business-hours check. config = { tz?, days?: number[] (0=Sun), start: "HH:MM",
 * end: "HH:MM" }. Computes local hour/min/day from nowMs via the given IANA tz
 * (default America/Sao_Paulo). No config -> unrestricted.
 */
function withinBusinessHours(config, nowMs) {
  if (!config || (!config.start && !config.end)) return true;
  const tz = config.tz || 'America/Sao_Paulo';
  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
    parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map(p => [p.type, p.value]));
  } catch {
    return true; // bad tz -> don't block
  }
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  const nowMin = hour * 60 + minute;
  if (Array.isArray(config.days) && config.days.length && !config.days.includes(day)) return false;
  const toMin = (hhmm, dflt) => {
    if (!hhmm) return dflt;
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const startMin = toMin(config.start, 0);
  const endMin = toMin(config.end, 24 * 60);
  return nowMin >= startMin && nowMin < endMin;
}

/** Length-based humanized delay (ms). Deterministic; no randomness. */
function humanizedDelayMs(text, opts = {}) {
  const base = opts.baseMs != null ? opts.baseMs : 1500;
  const perChar = opts.perCharMs != null ? opts.perCharMs : 35;
  const max = opts.maxMs != null ? opts.maxMs : 9000;
  const len = (text || '').length;
  return Math.min(max, base + len * perChar);
}

/**
 * @returns {{allow: boolean, reason: string, delayMs?: number, typing?: boolean}}
 */
function evaluateAutoRespond({ conv = {}, lastInboundText = '', suggestion = {}, settings = {}, nowMs = 0, delayOpts } = {}) {
  // 1. Master flag
  if (!settings.auto_respond) return { allow: false, reason: 'flag_off' };

  // 2. Suggestion usable
  const text = (suggestion.text || '').trim();
  if (!text) return { allow: false, reason: 'empty_suggestion' };
  if (suggestion.model === 'template-fallback') return { allow: false, reason: 'template_fallback' };
  if (NON_REPLY_TOKENS.test(text)) return { allow: false, reason: 'non_reply_token' };

  // 3. Conversation eligible (real customer 1:1)
  if (conv.is_staff) return { allow: false, reason: 'staff_conv' };
  if (conv.status === 'closed') return { allow: false, reason: 'closed_conv' };
  if (conv.channel !== 'whatsapp') return { allow: false, reason: 'not_whatsapp_1to1' };
  if (!conv.customer_phone) return { allow: false, reason: 'no_phone' };

  // 4. Escalation triggers
  const escalation = detectEscalation(lastInboundText, text, suggestion.tags);
  if (escalation) return { allow: false, reason: `escalate:${escalation}` };

  // 5. Business hours
  if (!withinBusinessHours(parseBusinessHours(settings.auto_respond_business_hours), nowMs)) {
    return { allow: false, reason: 'outside_hours' };
  }

  // 6. Allowlist (when non-empty, it's a hard restriction)
  const allowlist = parseJsonArray(settings.auto_respond_allowlist);
  if (allowlist.length > 0) {
    const phoneDigits = digitsOnly(conv.customer_phone);
    const listed = allowlist.some(entry => {
      const e = String(entry);
      return e === conv.id || digitsOnly(e) === phoneDigits;
    });
    if (!listed) return { allow: false, reason: 'not_in_allowlist' };
    // Allowlisted conversations bypass the percentage gate.
    return { allow: true, reason: 'allowlisted', delayMs: humanizedDelayMs(text, delayOpts), typing: true };
  }

  // 7. Percentage rollout
  const percent = Math.max(0, Math.min(100, Number(settings.auto_respond_percent) || 0));
  if (percent <= 0) return { allow: false, reason: 'percent_zero' };
  if (rolloutBucket(conv.id) >= percent) return { allow: false, reason: 'percent_rollout' };

  return { allow: true, reason: 'percent_rollout', delayMs: humanizedDelayMs(text, delayOpts), typing: true };
}

module.exports = {
  evaluateAutoRespond,
  detectEscalation,
  withinBusinessHours,
  humanizedDelayMs,
  rolloutBucket,
  stableHash,
  ESCALATION_PATTERNS,
  ESCALATION_TAGS,
};
