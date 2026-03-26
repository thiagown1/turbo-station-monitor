/**
 * WhatsApp Gateway — Multi-instance Baileys + Webhook
 *
 * Manages multiple WhatsApp connections (one per brand).
 * Each instance has its own auth state, QR code, and connection lifecycle.
 *
 * Dashboard API:
 *   POST   /instance/create          — create + start pairing (returns QR)
 *   GET    /instance/:name/qr        — get current QR code
 *   GET    /instance/:name/status    — connection status
 *   POST   /instance/:name/disconnect — logout + clear session
 *   DELETE /instance/:name           — remove instance entirely
 *   GET    /instances                — list all instances + statuses
 *
 * Messaging API:
 *   POST   /message/sendText/:name   — send text message
 *   POST   /message/sendMedia/:name  — send media message
 *
 * Health:
 *   GET    /health                   — service health + all instance states
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── Config ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.GATEWAY_PORT || '3006', 10);
const BASE_AUTH_DIR = process.env.GATEWAY_AUTH_DIR || path.join(__dirname, 'auth');
const WEBHOOK_URL = process.env.GATEWAY_WEBHOOK_URL || 'http://localhost:3005/api/support/ingest/evolution';
const WEBHOOK_SECRET = process.env.EVOLUTION_WEBHOOK_SECRET || '';
const LOG_TAG = '[whatsapp-gw]';

// ─── Instance store ────────────────────────────────────────────────────────

/**
 * Map<instanceName, {
 *   sock: WASocket | null,
 *   state: 'disconnected' | 'connecting' | 'open',
 *   qr: string | null,
 *   error: string | null,
 *   createdAt: string,
 *   connectedAt: string | null,
 *   phoneNumber: string | null,
 *   reconnectTimer: NodeJS.Timeout | null,
 * }>
 */
const instances = new Map();

const logger = pino({ level: 'warn' });

// ─── Helpers ───────────────────────────────────────────────────────────────

function authDir(name) {
  return path.join(BASE_AUTH_DIR, name);
}

function getInstance(name) {
  return instances.get(name) || null;
}

function instanceSummary(name) {
  const inst = instances.get(name);
  if (!inst) return null;
  return {
    instance: name,
    state: inst.state,
    hasQR: !!inst.qr,
    error: inst.error,
    createdAt: inst.createdAt,
    connectedAt: inst.connectedAt,
    phoneNumber: inst.phoneNumber,
  };
}

// ─── Webhook sender ────────────────────────────────────────────────────────

function sendWebhook(instanceName, event, data) {
  const payload = JSON.stringify({ event, instance: instanceName, data });

  const url = new URL(WEBHOOK_URL);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(WEBHOOK_SECRET ? { 'x-webhook-secret': WEBHOOK_SECRET } : {}),
    },
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode >= 300) {
        console.error(`${LOG_TAG} [${instanceName}] Webhook ${event} failed: ${res.statusCode} — ${body}`);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`${LOG_TAG} [${instanceName}] Webhook ${event} error:`, err.message);
  });

  req.write(payload);
  req.end();
}

// ─── Baileys connection per instance ───────────────────────────────────────

