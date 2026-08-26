/**
 * Customer account data resolver — Support Copilot (PHONE-POSSESSION VERIFIED)
 *
 * Account data is shared only when the conversation's WhatsApp number matches the
 * phone REGISTERED on the account. The live WhatsApp session is proof of
 * possession of that number (a passive OTP) — much stronger than a typed CPF,
 * which is widely leaked and anyone could type someone else's. So:
 *   conversation phone == account registered phone  →  VERIFIED → share state.
 *   no phone match                                  →  null     → no account data.
 *
 * Security/privacy:
 *  - Phone equality is normalized (country code, DDD, mobile 9th digit).
 *  - Returns OPERATIONAL state only; account CPF/email/phone are NEVER returned
 *    or sent to the LLM (can't leak what isn't there + blocks prompt injection).
 *
 * Data access: this calls the Next prod API. The narrow, lower-risk path is a
 * dedicated endpoint that does the phone match + minimization server-side (see
 * support-chat doc). Until that exists it uses users:search; gate behind
 * NEXT_API_KEY (scoped users:search). No key → null (graceful no-op).
 */
'use strict';

const NEXT_API_URL = (process.env.NEXT_API_URL || 'https://app.turbostation.com.br').replace(/\/$/, '');
const NEXT_API_KEY = process.env.NEXT_API_KEY || '';
const LOG_TAG = '[support-copilot]';

function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }

/** Canonical BR local number (DDD + 8) for comparison: strips +55 and the 9th digit. */
function canonPhone(s) {
  let d = digitsOf(s);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3);
  return d.slice(-10);
}

async function resolveCustomerData(phone, brandId) {
  if (!NEXT_API_KEY) return null;
  const digits = digitsOf(phone);
  if (digits.length < 10 || digits.length > 13) return null;
  const convCanon = canonPhone(phone);
  if (convCanon.length < 10) return null;
  const headers = {
    Accept: 'application/json',
    'x-api-key': NEXT_API_KEY,
    Authorization: `Bearer ${NEXT_API_KEY}`,
    ...(brandId ? { 'x-brand-id': brandId } : {}),
  };
  try {
    const sRes = await fetch(`${NEXT_API_URL}/api/users/search?q=${encodeURIComponent('+' + digits)}&pageSize=5`, { headers });
    if (!sRes.ok) return null;
    const sData = await sRes.json();
    const users = Array.isArray(sData.users) ? sData.users : [];
    // VERIFICATION = the account's registered phone matches the conversation phone.
    const match = users.find(u => canonPhone(u.phoneNumber) === convCanon) || null;
    if (!match || !match.id) return null; // no possession proof → no data

    const cRes = await fetch(`${NEXT_API_URL}/api/users/${encodeURIComponent(match.id)}/support-context`, { headers });
    if (!cRes.ok) return null;
    const ctx = await cRes.json();

    // Operational state only. NO cpf/email/phone (never to the LLM).
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

module.exports = { resolveCustomerData, canonPhone };
