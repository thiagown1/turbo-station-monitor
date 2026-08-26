/**
 * Evolution API Client — Support Copilot
 *
 * Sends outbound messages to WhatsApp via Evolution API REST endpoints.
 *
 * Docs: https://doc.evolution-api.com/v2
 *
 * Usage:
 *   const { sendText } = require('../lib/evolution-client');
 *   await sendText('turbostation', '5521999991234', 'Olá! Como posso ajudar?');
 *
 * @module lib/evolution-client
 */

const { EVOLUTION_API_URL, EVOLUTION_API_KEY, LOG_TAG } = require('./constants');

/**
 * Send a text message via Evolution API.
 *
 * @param {string} instance - Evolution API instance name (e.g. 'turbostation')
 * @param {string} phone - Phone number without @s.whatsapp.net (e.g. '5521999991234')
 * @param {string} text - Message body
 * @returns {Promise<object>} Evolution API response
 */
async function sendText(instance, phone, text) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${instance}`;
  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

  const payload = {
    number: jid,
    text,
  };

  console.log(`${LOG_TAG} Evolution → sendText to ${phone} via instance ${instance}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'unknown');
    const err = new Error(`Evolution API sendText failed: ${response.status} — ${errBody}`);
    err.statusCode = response.status;
    console.error(`${LOG_TAG} Evolution sendText error:`, err.message);
    throw err;
  }

  const result = await response.json();
  console.log(`${LOG_TAG} Evolution → sent OK, messageId=${result?.key?.id || 'unknown'}`);
  return result;
}

/**
 * Send a media message (image, video, audio, document) via Evolution API.
 *
 * @param {string} instance - Evolution API instance name
 * @param {string} phone - Phone number
 * @param {string} mediaType - 'image' | 'video' | 'audio' | 'document'
 * @param {string} media - Public URL or base64-encoded data of the media
 * @param {string} [caption] - Optional caption
 * @param {string} [fileName] - Optional file name (for documents)
 * @param {string} [mimetype] - Optional mimetype (e.g. 'image/png')
 * @returns {Promise<object>} Evolution API response
 */
async function sendMedia(instance, phone, mediaType, media, caption, fileName, mimetype) {
  const url = `${EVOLUTION_API_URL}/message/sendMedia/${instance}`;
  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

  const payload = {
    number: jid,
    mediatype: mediaType,
    media,
    caption: caption || '',
    fileName: fileName || undefined,
    mimetype: mimetype || undefined,
  };

  console.log(`${LOG_TAG} Evolution → sendMedia (${mediaType}) to ${phone} via instance ${instance}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'unknown');
    const err = new Error(`Evolution API sendMedia failed: ${response.status} — ${errBody}`);
    err.statusCode = response.status;
    console.error(`${LOG_TAG} Evolution sendMedia error:`, err.message);
    throw err;
  }

  const result = await response.json();
  console.log(`${LOG_TAG} Evolution → media sent OK`);
  return result;
}

/**
 * Check Evolution API instance connection status.
 *
 * @param {string} instance - Evolution API instance name
 * @returns {Promise<object>} { instance, state, statusReason }
 */
async function checkConnection(instance) {
  const url = `${EVOLUTION_API_URL}/instance/connectionState/${instance}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { apikey: EVOLUTION_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`Evolution API connectionState failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch WhatsApp profile picture URL for a phone number.
 *
 * @param {string} instance - Evolution API instance name
 * @param {string} phone - Phone number
 * @returns {Promise<string|null>} Profile picture URL or null
 */
async function fetchProfilePic(instance, phone) {
  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
  const url = `${EVOLUTION_API_URL}/chat/fetchProfilePictureUrl/${instance}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: jid }),
    });

    if (!response.ok) return null;
    const result = await response.json();
    return result?.profilePictureUrl || result?.url || result?.picture || null;
  } catch {
    return null;
  }
}

/**
 * Send a presence/typing indicator (best-effort; never throws).
 * presence: 'composing' (typing) | 'paused' | 'available'.
 */
async function sendPresence(instance, phone, presence = 'composing', delayMs = 0) {
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await fetch(`${EVOLUTION_API_URL}/chat/sendPresence/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: jid, presence, delay: delayMs }),
    });
  } catch (err) {
    console.warn(`${LOG_TAG} Evolution sendPresence (non-blocking):`, err.message);
  }
}

module.exports = { sendText, sendMedia, checkConnection, fetchProfilePic, sendPresence };

