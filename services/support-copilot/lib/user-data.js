/**
 * Customer account data resolver — Support Copilot
 *
 * Resolves a WhatsApp contact's REAL account state (credits, recent recharges,
 * active/pending transactions) by calling the Next.js prod API, so the bot can
 * answer account/recharge questions with facts instead of inventing. This is the
 * structural fix the real-traffic backtest pointed at (the live auto-suggest path
 * previously passed NO userData).
 *
 * Requires NEXT_API_KEY (an API key scoped to users:search + admin view-users).
 * Without it, returns null → the bot works exactly as before (no account data).
 *
 * Privacy (LGPD minimização): returns OPERATIONAL state only. Drops raw CPF /
 * email / phone so they're never sent to the LLM — the bot needs the account
 * STATE to help, not the identifiers.
 */
'use strict';

const NEXT_API_URL = (process.env.NEXT_API_URL || 'https://app.turbostation.com.br').replace(/\/$/, '');
const NEXT_API_KEY = process.env.NEXT_API_KEY || '';
const LOG_TAG = '[support-copilot]';

function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }

async function resolveCustomerData(phone, brandId) {
  if (!NEXT_API_KEY) return null; // not configured → graceful no-op
  const digits = digitsOf(phone);
  if (digits.length < 10 || digits.length > 13) return null; // skip LIDs / junk
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
    // Verify the phone actually matches (search is fuzzy) — compare last 8 digits.
    const tail = digits.slice(-8);
    const match = users.find(u => digitsOf(u.phoneNumber).endsWith(tail)) || null;
    if (!match || !match.id) return null;

    const cRes = await fetch(`${NEXT_API_URL}/api/users/${encodeURIComponent(match.id)}/support-context`, { headers });
    if (!cRes.ok) return null;
    const ctx = await cRes.json();

    // PII-minimized: operational state + first name only. No CPF/email/phone.
    return {
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
