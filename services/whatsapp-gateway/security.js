'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SAFE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);
const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'Error',
  'RangeError',
  'TimeoutError',
  'TypeError',
]);

/**
 * Baileys logs protocol nodes, JIDs, and session-sync metadata as structured
 * fields. Redacting a fixed set of keys is therefore incomplete; disable the
 * library logger and keep our own bounded lifecycle messages instead.
 */
function createSilentBaileysLogger(pinoFactory) {
  if (typeof pinoFactory !== 'function') {
    throw new TypeError('pinoFactory must be a function');
  }
  return pinoFactory({ level: 'silent' });
}

function assertRealDirectory(directory, fsImpl = fs) {
  const stat = fsImpl.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link in WhatsApp auth state: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`WhatsApp auth path is not a directory: ${directory}`);
  }
}

function ensurePrivateAuthDirectory(directory, fsImpl = fs) {
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory, fsImpl);
  fsImpl.chmodSync(directory, 0o700);
}

function hardenAuthTree(directory, fsImpl = fs) {
  ensurePrivateAuthDirectory(directory, fsImpl);

  for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stat = fsImpl.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in WhatsApp auth state: ${entryPath}`);
    }
    if (stat.isDirectory()) {
      hardenAuthTree(entryPath, fsImpl);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported entry in WhatsApp auth state: ${entryPath}`);
    }
    fsImpl.chmodSync(entryPath, 0o600);
  }
}

function secureSaveCreds(saveCreds, directory, fsImpl = fs) {
  if (typeof saveCreds !== 'function') {
    throw new TypeError('saveCreds must be a function');
  }

  return async function savePrivateCredentials(...args) {
    const result = await saveCreds.apply(this, args);
    hardenAuthTree(directory, fsImpl);
    return result;
  };
}

function safeErrorCode(error) {
  if (SAFE_ERROR_CODES.has(error?.code)) return error.code;
  if (SAFE_ERROR_NAMES.has(error?.name)) return error.name;
  return 'unknown';
}

module.exports = {
  createSilentBaileysLogger,
  ensurePrivateAuthDirectory,
  hardenAuthTree,
  secureSaveCreds,
  safeErrorCode,
};
