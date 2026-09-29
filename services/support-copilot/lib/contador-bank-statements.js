'use strict';

/** Scoped Next API client for the Contador's OFX document intake. */
function createBankStatementClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  async function importOfx(payload) {
    if (!baseUrl || !apiKey) throw new Error('Bank statement API is not configured');
    const response = await fetchImpl(`${baseUrl}/api/accounting/bank-statements/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
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
