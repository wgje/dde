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
  const rawValues = KEY_NAMES.map(name => (typeof env[name] === 'string' ? env[name] : ''));
  const maxPresentSlot = rawValues.reduce(
    (maximum, value, index) => (value ? index + 1 : maximum),
    0,
  );
  if (maxPresentSlot === 0) throw new Error('missing-context7-key-slot:1');
  for (let slot = 1; slot <= maxPresentSlot; slot += 1) {
    if (!rawValues[slot - 1]) throw new Error(`missing-context7-key-slot:${slot}`);
  }
  const pool = rawValues.slice(0, maxPresentSlot).map((value, index) => {
    const slot = index + 1;
    const name = KEY_NAMES[index];
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
