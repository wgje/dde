'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const PROTOCOL = 'codegraph-native-handle-authority-v1';
const VERIFIED = 'VERIFIED';
const SIGNATURE_ALGORITHMS = Object.freeze(['Ed25519', 'RSASSA-PSS-SHA256']);
const RECEIPT_KEYS = Object.freeze([
  'protocol',
  'artifactKind',
  'artifactRevision',
  'packetDigest',
  'sourceRows',
  'trustAnchorFingerprint',
  'issuer',
  'nonce',
  'idempotencyKey',
  'verifiedAt',
  'receiptDigest',
  'signature',
  'shareWriteForbidden',
]);
const SOURCE_ROW_KEYS = Object.freeze(['row', 'path', 'sha256', 'bytes']);

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareOrdinal).map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function digestPreimage(value) {
  return JSON.stringify(sortValue(value));
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

function validHex(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
}

function validBase64(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
  } catch {
    return false;
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonicalReceiptDigest(receipt) {
  const payload = { ...receipt };
  delete payload.receiptDigest;
  delete payload.signature;
  return sha256Text(digestPreimage(payload));
}

function assertStrictReceiptShape(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('SCHEMA_INVALID');
  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_KEYS.includes(key)) fail('SCHEMA_INVALID');
  }
  const required = RECEIPT_KEYS.filter((key) => !['shareWriteForbidden', 'nonce', 'idempotencyKey'].includes(key));
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(receipt, key)) fail('SCHEMA_INVALID');
  }
  if (typeof receipt.protocol !== 'string' || receipt.protocol !== PROTOCOL) fail('SCHEMA_INVALID');
  if (typeof receipt.artifactKind !== 'string' || receipt.artifactKind !== 'CODEGRAPH_EXACT15_NATIVE_HANDLE_AUTHORITY_REQUEST') fail('SCHEMA_INVALID');
  if (receipt.artifactRevision !== 4) fail('SCHEMA_INVALID');
  if (typeof receipt.packetDigest !== 'string' || !validHex(receipt.packetDigest, 64)) fail('SCHEMA_INVALID');
  if (!Array.isArray(receipt.sourceRows) || receipt.sourceRows.length === 0) fail('SCHEMA_INVALID');
  for (const row of receipt.sourceRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('SCHEMA_INVALID');
    for (const key of Object.keys(row)) {
      if (!SOURCE_ROW_KEYS.includes(key)) fail('SCHEMA_INVALID');
    }
    for (const key of SOURCE_ROW_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) fail('SCHEMA_INVALID');
    }
    if (typeof row.row !== 'string' || !row.row
      || typeof row.path !== 'string' || !row.path || row.path.includes('\\')
      || path.posix.isAbsolute(row.path)
      || row.path.split('/').some((part) => !part || part === '.' || part === '..')
      || typeof row.sha256 !== 'string' || !validHex(row.sha256, 64)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      fail('SCHEMA_INVALID');
    }
  }
  if (typeof receipt.trustAnchorFingerprint !== 'string' || !validHex(receipt.trustAnchorFingerprint, 64)) fail('SCHEMA_INVALID');
  if (!receipt.issuer || typeof receipt.issuer !== 'object' || Array.isArray(receipt.issuer)
    || Object.keys(receipt.issuer).some((key) => key !== 'issuerId')
    || typeof receipt.issuer.issuerId !== 'string' || !receipt.issuer.issuerId) fail('SCHEMA_INVALID');
  if (Object.prototype.hasOwnProperty.call(receipt, 'nonce') && (typeof receipt.nonce !== 'string' || receipt.nonce.length < 16 || receipt.nonce.length > 128)) fail('SCHEMA_INVALID');
  if (Object.prototype.hasOwnProperty.call(receipt, 'idempotencyKey') && (typeof receipt.idempotencyKey !== 'string' || !receipt.idempotencyKey || receipt.idempotencyKey.length > 256)) fail('SCHEMA_INVALID');
  if (typeof receipt.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.verifiedAt)) fail('SCHEMA_INVALID');
  if (typeof receipt.receiptDigest !== 'string' || !validHex(receipt.receiptDigest, 64)) fail('SCHEMA_INVALID');
  if (!receipt.signature || typeof receipt.signature !== 'object' || Array.isArray(receipt.signature)
    || Object.keys(receipt.signature).some((key) => key !== 'algorithm' && key !== 'value')
    || !SIGNATURE_ALGORITHMS.includes(receipt.signature.algorithm)
    || typeof receipt.signature.value !== 'string' || !validBase64(receipt.signature.value)) fail('SCHEMA_INVALID');
    if (Object.prototype.hasOwnProperty.call(receipt, 'shareWriteForbidden') && receipt.shareWriteForbidden !== true) fail('SHARE_WRITE');
}

function assertSourceRows(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) fail('SOURCE_ROWS_MISSING');
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.row !== 'string' || !row.row
      || typeof row.path !== 'string' || !row.path || !validHex(row.sha256, 64)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.path.includes('\\')
      || path.posix.isAbsolute(row.path)
      || row.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('SOURCE_ROW_INVALID');
    }
    if (seen.has(row.row)) fail('SOURCE_ROW_DUPLICATE');
    seen.add(row.row);
  }
}

