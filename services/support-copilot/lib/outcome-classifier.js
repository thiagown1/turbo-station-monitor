/**
 * Conversation outcome classifier — Support Copilot
 *
 * Runs once per close event (bot [NO_REPLY], operator manual close) and
 * classifies HOW the conversation ended, so the team can build support
 * metrics ("Desfechos") and see which failures are worth fixing.
 *
 * Deliberately a separate, focused LLM call from generateSuggestion() in
 * copilot.js — outcome classification is a different concern (grading a
 * finished conversation) from generating the next reply, and keeping it
 * separate means a prompt change to one never risks the other.
 *
 * Prompt building + response parsing are pure (lib/outcome-prompt.js); this
 * module wraps them with the actual LLM call + persistence.
 *
 * @module lib/outcome-classifier
 */
'use strict';

const { resolveSuggestionBackend, callSuggestionBackend } = require('./suggestion-backends');
const { stmts, nowIso, randomId } = require('./db');
const { LOG_TAG } = require('./constants');
const { OUTCOMES, NEGATIVE_OUTCOMES, buildOutcomePrompt, parseOutcomeResponse } = require('./outcome-prompt');

/**
 * Classify a just-closed conversation's outcome and persist it.
 * Fire-and-forget from the caller's perspective — never throws; a failure
 * here must not affect the close action that triggered it.
 */
async function classifyConversationOutcome(conversation, messages, { closedBy, tags, customSettings } = {}) {
  try {
    const backend = resolveSuggestionBackend(customSettings?.suggestion_backend);
    const prompt = buildOutcomePrompt(conversation, messages, { closedBy, tags });
    const result = await callSuggestionBackend(backend, { prompt });
    const rawText = result?.payloads?.[0]?.text || '';
    const parsed = parseOutcomeResponse(rawText);
    const model = result?.meta?.agentMeta
      ? `${result.meta.agentMeta.provider}/${result.meta.agentMeta.model || 'unknown'}`
      : backend;

    const id = randomId('outc');
    const now = nowIso();
    stmts.insertOutcome.run(
      id, conversation.id, conversation.brand_id, parsed.outcome, closedBy,
      parsed.rootCause, parsed.analysis, parsed.suggestion, model, now,
    );
    console.log(`${LOG_TAG} Outcome classified for conv ${conversation.id}: ${parsed.outcome} (closed_by=${closedBy})`);
    return { id, ...parsed, model, createdAt: now };
  } catch (err) {
    console.warn(`${LOG_TAG} Outcome classification failed for conv ${conversation.id} (non-blocking):`, err.message);
    return null;
  }
}

module.exports = {
  OUTCOMES,
  NEGATIVE_OUTCOMES,
  classifyConversationOutcome,
};
