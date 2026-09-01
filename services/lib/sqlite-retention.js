'use strict';

const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function deleteExpiredInChunks(db, options) {
  const {
    table,
    cutoff,
    batchSize = 5000,
    maxBatches = 4,
  } = options;

  if (!SAFE_TABLE.test(table)) throw new Error(`unsafe SQLite table: ${table}`);
  if (!Number.isFinite(cutoff)) throw new TypeError('cutoff must be finite');
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('batchSize must be a positive integer');
  }
  if (!Number.isInteger(maxBatches) || maxBatches <= 0) {
    throw new TypeError('maxBatches must be a positive integer');
  }

  const removeBatch = db.prepare(`
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id FROM ${table}
      WHERE timestamp < ?
      ORDER BY timestamp ASC
      LIMIT ?
    )
  `);

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    // Each run is its own short transaction, releasing the writer lock between
    // chunks so the collector can keep flushing new OCPP rows.
    const result = removeBatch.run(cutoff, batchSize);
    deleted += result.changes;
    if (result.changes < batchSize) break;
  }
  return deleted;
}

module.exports = { deleteExpiredInChunks };
