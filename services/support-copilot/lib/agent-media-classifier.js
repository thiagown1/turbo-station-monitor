const fs = require('fs');
const path = require('path');
const { parseAmountToCents, parseModelJson } = require('./receipt-extractor');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;

const SYSTEM = 'Você é o roteador de documentos e incidentes da Turbo Station. Responda somente JSON válido. Não invente valores, destinatários, IDs ou diagnóstico.';
const PROMPT = `Classifique a mensagem/mídia em exatamente um tipo:
partner_payment_receipt (comprovante de repasse PIX/TED), expense_receipt (comprovante de dinheiro que saiu da Turbo Station), energy_invoice (fatura/conta de energia), station_support (pedido ou evidência de análise de carregador), support_attention (bug/erro que merece atenção), other.
Extraia somente o que estiver legível. suggested_reply deve ser curta, em português, e nunca afirmar que um problema foi corrigido.
Para expense_receipt, informe currency (ISO 4217), original_amount e settled_brl_amount. Se for moeda estrangeira e o valor final cobrado em reais não estiver legível, settled_brl_amount deve ser null. Não converta câmbio. Extraia transaction_date (AAAA-MM-DD), competency {year,month} e recurring_hint somente quando houver evidência no documento/texto.
Para energy_invoice, preencha energy_bill somente com campos literalmente legíveis na conta. distributor deve ser equatorial_go, neoenergia_df ou unknown. Valores ausentes ficam null; não derive tarifa dividindo total por kWh e não trate crédito SCEE como preço do gerador.
JSON: {"kind":"other","summary":"...","confidence":0.0,"needs_attention":false,"amount":null,"settled_brl_amount":null,"currency":null,"original_amount":null,"transaction_date":null,"competency":null,"recurring_hint":false,"transaction_id":null,"payee":null,"suggested_category":null,"suggested_reply":null,"energy_bill":{"distributor":"unknown","uc":null,"ref_period":null,"due_date":null,"kwh_nao_compensado":null,"tarifa_nao_compensada":null,"kwh_compensado":null,"tarifa_scee":null,"tarifa_sem_tributos_nao_compensada":null,"tarifa_sem_tributos":null,"total_brl":null}}`;

function mediaPart(absPath, mediaType, mimetype) {
  if (!absPath) return null;
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_BYTES) throw new Error('file_too_large');
  const base64 = fs.readFileSync(absPath).toString('base64');
  const pdf = String(mimetype || '').includes('pdf') || path.extname(absPath).toLowerCase() === '.pdf';
  if (pdf) return { type: 'file', file: { filename: path.basename(absPath), file_data: `data:application/pdf;base64,${base64}` } };
  if (mediaType === 'image' || String(mimetype || '').startsWith('image/')) {
    const mime = String(mimetype || '').split(';')[0] || 'image/jpeg';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
  }
  return null;
}

function cleanString(value, max) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function estimateCost(usage) {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost;
  const inputRate = Number(process.env.AGENT_INPUT_USD_PER_MILLION || 0);
  const outputRate = Number(process.env.AGENT_OUTPUT_USD_PER_MILLION || 0);
  return ((usage?.prompt_tokens || 0) * inputRate + (usage?.completion_tokens || 0) * outputRate) / 1_000_000;
}

function extractFinancialFields(parsed) {
  const currency = cleanString(parsed?.currency, 3)?.toUpperCase();
  const originalAmountMinor = parseAmountToCents(parsed?.original_amount) || undefined;
  const amountCents = currency && currency !== 'BRL'
    ? (parseAmountToCents(parsed?.settled_brl_amount) || undefined)
    : (parseAmountToCents(parsed?.settled_brl_amount) || parseAmountToCents(parsed?.amount) || undefined);
  return { currency, originalAmountMinor, amountCents };
}

