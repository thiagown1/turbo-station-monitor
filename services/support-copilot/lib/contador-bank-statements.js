'use strict';
const { createHash, createHmac, randomBytes } = require('crypto');

/** Scoped Next API client for the Contador's OFX document intake. */
function createBankStatementClient({ baseUrl, apiKey, approvalSecret, fetchImpl = fetch }) {
  async function importOfx(payload, authority) {
    if (!baseUrl || !apiKey || !approvalSecret || approvalSecret.length < 32 || !authority?.brandId) {
      throw new Error('Bank statement API approval is not configured');
    }
    const body = JSON.stringify(payload);
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = String(Date.now());
    const path = '/api/accounting/bank-statements/import';
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    const message = [nonce, issuedAt, authority.brandId, 'POST', path, hash(apiKey), hash(body)].join('\n');
    const signature = createHmac('sha256', approvalSecret).update(message).digest('hex');
    const response = await fetchImpl(`${baseUrl}/api/accounting/bank-statements/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-bank-approval': `${nonce}.${issuedAt}.${signature}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      // The response can include bank data or validation details: neither belongs in logs.
      const error = new Error(`Bank statement import failed with HTTP ${response.status}`);
      error.statusCode = response.status;
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    const result = await response.json();
    if (!result || typeof result !== 'object') throw new Error('Bank statement import returned no result');
    return result;
  }

  return { importOfx };
}

module.exports = { createBankStatementClient };
