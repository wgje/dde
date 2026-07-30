'use strict';

const crypto = require('node:crypto');

const KEY_NAMES = Object.freeze([
  'CONTEXT7_API_KEY_1',
  'CONTEXT7_API_KEY_2',
  'CONTEXT7_API_KEY_3',
  'CONTEXT7_API_KEY_4',
]);

function fingerprint(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function loadCredentialPool(env = process.env) {
  const pool = KEY_NAMES.map((name, index) => {
    const slot = index + 1;
    const value = typeof env[name] === 'string' ? env[name] : '';
    if (!value) throw new Error(`missing-context7-key-slot:${slot}`);
    if (!value.trim() || value !== value.trim()) {
      throw new Error(`invalid-context7-key-whitespace-slot:${slot}`);
    }
    const fingerprintSha256 = fingerprint(value);
    return {
      slot,
      name,
      value,
      fingerprintSha256,
      publicIdentity: {
        slot,
        fingerprintSha256_12: fingerprintSha256.slice(0, 12),
        length: value.length,
      },
    };
  });
  const firstSlotByFingerprint = new Map();
  for (const entry of pool) {
    const firstSlot = firstSlotByFingerprint.get(entry.fingerprintSha256);
    if (firstSlot !== undefined) {
      throw new Error(`duplicate-context7-key-slots:${firstSlot},${entry.slot}`);
    }
    firstSlotByFingerprint.set(entry.fingerprintSha256, entry.slot);
  }
  return pool;
}

module.exports = { KEY_NAMES, fingerprint, loadCredentialPool };