async function startInstance(name) {
  const dir = authDir(name);
  fs.mkdirSync(dir, { recursive: true });

  let inst = instances.get(name);
  if (!inst) {
    inst = {
      sock: null,
      state: 'disconnected',
      qr: null,
      error: null,
      createdAt: new Date().toISOString(),
      connectedAt: null,
      phoneNumber: null,
      reconnectTimer: null,
    };
    instances.set(name, inst);
  }

  // If already connected, skip
  if (inst.state === 'open' && inst.sock) {
    console.log(`${LOG_TAG} [${name}] Already connected, skipping`);
    return;
  }

  // Clean up previous socket
  if (inst.sock) {
    try { inst.sock.end(); } catch {}
    inst.sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`${LOG_TAG} [${name}] Starting Baileys v${version.join('.')}`);
  inst.state = 'connecting';

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  inst.sock = sock;

  // ─── Connection events ─────────────────────────────────────────────

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      inst.qr = qr;
      inst.state = 'connecting';
      console.log(`${LOG_TAG} [${name}] QR code generated — GET /instance/${name}/qr to retrieve`);
      qrcode.generate(qr, { small: true }, (text) => {
        console.log(`${LOG_TAG} [${name}] QR:\n${text}`);
      });
    }

    if (connection === 'open') {
      inst.qr = null;
      inst.state = 'open';
      inst.error = null;
      inst.connectedAt = new Date().toISOString();

      // Try to extract phone number from creds
      try {
        const me = sock.user;
        if (me?.id) {
          inst.phoneNumber = me.id.split(':')[0].split('@')[0];
        }
      } catch {}

      console.log(`${LOG_TAG} [${name}] ✅ Connected! Phone: ${inst.phoneNumber || 'unknown'}`);
      sendWebhook(name, 'connection.update', { state: 'open', phone: inst.phoneNumber });
    }

    if (connection === 'close') {
      inst.state = 'disconnected';
      inst.sock = null;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      console.log(`${LOG_TAG} [${name}] ❌ Closed. Reason: ${reason}. Reconnect: ${shouldReconnect}`);
      inst.error = `Disconnected: ${reason}`;

      if (shouldReconnect) {
        console.log(`${LOG_TAG} [${name}] Reconnecting in 5s...`);
        inst.reconnectTimer = setTimeout(() => startInstance(name), 5000);
      } else {
        console.log(`${LOG_TAG} [${name}] Logged out — needs re-pairing`);
        inst.connectedAt = null;
        inst.phoneNumber = null;
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Message handler ───────────────────────────────────────────────

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const webhookData = {
        key: {
          remoteJid: msg.key.remoteJid,
          fromMe: msg.key.fromMe || false,
          id: msg.key.id,
          participant: msg.key.participant || null,
        },
        pushName: msg.pushName || null,
        message: msg.message || {},
        messageType: Object.keys(msg.message || {})[0] || 'unknown',
        messageTimestamp: typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : parseInt(msg.messageTimestamp?.toString() || '0', 10),
      };

      // Download media and include base64 in webhook payload
      const mediaTypes = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage'];
      if (msg.message && mediaTypes.includes(webhookData.messageType)) {
        try {
          const { downloadMediaMessage } = require('baileys');
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          webhookData.mediaBase64 = buffer.toString('base64');
          webhookData.mediaMimetype = msg.message[webhookData.messageType]?.mimetype || 'application/octet-stream';
          console.log(`${LOG_TAG} [${name}] Downloaded media: ${webhookData.messageType} (${buffer.length} bytes)`);
        } catch (err) {
          console.error(`${LOG_TAG} [${name}] Media download failed:`, err.message);
        }
      }

      console.log(`${LOG_TAG} [${name}] Message from ${msg.key.remoteJid} (fromMe=${msg.key.fromMe}): ${webhookData.messageType}`);
      sendWebhook(name, 'messages.upsert', webhookData);
    }
  });
}

// ─── Auto-start existing instances ─────────────────────────────────────────

function autoStartExisting() {
  if (!fs.existsSync(BASE_AUTH_DIR)) return;

  const dirs = fs.readdirSync(BASE_AUTH_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const name of dirs) {
    // Check if creds.json exists (has been paired before)
    const credsFile = path.join(BASE_AUTH_DIR, name, 'creds.json');
    if (fs.existsSync(credsFile)) {
      console.log(`${LOG_TAG} Auto-starting instance: ${name}`);
      startInstance(name).catch(err => {
        console.error(`${LOG_TAG} [${name}] Auto-start failed:`, err.message);
      });
    }
  }
}

// ─── Express API ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const allInstances = [];
  for (const [name] of instances) {
    allInstances.push(instanceSummary(name));
  }
  res.json({
    ok: true,
    service: 'whatsapp-gateway',
    instances: allInstances,
  });
});

// ── List instances ─────────────────────────────────────────────────────

app.get('/instances', (_req, res) => {
  const list = [];
  for (const [name] of instances) {
    list.push(instanceSummary(name));
  }
  res.json({ instances: list });
});

// ── Create + start instance ────────────────────────────────────────────

