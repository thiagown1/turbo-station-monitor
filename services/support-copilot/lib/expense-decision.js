'use strict';

function parseExpenseDecision(text) {
  const normalized = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (/^(3|ignorar|nao registrar|descartar)\b/.test(normalized)) return 'reject';
  if (/^(2|registrar recorrente|recorrente|mensal)\b/.test(normalized) || /\brecorrente\b/.test(normalized)) return 'register_monthly';
  if (/^(1|registrar|confirmar|uma vez|sim)\b/.test(normalized)) return 'register_once';
  return null;
}

function parseExpenseBrlAmount(text) {
  const match = String(text || '').match(/\bvalor\s+(?:r\$\s*)?([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return undefined;
  const normalized = match[1].replace(/\./g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : undefined;
}

module.exports = { parseExpenseDecision, parseExpenseBrlAmount };