function sameRows(left, right) {
  if (left.length !== right.length) return false;
  const normalized = (rows) => rows.map((row) => [row.row, row.path, row.sha256, row.bytes]);
  const a = JSON.stringify(normalized(left));
  const b = JSON.stringify(normalized(right));
  return a === b;
}

function checkReplayFence(ledger, candidate) {
  if (!Array.isArray(ledger)) fail('LEDGER_INVALID');
  if (!candidate || typeof candidate !== 'object' || typeof candidate.nonce !== 'string' || typeof candidate.idempotencyKey !== 'string') {
    fail('FENCE_FIELDS_MISSING');
  }
  if (ledger.some((entry) => entry && entry.nonce === candidate.nonce && entry.idempotencyKey === candidate.idempotencyKey)) {
    fail('NONCE_IDEMPOTENCY_REPLAY');
  }
}

function verifySignature(receipt, publicKey) {
  const algorithm = receipt.signature.algorithm;
  const signature = Buffer.from(receipt.signature.value, 'base64');
  const payload = { ...receipt };
  delete payload.receiptDigest;
  delete payload.signature;
  const preimage = sha256Text(digestPreimage(payload));
  if (algorithm === 'Ed25519') {
    return crypto.verify(null, Buffer.from(preimage, 'utf8'), publicKey, signature);
  }
  if (algorithm === 'RSASSA-PSS-SHA256') {
    return crypto.verify(
      'sha256',
      Buffer.from(preimage, 'utf8'),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature,
    );
  }
  fail('SIGNATURE_ALGORITHM_UNSUPPORTED');
}

function fingerprintOf(publicKey) {
  const der = publicKey.type === 'private'
    ? crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })
    : publicKey.export({ type: 'spki', format: 'der' });
  return sha256Bytes(der);
}

async function verifySignedReceipt({ receipt, pendingPacketDigest, expectedSourceRows, trustAnchorFingerprint, trustAnchorPublicKey, ledger = [] }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('INPUT_INVALID');
  assertStrictReceiptShape(receipt);
  if (Object.prototype.hasOwnProperty.call(receipt, 'approved')) fail('INJECTED_AUTHORITY_FIELD');
  if (receipt.shareWriteForbidden === false) fail('SHARE_WRITE');
  if (typeof receipt.protocol !== 'string' || receipt.protocol !== PROTOCOL) fail('PROTOCOL_DRIFT');
  if (typeof receipt.artifactKind !== 'string' || receipt.artifactKind !== 'CODEGRAPH_EXACT15_NATIVE_HANDLE_AUTHORITY_REQUEST') fail('ARTIFACT_KIND_DRIFT');
  if (receipt.artifactRevision !== 4) fail('ARTIFACT_REVISION_DRIFT');
  if (typeof pendingPacketDigest !== 'string' || !validHex(pendingPacketDigest, 64)) fail('PACKET_DIGEST_INVALID');
  if (receipt.packetDigest !== pendingPacketDigest) fail('PACKET_DIGEST_DRIFT');
  if (!trustAnchorFingerprint || typeof trustAnchorFingerprint !== 'string' || !validHex(trustAnchorFingerprint, 64)) fail('TRUST_ANCHOR_UNAVAILABLE');
  if (!trustAnchorPublicKey) fail('TRUST_ANCHOR_UNAVAILABLE');
  assertSourceRows(expectedSourceRows, 'expectedSourceRows');
  assertSourceRows(receipt.sourceRows, 'receipt.sourceRows');
  if (!sameRows(expectedSourceRows, receipt.sourceRows)) fail('SOURCE_ROW_DRIFT');
  const issuer = receipt.issuer;
  if (!issuer || typeof issuer !== 'object' || typeof issuer.issuerId !== 'string' || !issuer.issuerId) fail('ISSUER_INVALID');
  if (receipt.trustAnchorFingerprint !== trustAnchorFingerprint) fail('TRUST_ANCHOR_FINGERPRINT_MISMATCH');
  const actualFingerprint = fingerprintOf(trustAnchorPublicKey);
  if (actualFingerprint !== trustAnchorFingerprint) fail('TRUST_ANCHOR_FINGERPRINT_MISMATCH');
  checkReplayFence(ledger, receipt);
  const signature = receipt.signature;
  if (!signature || typeof signature !== 'object' || !SIGNATURE_ALGORITHMS.includes(signature.algorithm) || !validBase64(signature.value)) fail('SIGNATURE_INVALID');
  const expectedDigest = canonicalReceiptDigest(receipt);
  if (typeof receipt.receiptDigest !== 'string' || receipt.receiptDigest !== expectedDigest) fail('DIGEST_DRIFT');
  const valid = verifySignature(receipt, trustAnchorPublicKey);
  if (!valid) fail('SIGNATURE_INVALID');
  return Object.freeze({
    status: VERIFIED,
    protocol: PROTOCOL,
    receiptDigest: receipt.receiptDigest,
    signature: Object.freeze({ algorithm: signature.algorithm }),
    trustAnchorFingerprint,
    nonce: receipt.nonce,
    idempotencyKey: receipt.idempotencyKey,
    verifiedAt: receipt.verifiedAt,
    release: 'HOLD_RELEASE',
  });
}

module.exports = Object.freeze({
  PROTOCOL,
  VERIFIED,
  canonicalReceiptDigest,
  checkReplayFence,
  digestPreimage,
  fingerprintOf,
  sha256Text,
  verifySignedReceipt,
});
