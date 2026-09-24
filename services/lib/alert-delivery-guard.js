'use strict';

const DEFAULT_POLL_MS = [500, 1000, 2000, 3000];
const DEFAULT_RETRY_MS = 60_000;

function parsePollSchedule(raw) {
  if (!raw) return DEFAULT_POLL_MS;
  const parsed = String(raw)
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : DEFAULT_POLL_MS;
}

function resolveActivation(env = process.env) {
  if (env.OCPP_ALERTS_ENABLED !== '1') {
    return { enabled: false, ready: false, reason: 'kill_switch_disabled' };
  }

  const conversationId = String(env.ALERT_WHATSAPP_CONV || '').trim();
  const secret = String(env.SUPPORT_API_SECRET || env.MONITOR_API_SECRET || '').trim();
  const brand = String(env.ALERT_WHATSAPP_BRAND || 'turbo_station').trim();
  const baseUrl = String(env.SUPPORT_API_URL || '').trim().replace(/\/+$/, '');
  const missing = [];
  if (!conversationId) missing.push('ALERT_WHATSAPP_CONV');
  if (!secret) missing.push('SUPPORT_API_SECRET');
  if (!baseUrl) missing.push('SUPPORT_API_URL');
  if (!brand) missing.push('ALERT_WHATSAPP_BRAND');
  if (missing.length) {
    return { enabled: true, ready: false, reason: `missing:${missing.join(',')}` };
  }

  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    return { enabled: true, ready: false, reason: 'invalid:SUPPORT_API_URL' };
  }

  return { enabled: true, ready: true, conversationId, secret, brand, baseUrl };
}

function createSupportApiTransport({
  activation,
  fetchImpl = global.fetch,
  pollScheduleMs = parsePollSchedule(process.env.WHATSAPP_DELIVERY_POLL_MS),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) {
  if (!activation || !activation.ready) throw new Error(`OCPP alert transport is not ready: ${activation && activation.reason}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const headers = {
    'Content-Type': 'application/json',
    'x-api-secret': activation.secret,
    'x-brand-id': activation.brand,
  };

  async function status(messageId) {
    try {
      const url = `${activation.baseUrl}/api/support/conversations/${encodeURIComponent(activation.conversationId)}/messages?limit=50`;
      const response = await fetchImpl(url, { headers: { 'x-api-secret': activation.secret } });
      if (!response.ok) return 'unavailable';
      const json = await response.json().catch(() => null);
      const messages = json && Array.isArray(json.messages) ? json.messages : [];
      const message = messages.find((candidate) => candidate && candidate.id === messageId);
      return message && message.delivery_status ? message.delivery_status : 'pending';
    } catch {
      return 'unavailable';
    }
  }

  async function confirm(messageId) {
    for (const waitMs of pollScheduleMs) {
      await sleep(waitMs);
      const current = await status(messageId);
      if (current === 'sent' || current === 'failed') return current;
    }
    return 'unconfirmed';
  }

  async function send(text) {
    let response;
    try {
      const url = `${activation.baseUrl}/api/support/conversations/${encodeURIComponent(activation.conversationId)}/messages?brandId=${encodeURIComponent(activation.brand)}`;
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: text, source: 'system' }),
      });
    } catch (error) {
      logger.error(`WhatsApp POST outcome is ambiguous: ${error && error.message}`);
      return { outcome: 'ambiguous', messageId: null, status: 'unavailable' };
    }

    if (!response.ok) {
      return { outcome: 'rejected', messageId: null, status: `http_${response.status}` };
    }

    const json = await response.json().catch(() => null);
    const messageId = json && typeof json.id === 'string' && json.id ? json.id : null;
    if (!messageId) {
      logger.error('WhatsApp POST was accepted without a message id; automatic retry is blocked');
      return { outcome: 'ambiguous', messageId: null, status: 'accepted_without_id' };
    }

    const deliveryStatus = await confirm(messageId);
    if (deliveryStatus === 'sent') return { outcome: 'delivered', messageId, status: deliveryStatus };
    if (deliveryStatus === 'failed') return { outcome: 'failed', messageId, status: deliveryStatus };
    return { outcome: 'unconfirmed', messageId, status: deliveryStatus };
  }

  return { confirm, send, status };
}

async function advanceDelivery(item, text, transport, { now = Date.now(), retryMs = DEFAULT_RETRY_MS } = {}) {
  if (item._deliveryAmbiguous) {
    return { delivered: false, patch: {}, reason: 'ambiguous_requires_operator' };
  }

  if (item._deliveryMessageId) {
    const current = await transport.status(item._deliveryMessageId);
    if (current === 'sent') {
      return { delivered: true, patch: {}, reason: 'late_confirmed' };
    }
    if (current !== 'failed') {
      return { delivered: false, patch: {}, reason: `existing_${current}` };
    }
    item = {
      ...item,
      _deliveryMessageId: null,
      _lastFailedMessageId: item._deliveryMessageId,
    };
  }

  const lastAttemptAt = Number(item._deliveryAttemptAt || 0);
  if (lastAttemptAt && now - lastAttemptAt < retryMs) {
    return {
      delivered: false,
      patch: {
        _deliveryMessageId: item._deliveryMessageId || null,
        _lastFailedMessageId: item._lastFailedMessageId || null,
      },
      reason: 'retry_backoff',
    };
  }

  const result = await transport.send(text);
  if (result.outcome === 'delivered') {
    return { delivered: true, patch: {}, reason: 'confirmed' };
  }

  const patch = {
    _deliveryAttemptAt: now,
    _deliveryLastStatus: result.status,
  };
  if (result.messageId) patch._deliveryMessageId = result.messageId;
  if (result.outcome === 'ambiguous' && !result.messageId) patch._deliveryAmbiguous = true;
  return { delivered: false, patch, reason: result.outcome };
}

module.exports = {
  DEFAULT_RETRY_MS,
  advanceDelivery,
  createSupportApiTransport,
  parsePollSchedule,
  resolveActivation,
};
