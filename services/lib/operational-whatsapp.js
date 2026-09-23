'use strict';

/**
 * Inert by default. Activation is a separate operator step after checking the
 * configured conversation and the support relay. No automatic retry: a timeout
 * can mean that WhatsApp accepted the message even when this process did not
 * receive the response.
 */
async function sendOperationalWhatsApp(body, source, options = {}) {
  const env = options.env || process.env;
  if (env.OPERATIONAL_WHATSAPP_ENABLED !== 'true') {
    return { status: 'skipped_disabled' };
  }

  const conversationId = env.OPERATIONAL_WHATSAPP_CONVERSATION_ID || '';
  const secret = env.MONITOR_API_SECRET || env.SUPPORT_API_SECRET || '';
  if (!conversationId || !secret) return { status: 'skipped_unconfigured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const base = env.SUPPORT_COPILOT_URL || 'http://127.0.0.1:3005';
    const url = new URL(`/api/support/conversations/${encodeURIComponent(conversationId)}/messages`, base);
    url.searchParams.set('brandId', 'turbo_station');
    const response = await (options.fetchImpl || fetch)(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-brand-id': 'turbo_station',
        'x-api-secret': secret,
      },
      body: JSON.stringify({ body: String(body), source }),
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'failed', reason: `http_${response.status}` };
    const result = await response.json().catch(() => null);
    return { status: 'accepted', messageId: result?.id || null };
  } catch (error) {
    return { status: 'failed', reason: error?.name === 'AbortError' ? 'timeout_ambiguous' : 'unreachable_or_invalid_config' };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendOperationalWhatsApp };
