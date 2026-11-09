'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  canonicalJsonV4, fieldV3Digest, normalizeSourcePolicyV2Path,
} = require('./codegraph-source-policy.cjs');

const CONTRACT_PATH = path.resolve(__dirname, '../contracts/codegraph-read-identity-v1.json');
const V2_ROOT_CONTRACT_PATH = path.resolve(__dirname, '../contracts/codegraph-read-identity-v2.json');
const V2_COMPANION_CONTRACT_PATH = path.resolve(
  __dirname,
  '../contracts/codegraph-read-identity-v2-companion.json',
);
const NATIVE_SOURCE_PATH = path.resolve(__dirname, '../native/codegraph-read-identity-win32.cpp');
const CONTRACT_BYTES = fs.readFileSync(CONTRACT_PATH);
const CONTRACT = JSON.parse(CONTRACT_BYTES.toString('utf8'));
const V2_ROOT_BYTES = fs.readFileSync(V2_ROOT_CONTRACT_PATH);
const V2_COMPANION_BYTES = fs.readFileSync(V2_COMPANION_CONTRACT_PATH);
const V2_ROOT = JSON.parse(V2_ROOT_BYTES.toString('utf8'));
const V2_COMPANION = JSON.parse(V2_COMPANION_BYTES.toString('utf8'));
const PROTOCOL_NAME = CONTRACT.protocol;
const V2_PROTOCOL_NAME = V2_ROOT.protocol.version;
const FIXED_ERROR_CODES = Object.freeze([...CONTRACT.errors]);
const FIXED_ERROR_SET = new Set(FIXED_ERROR_CODES);
const ADAPTER_ERRORS = new Set([
  'UNSUPPORTED_PLATFORM', 'INVALID_REQUEST', 'TOOL_UNAVAILABLE', 'TOOL_UNTRUSTED',
  'TOOL_TIMEOUT', 'PROTOCOL_INVALID',
]);
const RECEIPT_KEYS = Object.freeze([
  'architecture', 'binaryFile', 'binaryIdentity', 'binarySha256', 'buildId', 'compilerPath',
  'compilerSha256', 'flags', 'protocol', 'protocolSha256', 'schemaVersion', 'sourceSha256',
]);
const EXPECTED_FLAGS = Object.freeze([
  '/nologo', '/std:c++20', '/utf-8', '/O2', '/MT', '/W4', '/WX', '/EHsc', '/guard:cf',
  '/Qspectre', '/Brepro', '/DUNICODE', '/D_UNICODE', '/link', '/DYNAMICBASE',
  '/NXCOMPAT', '/HIGHENTROPYVA', '/GUARD:CF', '/CETCOMPAT',
]);
const V2_LIMITS = Object.freeze({ ...V2_COMPANION.limits });
const V2_FRAME_MODEL = Object.freeze(V2_COMPANION.frameModel);
const V2_ERROR_REGISTRY = Object.freeze(new Map(
  V2_COMPANION.errorRegistry.entryChunks.join(';').split(';').filter(Boolean).map(entry => {
    const [code, detailKind, phase, retryable] = entry.split('|');
    return [code, Object.freeze({ detailKind, phase, retryable: retryable === 'true' })];
  }),
));

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareOrdinal).map(
      key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixedFailure(error) {
  return Object.freeze({ ok: false, error });
}

function freezeSuccess(value) {
  Object.freeze(value.identity);
  Object.freeze(value.attestation.binaryIdentity);
  Object.freeze(value.attestation);
  return Object.freeze(value);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort(compareOrdinal)) === canonicalJson(expected);
}

function validHex(value, length) {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
}

