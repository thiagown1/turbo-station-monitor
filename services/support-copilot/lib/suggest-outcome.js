/**
 * /suggest response shaping — Support Copilot
 *
 * Pure, DB-free logic so it can be unit-tested without pulling in lib/db.js
 * (which opens a real sqlite connection as a side effect of being required).
 *
 * @module lib/suggest-outcome
 */
'use strict';

/**
 * Turn a generateSuggestion() result into the /suggest HTTP response shape.
 * [NO_REPLY] and [aguardando_cliente] both mean "nothing to send" — persisting
 * a null suggestion_text row for either just pollutes the suggestions table,
 * so the caller should skip the insert when shouldPersist is false.
 */
function formatSuggestOutcome(result) {
  if (result.waiting) {
    return {
      shouldPersist: false,
      response: {
        id: null,
        suggestion: null,
        model: 'waiting',
        waiting: true,
        message: 'Aguardando resposta do cliente',
      },
    };
  }
  if (result.noReply) {
    return {
      shouldPersist: false,
      response: {
        id: null,
        suggestion: null,
        model: 'no_reply',
        noReply: true,
        message: 'Conversa encerrada — não precisa de resposta',
      },
    };
  }
  return { shouldPersist: true, response: null };
}

module.exports = { formatSuggestOutcome };
