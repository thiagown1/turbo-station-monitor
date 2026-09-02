'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createSilentBaileysLogger,
  ensurePrivateAuthDirectory,
  hardenAuthTree,
  secureSaveCreds,
  safeErrorCode,
} = require('../services/whatsapp-gateway/security');

const permissions = (filePath) => fs.statSync(filePath).mode & 0o777;

test('Baileys receives a silent logger so session sync payloads never reach PM2 logs', () => {
  let options;
  const expectedLogger = { child: () => expectedLogger };
  const logger = createSilentBaileysLogger((value) => {
    options = value;
    return expectedLogger;
  });

  assert.deepEqual(options, { level: 'silent' });
  assert.equal(logger, expectedLogger);
});

test('existing and newly created auth state is private', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chmodCalls = [];
  const recordingFs = {
    ...fs,
    chmodSync(filePath, mode) {
      chmodCalls.push([path.normalize(filePath), mode]);
      fs.chmodSync(filePath, mode);
    },
  };

  const instanceDir = path.join(root, 'turbo');
  ensurePrivateAuthDirectory(instanceDir, recordingFs);
  fs.writeFileSync(path.join(instanceDir, 'creds.json'), '{"secret":"do-not-log"}', { mode: 0o666 });
  fs.mkdirSync(path.join(instanceDir, 'keys'), { mode: 0o777 });
  fs.writeFileSync(path.join(instanceDir, 'keys', 'session.json'), '{}', { mode: 0o666 });

  hardenAuthTree(instanceDir, recordingFs);

  assert.ok(chmodCalls.some(([filePath, mode]) => filePath === path.normalize(instanceDir) && mode === 0o700));
  assert.ok(chmodCalls.some(([filePath, mode]) => filePath.endsWith(`${path.sep}keys`) && mode === 0o700));
  assert.ok(chmodCalls.some(([filePath, mode]) => filePath.endsWith('creds.json') && mode === 0o600));
  assert.ok(chmodCalls.some(([filePath, mode]) => filePath.endsWith('session.json') && mode === 0o600));

  if (process.platform !== 'win32') {
    assert.equal(permissions(instanceDir), 0o700);
    assert.equal(permissions(path.join(instanceDir, 'keys')), 0o700);
    assert.equal(permissions(path.join(instanceDir, 'creds.json')), 0o600);
    assert.equal(permissions(path.join(instanceDir, 'keys', 'session.json')), 0o600);
  }

  const laterFile = path.join(instanceDir, 'app-state-sync-key.json');
  const save = secureSaveCreds(async () => {
    fs.writeFileSync(laterFile, 'session-secret', { mode: 0o666 });
  }, instanceDir, recordingFs);
  await save();
  assert.ok(chmodCalls.some(([filePath, mode]) => filePath === path.normalize(laterFile) && mode === 0o600));
  if (process.platform !== 'win32') assert.equal(permissions(laterFile), 0o600);
});

test('unsafe auth symlinks are rejected instead of followed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instanceDir = path.join(root, 'turbo');
  const outside = path.join(root, 'outside.json');
  ensurePrivateAuthDirectory(instanceDir);
  fs.writeFileSync(outside, 'outside');

  try {
    fs.symlinkSync(outside, path.join(instanceDir, 'linked.json'));
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('symlink creation is unavailable for this Windows account');
      return;
    }
    throw error;
  }

  assert.throws(() => hardenAuthTree(instanceDir), /symbolic link/i);
});

test('safeErrorCode preserves only bounded machine labels', () => {
  assert.equal(safeErrorCode({ code: 'ECONNRESET', message: 'token=secret' }), 'ECONNRESET');
  assert.equal(safeErrorCode({ name: 'TimeoutError', message: 'jid@s.whatsapp.net' }), 'TimeoutError');
  assert.equal(safeErrorCode({ code: 'bad value secret=abc' }), 'unknown');
  assert.equal(safeErrorCode(new Error('session secret')), 'Error');
});

test('gateway source never writes QR, JID, phone, webhook body, or raw errors to logs', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'whatsapp-gateway', 'index.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:remoteJid|\$\{jid\}|err\.message|\$\{body\}|Phone:|WEBHOOK_URL|BASE_AUTH_DIR)/);
  assert.doesNotMatch(source, /console\.log\(`[^`]*QR:\\n\$\{text\}`\)/);
  assert.match(source, /process\.umask\(0o077\)/);
  assert.match(source, /secureSaveCreds\(saveCreds, dir\)/);
});
