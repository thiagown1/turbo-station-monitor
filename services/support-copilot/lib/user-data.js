/**
 * Customer account data resolver — Support Copilot (VERIFICATION-GATED)
 *
 * Resolves a WhatsApp contact's REAL account state, but only shares it once the
 * customer is VERIFIED — i.e. they provided a CPF in the conversation that
 * matches the account's CPF (the same check the human operators do before
 * sharing anything). Phone-match alone is NOT verification (a phone can be
 * shared/spoofed; prompt-injection could try to extract data otherwise).
 *
 * Security/privacy:
 *  - CPF comparison happens HERE (server-side); the account CPF/email/phone are
 *    NEVER returned/injected into the LLM prompt (can't leak what isn't there).
 *  - Unverified → returns { verified:false } so the prompt makes the bot ask for
 *    the CPF before sharing any account data.
 *  - Never logs the CPF.
 *
 * Requires NEXT_API_KEY (scoped users:search + admin view-users). Without it →
 * null (graceful: bot works as before, no account data).
 */
'use strict';

const NEXT_API_URL = (process.env.NEXT_API_URL || 'https://app.turbostation.com.br').replace(/\/$/, '');
const NEXT_API_KEY = process.env.NEXT_API_KEY || '';
const LOG_TAG = '[support-copilot]';

function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }

/** All 11-digit sequences in the text (formatted or raw) — CPF candidates. */
function extractCpfCandidates(text) {
  const out = new Set();
  const re = /\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const d = m[0].replace(/\D/g, '');
    if (d.length === 11) out.add(d);
  }
  return out;
}

/**
 * @param phone customer phone
 * @param brandId
 * @param conversationText recent messages joined (to find the customer-provided CPF)
 * @returns null | { verified:false } | { verified:true, ...operational state }
 */
async function resolveCustomerData(phone, brandId, conversationText) {
  if (!NEXT_API_KEY) return null;
  const digits = digitsOf(phone);
  if (digits.length < 10 || digits.length > 13) return null;
  const headers = {
    Accept: 'application/json',
    'x-api-key': NEXT_API_KEY,
    Authorization: `Bearer ${NEXT_API_KEY}`,
    ...(brandId ? { 'x-brand-id': brandId } : {}),
  };
  try {
    const sRes = await fetch(`${NEXT_API_URL}/api/users/search?q=${encodeURIComponent('+' + digits)}&pageSize=3`, { headers });
    if (!sRes.ok) return null;
    const sData = await sRes.json();
    const users = Array.isArray(sData.users) ? sData.users : [];
    const tail = digits.slice(-8);
    const match = users.find(u => digitsOf(u.phoneNumber).endsWith(tail)) || null;
    if (!match || !match.id) return null;

    const cRes = await fetch(`${NEXT_API_URL}/api/users/${encodeURIComponent(match.id)}/support-context`, { headers });
    if (!cRes.ok) return null;
    const ctx = await cRes.json();

    // ── Verification: does a CPF in the conversation match the account's CPF? ──
    const acctCpf = digitsOf(ctx.cpf || ctx.document);
    const provided = extractCpfCandidates(conversationText);
    const verified = acctCpf.length === 11 && provided.has(acctCpf);

    if (!verified) {
      return { verified: false }; // account exists, but not proven to be this person
    }

    // Verified → operational state only. NO cpf/email/phone (never to the LLM).
    return {
      verified: true,
      id: ctx.id,
      displayName: (ctx.displayName || '').trim().split(/\s+/)[0] || null, // first name only
      credits: typeof ctx.credits === 'number' ? ctx.credits : null,
      totalKWhUsed: ctx.totalKWhUsed,
      totalSpentMoney: ctx.totalSpentMoney,
      activeTransaction: ctx.activeTransaction || null,
      recentRecharges: Array.isArray(ctx.recentRecharges) ? ctx.recentRecharges : [],
      pendingTransactions: Array.isArray(ctx.pendingTransactions) ? ctx.pendingTransactions : [],
      balanceHistory: Array.isArray(ctx.balanceHistory) ? ctx.balanceHistory : [],
    };
  } catch (err) {
    console.warn(`${LOG_TAG} resolveCustomerData failed (non-blocking):`, err.message);
    return null;
  }
}

module.exports = { resolveCustomerData };
