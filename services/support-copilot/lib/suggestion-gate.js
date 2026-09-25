/**
 * Suggestion-generation gate — Support Copilot
 *
 * The copilot used to generate reply suggestions (and learned rules, session
 * summaries and session injections) through the OpenClaw agent CLI/gateway.
 * That harness is being switched off, so:
 *
 *  - Suggestion generation is OFF unless SUPPORT_COPILOT_SUGGESTIONS_ENABLED is
 *    exactly 'true' (fail closed: unset, empty, typos and 'TRUE' all stay off).
 *  - The OpenClaw 'agent' backend is retired for good. Even with the flag on,
 *    only the stateless backends (claude-cli / openrouter) may run.
 *
 * Every skip is logged with a stable reason so it stays auditable in the pm2
 * logs. Message ingestion, storage, sending and the Contador flows do not go
 * through this gate.
 *
 * @module lib/suggestion-gate
 */
'use strict';

const SKIP_SUGGESTIONS_DISABLED = 'suggestions_disabled';
const SKIP_AGENT_BACKEND_RETIRED = 'agent_backend_retired';
const OPENCLAW_AGENT_RETIRED = 'openclaw_agent_retired';

function suggestionsEnabled(env = process.env) {
  return env.SUPPORT_COPILOT_SUGGESTIONS_ENABLED === 'true';
}

/**
 * Decide whether a suggestion may be generated with the resolved backend.
 * Returns { allowed: true } or { allowed: false, reason }.
 */
function suggestionDecision(backend, env = process.env) {
  if (!suggestionsEnabled(env)) return { allowed: false, reason: SKIP_SUGGESTIONS_DISABLED };
  if (backend === 'agent') return { allowed: false, reason: SKIP_AGENT_BACKEND_RETIRED };
  return { allowed: true };
}

/** The result generateSuggestion() returns when it skips. */
function skippedSuggestion(reason) {
  return { text: null, model: 'skipped', skipped: reason };
}

function logSkip(logTag, action, reason, detail = '', logger = console) {
  logger.log(`${logTag} [copilot-skip] action=${action} reason=${reason}${detail ? ` ${detail}` : ''}`);
}

module.exports = {
  SKIP_SUGGESTIONS_DISABLED,
  SKIP_AGENT_BACKEND_RETIRED,
  OPENCLAW_AGENT_RETIRED,
  suggestionsEnabled,
  suggestionDecision,
  skippedSuggestion,
  logSkip,
};
