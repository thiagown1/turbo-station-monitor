'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { deleteExpiredInChunks } = require('../services/lib/sqlite-retention');

test('retention deletes bounded batches and keeps fresh rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocpp-retention-'));
  const db = new Database(path.join(dir, 'test.db'));
  try {
    db.exec('CREATE TABLE ocpp_raw (id INTEGER PRIMARY KEY, timestamp INTEGER)');
    db.exec('CREATE INDEX idx_raw_ts ON ocpp_raw(timestamp)');
    const insert = db.prepare('INSERT INTO ocpp_raw(timestamp) VALUES (?)');
    for (let i = 0; i < 12; i += 1) insert.run(i);
    for (let i = 100; i < 103; i += 1) insert.run(i);

    assert.equal(deleteExpiredInChunks(db, {
      table: 'ocpp_raw', cutoff: 50, batchSize: 4, maxBatches: 2,
    }), 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ocpp_raw WHERE timestamp < 50').get().n, 4);
    assert.equal(deleteExpiredInChunks(db, {
      table: 'ocpp_raw', cutoff: 50, batchSize: 4, maxBatches: 2,
    }), 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ocpp_raw WHERE timestamp >= 50').get().n, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retention rejects an interpolated table name', () => {
  assert.throws(
    () => deleteExpiredInChunks({}, { table: 'ocpp_raw; DROP TABLE x', cutoff: 1 }),
    /unsafe SQLite table/,
  );
});
