/**
 * PIX Receipt Extractor — Support Copilot
 *
 * Reads a PIX comprovante posted in a partner's WhatsApp group (image or PDF)
 * and extracts the financial fields — amount in CENTS + transaction ref — via a
 * structured vision call. Consumed by GET /api/support/groups/receipts
 * (routes/groups.js), which the Next.js confirm-partner-payments cron polls.
 *
 * Uses OpenRouter (OPENROUTER_API_KEY — the key this box actually has; the
 * media-processor's OPENAI_WHISPER_API_KEY was never provisioned here, which is
 * why image descriptions never ran). Images go as data-URL image_url parts;
 * PDFs go as file parts (OpenRouter routes them to the model's native file
 * input, falling back to its file-parser).
 *
 * LGPD/A09: the file and any payer/payee names it contains never leave this
 * box — callers persist/return ONLY { amountCents, receiptRef }. Nothing from
 * the receipt body is ever logged.
 *
 * @module lib/receipt-extractor
 */

const fs = require('fs');
const path = require('path');
const { LOG_TAG } = require('./constants');

/** Same directory routes/ingest-evolution.js saves inbound media to. */
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'db', 'media');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Cheap vision-capable model; override with RECEIPT_VISION_MODEL. */
const RECEIPT_MODEL = process.env.RECEIPT_VISION_MODEL || 'openai/gpt-4o-mini';
const MAX_TOKENS = 300;
const TIMEOUT_MS = 60_000;
/** Receipts are small; anything bigger than this is not a comprovante. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const SYSTEM_PROMPT =
  'Você extrai dados financeiros de comprovantes bancários brasileiros. ' +
  'Responda SOMENTE com um objeto JSON válido, sem markdown e sem texto extra.';

const USER_PROMPT =
  'O arquivo anexado é um comprovante de transferência bancária (PIX/TED)? ' +
  'Responda apenas com JSON neste formato: ' +
  '{"is_receipt": true, "amount": 4639.32, "transaction_id": "E60701190202607091422DY55POJ5WIK"} ' +
  '— onde "amount" é o VALOR TOTAL transferido como número com ponto decimal, e ' +
  '"transaction_id" é o ID da transação / ID end-to-end / autenticação (ou null se ilegível). ' +
  'Se o arquivo NÃO for um comprovante de transferência, responda {"is_receipt": false}.';

/**
 * Parse a monetary value (model output) into integer cents. Accepts a JSON
 * number (4639.32) or Brazilian/US formatted strings ("R$ 4.639,32",
 * "4.639,32", "4639.32", "1,234.56"). Returns null when unparseable.
 */
function parseAmountToCents(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? Math.round(value * 100) : null;
  }
  if (typeof value !== 'string') return null;
  let s = value.replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Comma only: thousands groups ("4,639") or a decimal comma ("4639,32").
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(/,/g, '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // Dot-as-thousands with no decimal part ("4.639").
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Pull the first JSON object out of a model reply (tolerates ``` fences). */
function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function imageMime(absPath, mimetype) {
  if (typeof mimetype === 'string' && mimetype.startsWith('image/')) return mimetype.split(';')[0];
  const ext = path.extname(absPath).toLowerCase().replace('.', '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Extract PIX receipt data from a saved media file.
 *
 * @param {string} absPath - Absolute path to the media file (db/media/...)
 * @param {string} mediaType - media_json.media_type ('image' | 'document')
 * @param {string} [mimetype] - media_json.mimetype
 * @returns {Promise<{status: 'ok'|'no_receipt'|'error', amountCents?: number,
 *   receiptRef?: string, model?: string, reason?: string}>}
 *   'ok' = it is a receipt and the amount was read; 'no_receipt' = the file is
 *   readable but not a transfer receipt (terminal); 'error' = transient/parse
 *   failure (callers may retry; reason 'no_api_key' means misconfig — do not
 *   cache it as an attempt).
 */
async function extractReceipt(absPath, mediaType, mimetype = '') {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(`${LOG_TAG} [receipts] OPENROUTER_API_KEY not configured`);
    return { status: 'error', reason: 'no_api_key' };
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { status: 'error', reason: 'file_missing' };
  }
  if (stat.size > MAX_FILE_BYTES) return { status: 'no_receipt', reason: 'file_too_large' };

  let base64;
  try {
    base64 = fs.readFileSync(absPath).toString('base64');
  } catch (err) {
    console.error(`${LOG_TAG} [receipts] could not read ${path.basename(absPath)}: ${err.message}`);
    return { status: 'error', reason: 'file_unreadable' };
  }

  const isPdf =
    (typeof mimetype === 'string' && mimetype.includes('pdf')) ||
    path.extname(absPath).toLowerCase() === '.pdf';

  let filePart;
  if (mediaType === 'image' || (!isPdf && typeof mimetype === 'string' && mimetype.startsWith('image/'))) {
    filePart = {
      type: 'image_url',
      image_url: { url: `data:${imageMime(absPath, mimetype)};base64,${base64}` },
    };
  } else if (isPdf) {
    filePart = {
      type: 'file',
      file: {
        filename: path.basename(absPath),
        file_data: `data:application/pdf;base64,${base64}`,
      },
    };
  } else {
    // A document we can't feed to the model (docx, xlsx, ...) — terminal.
    return { status: 'no_receipt', reason: 'unsupported_media' };
  }

  console.log(`${LOG_TAG} [receipts] extracting ${path.basename(absPath)} via ${RECEIPT_MODEL}`);
  let data;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: RECEIPT_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'text', text: USER_PROMPT }, filePart] },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`${LOG_TAG} [receipts] extraction failed (${res.status}): ${detail.slice(0, 200)}`);
      return { status: 'error', reason: `http_${res.status}` };
    }
    data = await res.json().catch(() => null);
  } catch (err) {
    console.error(`${LOG_TAG} [receipts] extraction failed: ${err.message}`);
    return { status: 'error', reason: 'transport' };
  }

  const parsed = parseModelJson(data?.choices?.[0]?.message?.content);
  if (!parsed) return { status: 'error', reason: 'unparseable_reply', model: RECEIPT_MODEL };
  if (parsed.is_receipt !== true) return { status: 'no_receipt', model: RECEIPT_MODEL };

  const amountCents = parseAmountToCents(parsed.amount);
  if (amountCents === null || amountCents <= 0) {
    // A receipt whose amount we couldn't read is useless for matching; retriable.
    return { status: 'error', reason: 'amount_unreadable', model: RECEIPT_MODEL };
  }

  let receiptRef;
  if (typeof parsed.transaction_id === 'string') {
    const trimmed = parsed.transaction_id.trim();
    if (trimmed && trimmed.toLowerCase() !== 'null') receiptRef = trimmed.slice(0, 200);
  }

  return { status: 'ok', amountCents, receiptRef, model: RECEIPT_MODEL };
}

module.exports = { extractReceipt, parseAmountToCents, parseModelJson, MEDIA_DIR };