function boundedNonNegative(value, max) {
  if (value == null || value === '') return null;
  let normalized = value;
  if (typeof value === 'string') {
    const compact = value.replace(/\s/g, '');
    if (compact.includes(',')) {
      normalized = compact.replace(/\./g, '').replace(',', '.');
    } else if (max > 10 && /^\d{1,3}(?:\.\d{3})+$/.test(compact)) {
      normalized = compact.replace(/\./g, '');
    } else {
      normalized = compact;
    }
  }
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

function extractEnergyBill(parsed) {
  if (parsed?.kind !== 'energy_invoice') return undefined;
  const source = parsed.energy_bill && typeof parsed.energy_bill === 'object' ? parsed.energy_bill : {};
  const distributor = ['equatorial_go', 'neoenergia_df'].includes(source.distributor)
    ? source.distributor
    : 'unknown';
  const ref = source.ref_period;
  const refPeriod = ref && Number.isInteger(Number(ref.year)) && Number.isInteger(Number(ref.month))
    && Number(ref.year) >= 2020 && Number(ref.year) <= 2100
    && Number(ref.month) >= 1 && Number(ref.month) <= 12
    ? { year: Number(ref.year), month: Number(ref.month) }
    : null;
  return {
    distributor,
    uc: cleanString(source.uc, 64) || null,
    refPeriod,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.due_date || '')) ? source.due_date : null,
    kwhNaoCompensado: boundedNonNegative(source.kwh_nao_compensado, 1_000_000),
    tarifaNaoCompensada: boundedNonNegative(source.tarifa_nao_compensada, 10),
    kwhCompensado: boundedNonNegative(source.kwh_compensado, 1_000_000),
    tarifaScee: boundedNonNegative(source.tarifa_scee, 10),
    tarifaSemTributosNaoCompensada: boundedNonNegative(source.tarifa_sem_tributos_nao_compensada, 10),
    tarifaSemTributos: boundedNonNegative(source.tarifa_sem_tributos, 10),
    totalCents: (() => {
      const cents = parseAmountToCents(source.total_brl);
      return Number.isInteger(cents) && cents >= 0 && cents <= 1_000_000_000 ? cents : null;
    })(),
  };
}

async function classifyMessage({ absPath, mediaType, mimetype, body, context, model }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { status: 'error', reason: 'no_api_key', environmental: true };
  const content = [{ type: 'text', text: `${PROMPT}\n\nContexto recente:\n${String(context || '').slice(-4000)}\n\nMensagem atual:\n${String(body || '').slice(0, 1500)}` }];
  try {
    const part = mediaPart(absPath, mediaType, mimetype);
    if (part) content.push(part);
  } catch (error) {
    return { status: 'error', reason: error.message };
  }
  const selectedModel = model || process.env.AGENT_VISION_MODEL || process.env.RECEIPT_VISION_MODEL || 'openai/gpt-4o-mini';
  let response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: selectedModel, max_tokens: 500, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (_) { return { status: 'error', reason: 'transport', environmental: true }; }
  if (!response.ok) return { status: 'error', reason: `http_${response.status}`, environmental: [401, 403, 429].includes(response.status) };
  const data = await response.json().catch(() => null);
  const parsed = parseModelJson(data?.choices?.[0]?.message?.content);
  const kinds = new Set(['partner_payment_receipt', 'expense_receipt', 'energy_invoice', 'station_support', 'support_attention', 'other']);
  if (!parsed || !kinds.has(parsed.kind)) return { status: 'error', reason: 'unparseable_reply' };
  const usage = data?.usage || {};
  const { currency, originalAmountMinor, amountCents } = extractFinancialFields(parsed);
  const energyBill = extractEnergyBill(parsed);
  const competency = parsed.competency && Number.isInteger(Number(parsed.competency.year)) && Number.isInteger(Number(parsed.competency.month))
    && Number(parsed.competency.month) >= 1 && Number(parsed.competency.month) <= 12
    ? { year: Number(parsed.competency.year), month: Number(parsed.competency.month) }
    : undefined;
  return {
    status: 'ok',
    kind: parsed.kind,
    summary: cleanString(parsed.summary, 1000) || 'Mídia recebida pelo WhatsApp',
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    needsAttention: parsed.needs_attention === true,
    amountCents,
    currency,
    originalAmountMinor,
    transactionDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.transaction_date || '')) ? parsed.transaction_date : undefined,
    suggestedPeriod: competency,
    recurringHint: parsed.recurring_hint === true,
    receiptRef: cleanString(parsed.transaction_id, 200),
    payee: cleanString(parsed.payee, 300),
    suggestedCategory: cleanString(parsed.suggested_category, 100),
    suggestedReply: cleanString(parsed.suggested_reply, 3000),
    energyBill,
    cost: {
      model: selectedModel,
      inputTokens: Number(usage.prompt_tokens) || 0,
      outputTokens: Number(usage.completion_tokens) || 0,
      estimatedCostUsd: estimateCost(usage),
    },
  };
}

module.exports = { classifyMessage, estimateCost, extractFinancialFields, extractEnergyBill };