function validComponent(component) {
  if (!component || component === '.' || component === '..' || /[<>:"/\\|?*]/.test(component)) return false;
  if (/[. ]$/.test(component) || /[\u0000-\u001f]/.test(component)) return false;
  const stem = component.split('.')[0].toUpperCase();
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function normalizedRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length > CONTRACT.limits.pathCharacters) return null;
  if (!/^[A-Za-z]:\\(?:[^\\]+(?:\\|$))*$/.test(projectRoot)) return null;
  const normalized = projectRoot.length > 3 ? projectRoot.replace(/\\+$/, '') : projectRoot;
  const components = normalized.slice(3).split('\\').filter(Boolean);
  if (components.length > CONTRACT.limits.components || components.some(value => !validComponent(value))) return null;
  return `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
}

function normalizedRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath
    || relativePath.length > CONTRACT.limits.pathCharacters || relativePath.includes('\\')) return null;
  const components = relativePath.split('/');
  if (components.length > CONTRACT.limits.components || components.some(value => !validComponent(value))) return null;
  return components.join('/');
}

function normalizeReadRequest(projectRoot, relativePath, options = {}) {
  const root = normalizedRoot(projectRoot);
  const child = normalizedRelativePath(relativePath);
  const maxBytes = options.maxBytes ?? CONTRACT.limits.fileBytes;
  const nonce = options.nonce ?? crypto.randomBytes(16).toString('hex');
  if (!root || !child || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || maxBytes > CONTRACT.limits.fileBytes || !validHex(nonce, 32)) return null;
  return {
    maxBytes,
    nonce,
    operation: CONTRACT.operation,
    protocol: PROTOCOL_NAME,
    relativePath: child,
    root,
  };
}

function decodeNativeResponse(text, expected) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > CONTRACT.limits.responseBytes
    || text.includes('\n') || text.includes('\r')) return fixedFailure('PROTOCOL_INVALID');
  let value;
  try { value = JSON.parse(text); } catch { return fixedFailure('PROTOCOL_INVALID'); }
  if (canonicalJson(value) !== text || value.protocol !== PROTOCOL_NAME || value.nonce !== expected.nonce) {
    return fixedFailure('PROTOCOL_INVALID');
  }
  if (value.ok === false) {
    if (!exactKeys(value, CONTRACT.errorKeys) || !FIXED_ERROR_SET.has(value.error)
      || ADAPTER_ERRORS.has(value.error)) return fixedFailure('PROTOCOL_INVALID');
    return fixedFailure(value.error);
  }
  if (value.ok !== true || !exactKeys(value, CONTRACT.successKeys)
    || !exactKeys(value.attestation, CONTRACT.attestationKeys)
    || !exactKeys(value.attestation.binaryIdentity, CONTRACT.identityKeys)
    || !exactKeys(value.identity, CONTRACT.identityKeys)) return fixedFailure('PROTOCOL_INVALID');
  if (value.attestation.binarySha256 !== expected.binarySha256
    || (expected.binaryIdentity
      && canonicalJson(value.attestation.binaryIdentity) !== canonicalJson(expected.binaryIdentity))
    || value.attestation.buildId !== expected.buildId
    || value.attestation.protocolSha256 !== expected.protocolSha256
    || value.attestation.sourceSha256 !== expected.sourceSha256) return fixedFailure('PROTOCOL_INVALID');
  if (!validHex(value.attestation.binaryIdentity.volumeSerial, 16)
    || !validHex(value.attestation.binaryIdentity.fileId, 32)
    || !validHex(value.attestation.binarySha256, 64)
    || !validHex(value.identity.volumeSerial, 16) || !validHex(value.identity.fileId, 32)
    || !validHex(value.sha256, 64) || !/^(?:0|[1-9]\d*)$/.test(value.lastWriteTime)
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > CONTRACT.limits.fileBytes
    || typeof value.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytesBase64)) {
    return fixedFailure('PROTOCOL_INVALID');
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.toString('base64') !== value.bytesBase64 || bytes.length !== value.size
    || sha256(bytes) !== value.sha256) return fixedFailure('PROTOCOL_INVALID');
  return freezeSuccess({
    ok: true,
    identity: { ...value.identity },
    size: value.size,
    lastWriteTime: value.lastWriteTime,
    sha256: value.sha256,
    bytes,
    attestation: {
      ...value.attestation,
      binaryIdentity: { ...value.attestation.binaryIdentity },
    },
  });
}

function v2Failure(error) {
  return fixedFailure(error);
}

function validV2Hex(value, length) {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
}

function validV2Decimal(value, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try { return BigInt(value) <= BigInt(maximum); } catch { return false; }
}

function validV2Base64Url(value, limit) {
  return typeof value === 'string' && value.length <= limit && /^[A-Za-z0-9_-]*$/.test(value)
    && value.length % 4 !== 1;
}

function exactObjectKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function v2FrameSchema(kind) {
  return V2_FRAME_MODEL.frames[kind] ?? null;
}

function v2CommonFrameValid(frame) {
  return frame && typeof frame === 'object' && !Array.isArray(frame)
    && frame.protocol === V2_PROTOCOL_NAME
    && (frame.operation === 'read' || frame.operation === 'manifest')
    && validV2Hex(frame.receiptSha256, 64)
    && validV2Hex(frame.rootIdentity, 64)
    && validV2Hex(frame.sessionId, 32)
    && validV2Hex(frame.snapshotId, 32);
}

function v2IdentityValid(value) {
  const schema = V2_COMPANION.schemas.identity;
  return exactObjectKeys(value, schema.requiredFields)
    && validV2Hex(value.fileId, 32) && validV2Hex(value.volumeSerial, 8);
}

function v2AttestationTupleValid(value) {
  const keys = ['ctimeNs', 'hardlinkCount', 'fileId', 'mtimeNs', 'reparseState', 'size', 'volumeSerial'];
  return exactObjectKeys(value, keys) && validV2Decimal(value.ctimeNs, 0xffffffffffffffffn)
    && validV2Decimal(value.mtimeNs, 0xffffffffffffffffn)
    && validV2Decimal(value.size, 0xffffffffffffffffn)
    && validV2Decimal(value.hardlinkCount, 0xffffffffn)
    && validV2Hex(value.fileId, 32) && validV2Hex(value.volumeSerial, 8)
    && value.reparseState === 'NOT_REPARSE';
}

function v2AttestationValid(value) {
  const schema = V2_COMPANION.schemas.attestation;
  return exactObjectKeys(value, schema.requiredFields)
    && v2AttestationTupleValid(value.before) && v2AttestationTupleValid(value.after)
    && (value.oplock === 'HELD_NO_BREAK' || value.oplock === 'UNAVAILABLE_FAIL');
}

function v2ItemValid(value) {
  const schema = V2_COMPANION.schemas.chunkItem;
  return exactObjectKeys(value, schema.requiredFields)
    && validV2Decimal(value.entryIndex, V2_LIMITS.MAX_CAPTURED_FRAMES - 1)
    && typeof normalizeSourcePolicyV2Path(value.relativePath) === 'string'
    && validV2Decimal(value.size, V2_LIMITS.MAX_DECODED_ENTRY_BYTES)
    && validV2Hex(value.sha256, 64) && v2IdentityValid(value.identity)
    && v2AttestationValid(value.attestation);
}

function v2CapturedEntryValid(value) {
  const schema = V2_COMPANION.schemas.capturedEntry;
  const tuple = value && typeof value === 'object' ? {
    attestation: value.attestation,
    entryIndex: value.entryIndex,
    identity: value.identity,
    relativePath: value.relativePath,
    sha256: value.sha256,
    size: value.size,
  } : null;
  if (!exactObjectKeys(value, schema.requiredFields) || !v2ItemValid(tuple)
    || !validV2Decimal(value.decodedLength, V2_LIMITS.MAX_DECODED_ENTRY_BYTES)
    || value.decodedLength !== value.size
    || !validV2Base64Url(value.decodedBytesBase64, V2_LIMITS.MAX_FRAME_BODY_BYTES)) return false;
  try {
    const padding = '='.repeat((4 - value.decodedBytesBase64.length % 4) % 4);
    const bytes = Buffer.from(`${value.decodedBytesBase64}${padding}`, 'base64url');
    return bytes.toString('base64url') === value.decodedBytesBase64
      && validV2Decimal(value.decodedLength, bytes.length)
      && Number(value.decodedLength) === bytes.length && sha256(bytes) === value.sha256;
  } catch { return false; }
}

function v2CensusTupleValid(value) {
  const schema = V2_COMPANION.schemas.censusTuple;
  return exactObjectKeys(value, schema.requiredFields) && v2ItemValid(value);
}

function v2ProjectionEntryValid(value) {
  const schema = V2_COMPANION.schemas.projectionEntry;
  const fields = schema.requiredFields.split('|');
  return exactObjectKeys(value, fields) && (value.class === 'INCLUDE' || value.class === 'EXCLUDE')
    && validV2Decimal(value.entryIndex, V2_LIMITS.MAX_CAPTURED_FRAMES - 1)
    && typeof normalizeSourcePolicyV2Path(value.path) === 'string'
    && validV2Decimal(value.size, V2_LIMITS.MAX_DECODED_ENTRY_BYTES) && validV2Hex(value.sha256, 64)
    && typeof value.role === 'string';
}

function v2ResultValid(value) {
  const keys = V2_COMPANION.schemas.result.requiredFields;
  return exactObjectKeys(value, keys) && validV2Decimal(value.aggregateRawBytes, V2_LIMITS.MAX_AGGREGATE_DECODED_BYTES)
    && validV2Decimal(value.entryCount, V2_LIMITS.MAX_CAPTURED_FRAMES)
    && keys.filter(key => !['aggregateRawBytes', 'entryCount'].includes(key)).every(key => validV2Hex(value[key], 64));
}

function v2ErrorValid(value, phase) {
  const schema = V2_COMPANION.schemas.error;
  if (!exactObjectKeys(value, schema.requiredFields) || typeof value.code !== 'string') return false;
  const registry = V2_ERROR_REGISTRY.get(value.code);
  if (!registry || value.phase !== phase || value.phase !== registry.phase || value.retryable !== registry.retryable) {
    return false;
  }
  const detail = value.detail;
  const detailKeys = V2_COMPANION.errorRegistry.detailShape.requiredFields;
  return exactObjectKeys(detail, detailKeys) && detail.kind === registry.detailKind
    && (detail.expected === null || typeof detail.expected === 'string')
    && (detail.observed === null || typeof detail.observed === 'string')
    && (detail.nativeStatus === null || (Number.isInteger(detail.nativeStatus)
      && detail.nativeStatus >= 0 && detail.nativeStatus <= 0xffffffff))
    && (detail.pathToken === null || validV2Hex(detail.pathToken, 64));
}

function canonicalV2FrameWire(frame) {
  const body = Buffer.from(canonicalJsonV4(frame), 'utf8');
  if (body.length > V2_LIMITS.MAX_FRAME_BODY_BYTES || body.length + 9 > V2_LIMITS.MAX_FRAME_WIRE_BYTES) {
    return v2Failure('ADAPTER_FRAME_CAP');
  }
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(body.length));
  return Object.freeze({ ok: true, body, wire: Buffer.concat([prefix, body, Buffer.from('\n')]) });
}

function computeV2ChunkDigest(chunk) {
  if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.items)
    || !Number.isSafeInteger(chunk.chunkIndex) || !Number.isSafeInteger(chunk.chunkCount)
    || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunk.chunkCount || chunk.chunkCount < 1
    || chunk.chunkCount > V2_LIMITS.MAX_CAPTURED_FRAMES || chunk.items.length < 1
    || chunk.items.length > V2_LIMITS.MAX_CHUNK_ELEMENTS || !chunk.items.every(v2ItemValid)
    || !validV2Hex(chunk.rootIdentity, 64) || !validV2Hex(chunk.snapshotId, 32)
    || !validV2Hex(chunk.sessionId, 32) || !validV2Base64Url(chunk.cursorBefore, 512)
    || !validV2Base64Url(chunk.cursorAfter, 512)) return v2Failure('PROTOCOL_SCHEMA');
  return Object.freeze({
    ok: true,
    digest: fieldV3Digest([
      ['domain', Buffer.from('chunk-v3', 'ascii')],
      ['rootIdentity', Buffer.from(chunk.rootIdentity, 'ascii')],
      ['snapshotId', Buffer.from(chunk.snapshotId, 'ascii')],
      ['sessionId', Buffer.from(chunk.sessionId, 'ascii')],
      ['chunkIndex', Buffer.from(String(chunk.chunkIndex), 'ascii')],
      ['chunkCount', Buffer.from(String(chunk.chunkCount), 'ascii')],
      ['cursorBefore', Buffer.from(chunk.cursorBefore, 'ascii')],
      ['cursorAfter', Buffer.from(chunk.cursorAfter, 'ascii')],
      ['items', Buffer.from(canonicalJsonV4(chunk.items), 'utf8')],
    ]),
  });
}

function validateV2Frame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.kind !== 'string') {
    return v2Failure('PROTOCOL_SCHEMA');
  }
  const schema = v2FrameSchema(frame.kind);
  if (!schema || !exactObjectKeys(frame, schema.requiredFields) || !v2CommonFrameValid(frame)) {
    return v2Failure('PROTOCOL_SCHEMA');
  }
  if (schema.values.kind && frame.kind !== schema.values.kind) return v2Failure('PROTOCOL_SCHEMA');
  if (schema.values.phase && frame.phase !== schema.values.phase) return v2Failure('PROTOCOL_SCHEMA');
  if (schema.values.operation && frame.operation !== schema.values.operation) return v2Failure('PROTOCOL_SCHEMA');
  if (Object.hasOwn(schema.values, 'success') && frame.success !== schema.values.success) return v2Failure('PROTOCOL_SCHEMA');
  if (frame.kind === 'start') {
    if (!Number.isSafeInteger(frame.entryCount) || !Number.isSafeInteger(frame.chunkCount)
      || frame.entryCount < 0 || frame.entryCount > V2_LIMITS.MAX_CAPTURED_FRAMES
      || frame.chunkCount < 0 || frame.chunkCount > V2_LIMITS.MAX_CAPTURED_FRAMES
      || !validV2Hex(frame.initialCensusDigest, 64) || !validV2Hex(frame.pathSetDigest, 64)) return v2Failure('PROTOCOL_TYPE');
  } else if (frame.kind === 'chunk') {
    const calculated = computeV2ChunkDigest(frame);
    if (!calculated.ok || !validV2Hex(frame.chunkDigest, 64) || calculated.digest !== frame.chunkDigest) {
      return v2Failure('PROTOCOL_DIGEST');
    }
  } else if (frame.kind === 'captured') {
    if (!v2CapturedEntryValid(frame.capturedEntry)) return v2Failure('PROTOCOL_BASE64');
  } else if (frame.kind === 'initialCensus' || frame.kind === 'finalCensus') {
    if (!validV2Decimal(frame.entryIndex, V2_LIMITS.MAX_CAPTURED_FRAMES - 1)
      || !v2CensusTupleValid(frame.censusTuple) || frame.censusTuple.entryIndex !== frame.entryIndex) {
      return v2Failure('PROTOCOL_JOIN');
    }
  } else if (frame.kind === 'projection') {
    if (!v2ProjectionEntryValid(frame.projectionEntry)) return v2Failure('PROTOCOL_JOIN');
  } else if (frame.kind === 'end') {
    if (!v2ResultValid(v2EndResult(frame))) return v2Failure('PROTOCOL_TYPE');
  } else if (frame.kind === 'finalSuccess') {
    if (!v2ResultValid(frame.result)) return v2Failure('PROTOCOL_TYPE');
  } else if (frame.kind === 'errorFrame' || frame.kind === 'finalError') {
    if (!v2ErrorValid(frame.error, frame.phase)) return v2Failure('PROTOCOL_SCHEMA');
  }
  return Object.freeze({ ok: true });
}

function sameV2Identity(left, right) {
  return left.protocol === right.protocol && left.operation === right.operation
    && left.receiptSha256 === right.receiptSha256 && left.rootIdentity === right.rootIdentity
    && left.sessionId === right.sessionId && left.snapshotId === right.snapshotId;
}

function v2TupleFromCaptured(captured) {
  const { decodedBytesBase64, decodedLength, ...tuple } = captured;
  return tuple;
}

function v2TupleEqual(left, right) {
  return canonicalJsonV4(left) === canonicalJsonV4(right);
}

function v2EndResult(frame) {
  return Object.fromEntries(V2_COMPANION.schemas.result.requiredFields.map(key => [key, frame[key]]));
}

function validateV2FrameSequence(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return v2Failure('PROTOCOL_SEQUENCE');
  const singlePreSession = frames.length === 1 && frames[0]?.kind === 'finalError';
  if (singlePreSession) {
    const frame = frames[0];
    const pre = V2_FRAME_MODEL.preSession;
    if (!exactObjectKeys(frame, V2_FRAME_MODEL.frames.finalError.requiredFields)
      || frame.protocol !== V2_PROTOCOL_NAME || frame.operation !== pre.operation || frame.phase !== pre.phase
      || frame.receiptSha256 !== pre.receiptSha256 || frame.rootIdentity !== pre.rootIdentity
      || frame.sessionId !== pre.sessionId || frame.snapshotId !== pre.snapshotId || frame.success !== false
      || !pre.validCodes.includes(frame.error?.code) || !v2ErrorValid(frame.error, frame.phase)) {
      return v2Failure('PROTOCOL_SEQUENCE');
    }
    return Object.freeze({ ok: true });
  }
  if (frames.some(frame => !validateV2Frame(frame).ok)) return v2Failure('PROTOCOL_SCHEMA');
  const start = frames[0];
  if (start.kind !== 'start') return v2Failure('PROTOCOL_SEQUENCE');
  if (frames.length === 2 && frames[0].kind === 'errorFrame' && frames[1].kind === 'finalError') {
    return sameV2Identity(frames[0], frames[1]) ? Object.freeze({ ok: true }) : v2Failure('PROTOCOL_JOIN');
  }
  if (frames.some(frame => !sameV2Identity(start, frame))) return v2Failure('PROTOCOL_JOIN');
  const count = start.entryCount;
  const chunks = start.chunkCount;
  const read = start.operation === 'read';
  if (read) {
    if (count !== 1 || chunks !== 0) return v2Failure('PROTOCOL_SEQUENCE');
  } else if ((count === 0 && chunks !== 0) || (count > 0 && (chunks < 1 || chunks > count))) {
    return v2Failure('PROTOCOL_SEQUENCE');
  }
  let index = 1;
  const initial = [];
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const frame = frames[index++];
    if (!frame || frame.kind !== 'initialCensus' || Number(frame.entryIndex) !== entryIndex) return v2Failure('PROTOCOL_SEQUENCE');
    initial.push(frame.censusTuple);
  }
  const captured = [];
  if (read) {
    const frame = frames[index++];
    if (!frame || frame.kind !== 'captured' || frame.capturedEntry.entryIndex !== '0') {
      return v2Failure('PROTOCOL_SEQUENCE');
    }
    captured.push(frame.capturedEntry);
  } else {
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
      const chunk = frames[index++];
      if (!chunk || chunk.kind !== 'chunk' || chunk.chunkIndex !== chunkIndex || chunk.chunkCount !== chunks) {
        return v2Failure('PROTOCOL_SEQUENCE');
      }
      for (const item of chunk.items) {
        const frame = frames[index++];
        if (!frame || frame.kind !== 'captured' || !v2TupleEqual(item, v2TupleFromCaptured(frame.capturedEntry))) {
          return v2Failure('PROTOCOL_JOIN');
        }
        captured.push(frame.capturedEntry);
      }
    }
  }
  if (captured.length !== count) return v2Failure('PROTOCOL_COVERAGE');
  const final = [];
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const frame = frames[index++];
    if (!frame || frame.kind !== 'finalCensus' || Number(frame.entryIndex) !== entryIndex) return v2Failure('PROTOCOL_SEQUENCE');
    final.push(frame.censusTuple);
  }
  const projection = [];
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const frame = frames[index++];
    if (!frame || frame.kind !== 'projection' || Number(frame.projectionEntry.entryIndex) !== entryIndex) {
      return v2Failure('PROTOCOL_SEQUENCE');
    }
    projection.push(frame.projectionEntry);
  }
  const end = frames[index++];
  const success = frames[index++];
  if (index !== frames.length || !end || end.kind !== 'end' || !success || success.kind !== 'finalSuccess') {
    return v2Failure('PROTOCOL_SEQUENCE');
  }
  if (!v2TupleEqual(initial, final) || !v2TupleEqual(v2EndResult(end), success.result)) {
    return v2Failure('PROTOCOL_JOIN');
  }
  const aggregate = captured.reduce((total, entry) => total + BigInt(entry.decodedLength), 0n);
  if (end.aggregateRawBytes !== aggregate.toString() || end.entryCount !== String(count)
    || !v2TupleEqual(v2EndResult(end), success.result)) return v2Failure('PROTOCOL_JOIN');
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const tuple = v2TupleFromCaptured(captured[entryIndex]);
    if (!v2TupleEqual(initial[entryIndex], tuple) || !v2TupleEqual(final[entryIndex], tuple)
      || projection[entryIndex].path !== tuple.relativePath || projection[entryIndex].size !== tuple.size
      || projection[entryIndex].sha256 !== tuple.sha256) return v2Failure('PROTOCOL_JOIN');
  }
  return Object.freeze({ ok: true });
}

function trustedCompilerPath(compilerPath) {
  if (typeof compilerPath !== 'string' || !path.isAbsolute(compilerPath)
    || path.basename(compilerPath).toLowerCase() !== 'cl.exe') return false;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean).map(value => `${path.resolve(value).toLowerCase()}${path.sep}`);
  const candidate = path.resolve(compilerPath).toLowerCase();
  return roots.some(root => candidate.startsWith(root));
}

function validTrustedPeX64(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x100 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 0x70 > bytes.length
    || bytes.readUInt32LE(peOffset) !== 0x00004550
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664
    || (bytes.readUInt16LE(peOffset + 22) & 0x0002) === 0) return false;
  const optionalOffset = peOffset + 24;
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  if (optionalSize < 0x70 || optionalOffset + optionalSize > bytes.length
    || bytes.readUInt16LE(optionalOffset) !== 0x020b) return false;
  const dllCharacteristics = bytes.readUInt16LE(optionalOffset + 0x46);
  return (dllCharacteristics & 0x4160) === 0x4160;
}

function loadTrustedTool(toolDirectory) {
  try {
    if (typeof toolDirectory !== 'string' || !path.isAbsolute(toolDirectory)) return null;
    const receiptPath = path.join(toolDirectory, 'codegraph-read-identity-win32.receipt.json');
    const receiptBytes = fs.readFileSync(receiptPath);
    const receiptText = receiptBytes.toString('utf8');
    const receipt = JSON.parse(receiptText);
    if (canonicalJson(receipt) !== receiptText || !exactKeys(receipt, RECEIPT_KEYS)
      || receipt.schemaVersion !== 1 || receipt.protocol !== PROTOCOL_NAME
      || receipt.architecture !== 'x64' || receipt.binaryFile !== 'codegraph-read-identity-win32.exe'
      || !exactKeys(receipt.binaryIdentity, CONTRACT.identityKeys)
      || !validHex(receipt.binaryIdentity.volumeSerial, 16)
      || !validHex(receipt.binaryIdentity.fileId, 32)
      || !validHex(receipt.buildId, 64) || !validHex(receipt.binarySha256, 64)
      || !validHex(receipt.compilerSha256, 64) || !validHex(receipt.protocolSha256, 64)
      || !validHex(receipt.sourceSha256, 64) || canonicalJson(receipt.flags) !== canonicalJson(EXPECTED_FLAGS)
      || !trustedCompilerPath(receipt.compilerPath)) return null;
    const sourceBytes = fs.readFileSync(NATIVE_SOURCE_PATH);
    const compilerBytes = fs.readFileSync(receipt.compilerPath);
    const binaryPath = path.join(toolDirectory, receipt.binaryFile);
    const binaryBytes = fs.readFileSync(binaryPath);
    if (!validTrustedPeX64(binaryBytes)
      || sha256(CONTRACT_BYTES) !== receipt.protocolSha256 || sha256(sourceBytes) !== receipt.sourceSha256
      || sha256(compilerBytes) !== receipt.compilerSha256 || sha256(binaryBytes) !== receipt.binarySha256) return null;
    const buildProjection = {
      architecture: receipt.architecture,
      compilerSha256: receipt.compilerSha256,
      flags: receipt.flags,
      protocol: receipt.protocol,
      protocolSha256: receipt.protocolSha256,
      sourceSha256: receipt.sourceSha256,
    };
    if (sha256(Buffer.from(canonicalJson(buildProjection))) !== receipt.buildId) return null;
    return { binaryPath, receipt };
  } catch { return null; }
}

function resolveTrustedTool(projectRoot, toolDirectory) {
  if (toolDirectory !== undefined) return loadTrustedTool(toolDirectory);
  const buildsRoot = path.join(projectRoot, '.codegraph', 'native', 'codegraph-read-identity-v1');
  try {
    const candidates = fs.readdirSync(buildsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && validHex(entry.name, 64))
      .map(entry => loadTrustedTool(path.join(buildsRoot, entry.name)))
      .filter(Boolean);
    return candidates.length === 1 ? candidates[0] : null;
  } catch { return null; }
}

function invokeTool(binaryPath, request, expected, timeoutMs) {
  const result = spawnSync(binaryPath, [], {
    input: `${canonicalJson(request)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: CONTRACT.limits.responseBytes,
    env: {},
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return fixedFailure('TOOL_TIMEOUT');
  if (result.error || result.status !== 0 || result.stderr !== '') return fixedFailure('TOOL_UNAVAILABLE');
  return decodeNativeResponse(result.stdout, { ...expected, nonce: request.nonce });
}

function attestBuiltTool(binaryPath, expected) {
  try {
    const absolute = path.resolve(binaryPath);
    const root = path.parse(absolute).root;
    const relativePath = path.relative(root, absolute).split(path.sep).join('/');
    const request = normalizeReadRequest(root, relativePath, { maxBytes: CONTRACT.limits.fileBytes });
    if (!request) return null;
    const result = invokeTool(absolute, request, expected, CONTRACT.limits.timeoutMs);
    if (!result.ok || result.sha256 !== expected.binarySha256
      || result.attestation.binarySha256 !== expected.binarySha256
      || canonicalJson(result.identity) !== canonicalJson(result.attestation.binaryIdentity)) return null;
    return Object.freeze({ binaryIdentity: result.identity });
  } catch { return null; }
}

function readCodegraphFileIdentity(projectRoot, relativePath, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return fixedFailure('UNSUPPORTED_PLATFORM');
  const request = normalizeReadRequest(projectRoot, relativePath, options);
  if (!request) return fixedFailure('INVALID_REQUEST');
  const tool = resolveTrustedTool(request.root, options.toolDirectory);
  if (!tool) return fixedFailure('TOOL_UNTRUSTED');
  const timeoutMs = options.timeoutMs ?? CONTRACT.limits.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONTRACT.limits.timeoutMs) {
    return fixedFailure('INVALID_REQUEST');
  }
  return invokeTool(tool.binaryPath, request, {
    binaryIdentity: tool.receipt.binaryIdentity,
    binarySha256: tool.receipt.binarySha256,
    buildId: tool.receipt.buildId,
    protocolSha256: tool.receipt.protocolSha256,
    sourceSha256: tool.receipt.sourceSha256,
  }, timeoutMs);
}

module.exports = Object.freeze({
  PROTOCOL_NAME,
  V2_PROTOCOL_NAME,
  FIXED_ERROR_CODES,
  canonicalJson,
  canonicalV2FrameWire,
  computeV2ChunkDigest,
  validTrustedPeX64,
  attestBuiltTool,
  normalizeReadRequest,
  decodeNativeResponse,
  validateV2Frame,
  validateV2FrameSequence,
  readCodegraphFileIdentity,
});