app.post('/instance/create', async (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
    return res.status(400).json({ error: 'name required (alphanumeric, hyphens, underscores)' });
  }

  const existing = instances.get(name);
  if (existing && existing.state === 'open') {
    return res.json({ ...instanceSummary(name), message: 'Already connected' });
  }

  try {
    await startInstance(name);

    // Wait a bit for QR to be generated
    await new Promise(r => setTimeout(r, 2000));

    const inst = instances.get(name);
    const summary = instanceSummary(name);

    if (inst?.qr) {
      summary.qr = inst.qr;
      summary.message = 'Scan the QR code with WhatsApp to connect.';
    } else if (inst?.state === 'open') {
      summary.message = 'Already connected (using saved credentials).';
    } else {
      summary.message = 'Starting... QR code will be available at GET /instance/' + name + '/qr';
    }

    res.status(201).json(summary);
  } catch (err) {
    console.error(`${LOG_TAG} [${name}] Create failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get QR code ────────────────────────────────────────────────────────

app.get('/instance/:name/qr', (req, res) => {
  const inst = instances.get(req.params.name);

  if (!inst) {
    return res.status(404).json({ error: 'Instance not found. Create it first: POST /instance/create' });
  }

  if (inst.state === 'open') {
    return res.json({
      instance: req.params.name,
      status: 'connected',
      phone: inst.phoneNumber,
      message: 'Already connected, no QR needed.',
    });
  }

  if (!inst.qr) {
    return res.json({
      instance: req.params.name,
      status: 'waiting',
      message: 'QR not yet available. Instance is starting up...',
    });
  }

  // Text format for terminals
  if (req.query.format === 'text') {
    res.type('text/plain');
    qrcode.generate(inst.qr, { small: true }, (text) => {
      res.send(text);
    });
    return;
  }

  // JSON format (for dashboard to render via a QR library)
  res.json({
    instance: req.params.name,
    status: 'pending',
    qr: inst.qr,
    message: 'Scan this QR code with WhatsApp.',
  });
});

// ── Instance status ────────────────────────────────────────────────────

app.get('/instance/:name/status', (req, res) => {
  const summary = instanceSummary(req.params.name);
  if (!summary) {
    return res.status(404).json({ error: 'Instance not found' });
  }
  res.json(summary);
});

// ── Disconnect (logout + clear auth) ───────────────────────────────────

app.post('/instance/:name/disconnect', async (req, res) => {
  const name = req.params.name;
  const inst = instances.get(name);

  if (!inst) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  // Clear reconnect timer if pending
  if (inst.reconnectTimer) {
    clearTimeout(inst.reconnectTimer);
    inst.reconnectTimer = null;
  }

  // Logout from WhatsApp
  if (inst.sock) {
    try {
      await inst.sock.logout();
      console.log(`${LOG_TAG} [${name}] Logged out from WhatsApp`);
    } catch (err) {
      console.warn(`${LOG_TAG} [${name}] Logout error (may already be disconnected):`, err.message);
    }
    try { inst.sock.end(); } catch {}
    inst.sock = null;
  }

  // Clear auth state
  const dir = authDir(name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`${LOG_TAG} [${name}] Auth state cleared`);
  }

  inst.state = 'disconnected';
  inst.qr = null;
  inst.error = null;
  inst.connectedAt = null;
  inst.phoneNumber = null;

  res.json({ ok: true, message: `Instance ${name} disconnected and session cleared.` });
});

// ── Delete instance entirely ───────────────────────────────────────────

app.delete('/instance/:name', async (req, res) => {
  const name = req.params.name;
  const inst = instances.get(name);

  if (!inst) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  // Clean up
  if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
  if (inst.sock) {
    try { await inst.sock.logout(); } catch {}
    try { inst.sock.end(); } catch {}
  }

  // Remove auth folder
  const dir = authDir(name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  instances.delete(name);
  console.log(`${LOG_TAG} [${name}] Instance deleted`);
  res.json({ ok: true, message: `Instance ${name} deleted.` });
});

// ── Send text message ──────────────────────────────────────────────────

app.post('/message/sendText/:instance', async (req, res) => {
  const inst = instances.get(req.params.instance);
  if (!inst || inst.state !== 'open') {
    return res.status(503).json({ error: 'Instance not connected' });
  }

  const { number, text } = req.body;
  if (!number || !text) {
    return res.status(400).json({ error: 'number and text required' });
  }

  const jid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;

  try {
    const result = await inst.sock.sendMessage(jid, { text });
    console.log(`${LOG_TAG} [${req.params.instance}] Sent text to ${jid}`);
    res.json({ ok: true, key: result.key });
  } catch (err) {
    console.error(`${LOG_TAG} [${req.params.instance}] Send failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Send media message ─────────────────────────────────────────────────

app.post('/message/sendMedia/:instance', async (req, res) => {
  const inst = instances.get(req.params.instance);
  if (!inst || inst.state !== 'open') {
    return res.status(503).json({ error: 'Instance not connected' });
  }

  const { number, mediatype, media, caption, fileName } = req.body;
  if (!number || !media) {
    return res.status(400).json({ error: 'number and media required' });
  }

  const jid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;

  try {
    let content;
    switch (mediatype) {
      case 'image': content = { image: { url: media }, caption }; break;
      case 'video': content = { video: { url: media }, caption }; break;
      case 'audio': content = { audio: { url: media }, mimetype: 'audio/ogg; codecs=opus' }; break;
      case 'document': content = { document: { url: media }, fileName: fileName || 'file', caption }; break;
      default: return res.status(400).json({ error: `Unknown mediatype: ${mediatype}` });
    }

    const result = await inst.sock.sendMessage(jid, content);
    console.log(`${LOG_TAG} [${req.params.instance}] Sent ${mediatype} to ${jid}`);
    res.json({ ok: true, key: result.key });
  } catch (err) {
    console.error(`${LOG_TAG} [${req.params.instance}] Send media failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connection state (Evolution API compat) ────────────────────────────

app.get('/instance/connectionState/:instance', (req, res) => {
  const inst = instances.get(req.params.instance);
  res.json({
    instance: req.params.instance,
    state: inst?.state || 'not_found',
  });
});

// ── Group metadata (fetch group name/subject) ──────────────────────────

app.get('/group/:instance/:jid/metadata', async (req, res) => {
  const inst = instances.get(req.params.instance);
  if (!inst || inst.state !== 'open') {
    return res.status(503).json({ error: 'Instance not connected' });
  }

  const jid = req.params.jid;
  if (!jid.endsWith('@g.us')) {
    return res.status(400).json({ error: 'Invalid group JID (must end with @g.us)' });
  }

  try {
    const metadata = await inst.sock.groupMetadata(jid);
    res.json({
      id: metadata.id,
      subject: metadata.subject,
      subjectOwner: metadata.subjectOwner,
      subjectTime: metadata.subjectTime,
      size: metadata.size || metadata.participants?.length || 0,
      creation: metadata.creation,
      desc: metadata.desc,
      owner: metadata.owner,
      participants: (metadata.participants || []).map(p => ({
        id: p.id,
        admin: p.admin || null,
      })),
    });
  } catch (err) {
    console.error(`${LOG_TAG} [${req.params.instance}] Group metadata failed for ${jid}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy single-instance /qr compat ──────────────────────────────────

app.get('/qr', (req, res) => {
  // Find first instance with a QR
  for (const [name, inst] of instances) {
    if (inst.qr) {
      return res.redirect(`/instance/${name}/qr${req.query.format ? '?format=' + req.query.format : ''}`);
    }
  }
  // Find first instance
  const firstName = instances.keys().next().value;
  if (firstName) {
    return res.redirect(`/instance/${firstName}/qr${req.query.format ? '?format=' + req.query.format : ''}`);
  }
  res.json({ status: 'no_instances', message: 'No instances created. POST /instance/create first.' });
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`${LOG_TAG} API listening on port ${PORT}`);
  console.log(`${LOG_TAG} Webhook target: ${WEBHOOK_URL}`);
  console.log(`${LOG_TAG} Auth base dir: ${BASE_AUTH_DIR}`);

  // Auto-start any previously paired instances
  autoStartExisting();
});
