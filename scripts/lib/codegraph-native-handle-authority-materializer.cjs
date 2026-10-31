'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 'codegraph-native-handle-authority-v1';
const FRAME_KINDS = Object.freeze([
  'BUILD',
  'NATIVE_ATTESTATION',
  'FRAME_JOIN',
  'LEDGER',
  'RUNTIME_PERFORMANCE',
  'MATERIALIZED_REVIEW_APPROVAL',
]);
const PENDING = 'PENDING_EXTERNAL_SIGNATURE';

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

function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
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

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertSourceRows(input) {
  const rows = input.sourceRows;
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

function assertNoManualDigest(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'receiptDigest') || Object.prototype.hasOwnProperty.call(input, 'packetDigest')) {
    fail('MANUAL_DIGEST');
  }
}

function assertRevision3Predecessor(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'predecessorRevision') && input.predecessorRevision !== 3) {
    fail('REVISION3_DRIFT');
  }
}

function assertOpenStrategy(input) {
  const strategy = input.openStrategy;
  if (strategy && typeof strategy === 'object') {
    const shareMode = String(strategy.shareMode ?? '');
    if (shareMode.includes('WRITE')) fail('SHARE_WRITE');
    if (strategy.openReparsePoint === false) fail('OPEN_STRATEGY_REPARSE');
  }
}

function readSourceRows(input) {
  assertSourceRows(input);
  const projectRoot = typeof input.projectRoot === 'string' && input.projectRoot ? input.projectRoot : null;
  return input.sourceRows.map((row) => {
    if (!projectRoot) return { ...row };
    const filePath = path.join(projectRoot, ...row.path.split('/'));
    let bytes;
    try { bytes = fs.readFileSync(filePath); } catch { fail('SOURCE_ROW_READ_FAILED'); }
    const actualSha = sha256Bytes(bytes);
    if (actualSha !== row.sha256 || bytes.length !== row.bytes) fail(`ROW_SHA_DRIFT:${row.row}`);
    return { ...row };
  });
}

function assertPostCloseEvidence(input) {
  const evidence = input.postCloseEvidence;
  if (evidence && typeof evidence === 'object') {
    if (evidence.nativeHandleAuthority === 'MISSING') fail('POST_CLOSE_OVERCLAIM');
    if (evidence.evidenceLevel === 'PATH_HANDLE_STABLE' && evidence.nativeHandleAuthority !== 'MATERIALIZED') {
      fail('POST_CLOSE_OVERCLAIM');
    }
  }
}

function assertNoInjectedAuthorityFields(input) {
  const forbidden = ['receipt', 'signature', 'issuer', 'trustAnchor', 'frames', 'packetDigest', 'receiptDigest'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(input, key)) fail('INJECTED_AUTHORITY_FIELD');
  }
}

function buildFrames(input, sourceRows) {
  const observedAt = typeof input.observedAt === 'string' ? input.observedAt : new Date().toISOString();
  const frames = [];
  for (const kind of FRAME_KINDS) {
    const frame = { kind, phase: kind.toLowerCase(), protocol: PROTOCOL, status: PENDING, sequence: frames.length + 1, observedAt };
    if (kind === 'BUILD') frame.details = input.buildReceipt ? 'build receipt captured' : 'build receipt not yet supplied';
    else if (kind === 'NATIVE_ATTESTATION') frame.details = 'shareWriteForbidden; handle held through read; post-close containment required';
    else if (kind === 'FRAME_JOIN') frame.details = 'reciprocal frame digest binding';
    else if (kind === 'LEDGER') frame.details = 'one-use nonce/idempotency replay fence pending external issuer';
    else if (kind === 'RUNTIME_PERFORMANCE') frame.details = 'runtime performance not measured; no performance claim';
    else if (kind === 'MATERIALIZED_REVIEW_APPROVAL') {
      frame.approved = false;
      frame.details = 'approval requires externally signed receipt';
    }
    frames.push(frame);
  }
  for (const row of sourceRows) {
    frames.push({
      kind: 'SOURCE_ROW',
      phase: 'source-policy',
      protocol: PROTOCOL,
      status: PENDING,
      sequence: frames.length + 1,
      observedAt,
      row: row.row,
      path: row.path,
      sha256: row.sha256,
      bytes: row.bytes,
    });
  }
  return frames;
}

function assertReceiptEnvelopeShape(receipt) {
  if (!receipt || typeof receipt !== 'object') fail('FAKE_ISSUER');
  const issuer = receipt.issuer;
  if (!issuer || typeof issuer !== 'object' || typeof issuer.issuerId !== 'string' || !issuer.issuerId
    || !validHex(issuer.trustAnchorFingerprint, 64)) fail('FAKE_ISSUER');
  const signature = receipt.signature;
  if (!signature || typeof signature !== 'object'
    || !['Ed25519', 'RSASSA-PSS-SHA256'].includes(signature.algorithm)
    || typeof signature.value !== 'string' || !signature.value) fail('FAKE_SIGNATURE');
  fail('RECEIPT_UNVERIFIED');
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

function recomputeReceiptDigest(receipt) {
  const payload = { ...receipt };
  delete payload.receiptDigest;
  delete payload.signature;
  return sha256Text(digestPreimage(payload));
}

async function materializeNativeHandleAuthorityRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INPUT_INVALID');
  if (input.revision !== 4) fail('REVISION_DRIFT');
  assertNoManualDigest(input);
  assertRevision3Predecessor(input);
  assertOpenStrategy(input);
  assertPostCloseEvidence(input);
  assertNoInjectedAuthorityFields(input);
  const sourceRows = readSourceRows(input);
  const frames = buildFrames(input, sourceRows);
  const request = {
    artifactKind: 'CODEGRAPH_EXACT15_NATIVE_HANDLE_AUTHORITY_REQUEST',
    artifactRevision: 4,
    status: PENDING,
    normativeState: PENDING,
    canonicalEncoding: { bom: false, characterEncoding: 'UTF-8', digestPreimage: 'canonical UTF-8 JSON without final LF', finalLineEnding: 'LF', indent: 2, keyOrder: 'recursive UTF-16 code-unit ascending', safeIntegersOnly: true },
    protocol: PROTOCOL,
    sourceRows,
    frames,
    trustAnchor: { required: true, selfIssued: false, status: PENDING, type: 'EXTERNAL', fingerprint: null },
    receipt: null,
    release: 'HOLD_RELEASE',
  };
  const packetDigest = sha256Text(digestPreimage(request));
  return Object.freeze({ ...request, packetDigest });
}

function atomicWriteJson(filePath, value) {
  const absolute = path.resolve(filePath);
  const directory = path.dirname(absolute);
  const basename = path.basename(absolute);
  const temporary = path.join(directory, `.${basename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporary, canonicalJson(value), 'utf8');
  try {
    fs.renameSync(temporary, absolute);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

module.exports = Object.freeze({
  FRAME_KINDS,
  PENDING,
  PROTOCOL,
  atomicWriteJson,
  canonicalJson,
  checkReplayFence,
  digestPreimage,
  materializeNativeHandleAuthorityRequest,
  recomputeReceiptDigest,
  sha256Text,
  assertReceiptEnvelopeShape,
});
