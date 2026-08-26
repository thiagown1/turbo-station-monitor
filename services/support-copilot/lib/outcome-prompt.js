/**
 * Conversation outcome — prompt building + response parsing
 *
 * Pure, DB-free logic so it can be unit-tested without pulling in lib/db.js
 * (which opens a real sqlite connection as a side effect of being required).
 * lib/outcome-classifier.js wraps this with the actual LLM call + persistence.
 *
 * @module lib/outcome-prompt
 */
'use strict';

const MAX_MSG_BODY = 500;
function capBody(body) {
  if (!body) return '';
  return body.length > MAX_MSG_BODY ? body.substring(0, MAX_MSG_BODY) + '... [truncado]' : body;
}

// Cap total transcript sent to the classifier — outcome only needs the
// shape of how the conversation ended, not the full history for long chats.
const MAX_TRANSCRIPT_MESSAGES = 30;

const OUTCOMES = ['resolved_by_bot', 'resolved_by_operator', 'escalated', 'unresolved', 'abandoned', 'spam'];
// "Didn't work out" — the ones support should review and try to improve.
const NEGATIVE_OUTCOMES = new Set(['escalated', 'unresolved', 'abandoned']);

const CLOSED_BY_LABEL = {
  bot: 'o próprio bot (sem intervenção humana)',
  operator: 'um operador humano (fechamento manual)',
  auto_timeout: 'fechamento automático por inatividade',
};

/**
 * Build the classification prompt from a closed conversation's transcript.
 */
function buildOutcomePrompt(conversation, messages, { closedBy, tags } = {}) {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const history = recent.map((m) => {
    const role = m.direction === 'inbound' ? 'Cliente' : 'Operador/Bot';
    return `[${role}] ${capBody(m.body)}`;
  }).join('\n');

  const tagsLine = tags && tags.length > 0 ? `Tags da conversa: ${tags.join(', ')}` : '';

  return [
    `Você está analisando um atendimento de suporte via WhatsApp da Turbo Station (rede de carregamento de veículos elétricos) que ACABOU DE SER ENCERRADO.`,
    `Encerrado por: ${CLOSED_BY_LABEL[closedBy] || closedBy}.`,
    tagsLine,
    ``,
    `Transcrição (mensagens mais recentes):`,
    history,
    ``,
    `Classifique o DESFECHO deste atendimento em UMA destas categorias:`,
    `- resolved_by_bot: o próprio bot resolveu o problema, sem precisar de um operador humano`,
    `- resolved_by_operator: um operador humano resolveu o problema do cliente`,
    `- escalated: precisou ser encaminhado para outra equipe/setor/pessoa e a conversa encerrou antes de sabermos o resultado final`,
    `- unresolved: a conversa encerrou sem o problema do cliente ser resolvido (ex: travou no meio, faltou informação, ninguém respondeu a última pergunta do cliente)`,
    `- abandoned: o cliente sumiu/parou de responder antes de qualquer resolução real, mesmo com o atendimento tentando ajudar`,
    `- spam: não era um atendimento real (spam, teste, mensagem sem sentido)`,
    ``,
    `Se o desfecho NÃO for resolved_by_bot nem resolved_by_operator, analise o motivo e sugira uma melhoria concreta (no prompt do bot, no processo da equipe, ou na informação disponível sobre a estação/preço/etc).`,
    ``,
    `Responda APENAS em JSON válido, sem texto antes ou depois, neste formato exato:`,
    `{"outcome": "<uma das categorias acima>", "rootCause": "<categoria curta do motivo em snake_case, ou null se resolvido>", "analysis": "<1-2 frases explicando o que aconteceu, ou null se resolvido>", "suggestion": "<1 frase com uma mudança concreta sugerida, ou null se resolvido>"}`,
  ].filter(Boolean).join('\n');
}

/**
 * Parse the classifier's raw text into a validated outcome object.
 * Falls back to a safe 'unresolved' + parse-error note rather than throwing —
 * a bad classification should never break the close flow that triggered it.
 */
function parseOutcomeResponse(rawText) {
  const text = String(rawText || '').trim();

  // Robust JSON extraction: try the whole string, then a fenced block, then
  // the first {...} span — mirrors the pattern used for the ticket summarizer.
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braceSpan = text.match(/\{[\s\S]*\}/);
  if (braceSpan) candidates.push(braceSpan[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const outcome = OUTCOMES.includes(parsed.outcome) ? parsed.outcome : null;
      if (!outcome) continue;
      const clamp = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
      return {
        outcome,
        rootCause: clamp(parsed.rootCause, 100),
        analysis: clamp(parsed.analysis, 500),
        suggestion: clamp(parsed.suggestion, 500),
        parseOk: true,
      };
    } catch {
      // try next candidate
    }
  }

  return {
    outcome: 'unresolved',
    rootCause: 'classifier_parse_error',
    analysis: 'Não foi possível interpretar a resposta do classificador de desfecho.',
    suggestion: null,
    parseOk: false,
  };
}

module.exports = {
  OUTCOMES,
  NEGATIVE_OUTCOMES,
  buildOutcomePrompt,
  parseOutcomeResponse,
};
