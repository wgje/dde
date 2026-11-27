#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTRACT,
  CONTRACT_DIGEST,
  canonicalControlBytes,
  writePrettyJson,
} = require('./codegraph-overlay-generation-format.cjs');
const {
  createOverlayV1Validator,
} = require('./codegraph-nanoflow-overlay-v1-schema.cjs');

const GENERATION_ID = new RegExp(CONTRACT.patterns.generationId);
const SEQUENCE = new RegExp(CONTRACT.patterns.sequence);
const SHA256 = new RegExp(CONTRACT.patterns.sha256);
const ERROR_CODES = new Set([
  'INVALID_PROJECT_ROOT',
  'CURRENT_MISSING',
  'CURRENT_INVALID',
  'GENERATION_INVALID',
  'MANIFEST_INVALID',
  'RECEIPT_INVALID',
  'PAYLOAD_INVALID',
  'SELECTOR_DRIFT',
  'IO_FAILURE',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code) {
  const error = new Error(code);
  error.currentReceiptErrorCode = code;
  throw error;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function readBytes(filePath, limit, missingCode, invalidCode) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(missingCode);
    fail('IO_FAILURE');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) {
    fail(invalidCode);
  }
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    fail('IO_FAILURE');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== stat.size) fail(invalidCode);
  return bytes;
}

function parseCanonical(bytes, keys, code) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(code);
  }
  if (!exactKeys(value, keys)) fail(code);
  let canonical;
  try {
    canonical = canonicalControlBytes(value);
  } catch {
    fail(code);
  }
  if (!canonical.equals(bytes)) fail(code);
  return value;
}

function validateDigest(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
}

function validateCurrent(value) {
  if (value.schemaVersion !== CONTRACT.schemaVersion || value.protocol !== CONTRACT.protocol
    || value.contractDigest !== CONTRACT_DIGEST
    || value.overlaySchemaDigest !== CONTRACT.overlaySchemaDigest
    || value.sourcePolicyDigest !== CONTRACT.sourcePolicyDigest
    || !GENERATION_ID.test(value.generationId) || !SEQUENCE.test(value.sequence)
    || !canonicalTimestamp(value.publishedAt)) fail('CURRENT_INVALID');
  for (const key of ['compatibilityDigest', 'manifestDigest', 'receiptDigest']) {
    validateDigest(value[key], 'CURRENT_INVALID');
  }
}

function safeGenerationPath(generationDirectory, relativePath, code) {
  if (typeof relativePath !== 'string' || relativePath.length > CONTRACT.limits.pathCharacters
    || path.isAbsolute(relativePath) || relativePath.includes('\\')) fail(code);
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail(code);
  const resolved = path.resolve(generationDirectory, ...parts);
  if (!resolved.startsWith(`${generationDirectory}${path.sep}`)) fail(code);
  return resolved;
}

function validateFileDescriptor(descriptor, expectedPath, code) {
  if (!exactKeys(descriptor, CONTRACT.fileDescriptorKeys)
    || descriptor.path !== expectedPath
    || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1) fail(code);
  validateDigest(descriptor.sha256, code);
}

function validateManifest(value, current) {
  if (value.schemaVersion !== CONTRACT.schemaVersion || value.protocol !== CONTRACT.protocol
    || value.contractDigest !== CONTRACT_DIGEST || value.generationId !== current.generationId
    || value.sequence !== current.sequence
    || value.overlaySchemaDigest !== current.overlaySchemaDigest
    || value.sourcePolicyDigest !== current.sourcePolicyDigest
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1
    || value.totalBytes > CONTRACT.limits.generationBytes
    || !Array.isArray(value.arrays) || value.arrays.length > CONTRACT.limits.arrayCount) {
    fail('MANIFEST_INVALID');
  }
  validateDigest(value.sourceManifestDigest, 'MANIFEST_INVALID');
  validateFileDescriptor(value.compatibility, CONTRACT.paths.compatibility, 'MANIFEST_INVALID');
  validateFileDescriptor(value.skeleton, CONTRACT.paths.skeleton, 'MANIFEST_INVALID');
  if (value.compatibility.sha256 !== current.compatibilityDigest) fail('MANIFEST_INVALID');
}

function validateReceipt(value, current, manifest) {
  if (value.schemaVersion !== CONTRACT.schemaVersion || value.protocol !== CONTRACT.protocol
    || value.contractDigest !== CONTRACT_DIGEST || value.generationId !== current.generationId
    || value.sequence !== current.sequence || value.publishedAt !== current.publishedAt
    || value.manifestDigest !== current.manifestDigest
    || value.receiptDigest !== current.receiptDigest
    || value.compatibilityDigest !== current.compatibilityDigest
    || value.overlaySchemaDigest !== current.overlaySchemaDigest
    || value.sourcePolicyDigest !== current.sourcePolicyDigest
    || value.sourceManifestDigest !== manifest.sourceManifestDigest
    || !exactKeys(value.barrier, CONTRACT.barrierKeys)
    || typeof value.barrier.owner !== 'string' || value.barrier.owner.length < 1
    || !Number.isSafeInteger(value.barrier.fence) || value.barrier.fence < 1
    || !Number.isSafeInteger(value.barrier.heldEpoch) || value.barrier.heldEpoch < 0) {
    fail('RECEIPT_INVALID');
  }
  for (const key of ['configDigest', 'setupDigest', 'sourceManifestDigest', 'toolchainDigest']) {
    validateDigest(value[key], 'RECEIPT_INVALID');
  }
  const projection = Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'receiptDigest'));
  if (sha256(canonicalControlBytes(projection)) !== value.receiptDigest) {
    fail('RECEIPT_INVALID');
  }
}

function readPayloadFile(generationDirectory, descriptor, limit) {
  const filePath = safeGenerationPath(generationDirectory, descriptor.path, 'PAYLOAD_INVALID');
  const bytes = readBytes(filePath, limit, 'PAYLOAD_INVALID', 'PAYLOAD_INVALID');
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    fail('PAYLOAD_INVALID');
  }
  return bytes;
}

function parseJson(value) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value);
  } catch {
    fail('PAYLOAD_INVALID');
  }
}

function setArrayAtPath(skeleton, jsonPath, records, usedPaths) {
  if (!Array.isArray(jsonPath) || jsonPath.length < 1
    || jsonPath.some(key => typeof key !== 'string' || key.length < 1)) fail('PAYLOAD_INVALID');
  const signature = JSON.stringify(jsonPath);
  if (usedPaths.has(signature)) fail('PAYLOAD_INVALID');
  usedPaths.add(signature);
  let target = skeleton;
  for (const key of jsonPath.slice(0, -1)) {
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || !Object.prototype.hasOwnProperty.call(target, key)) fail('PAYLOAD_INVALID');
    target = target[key];
  }
  const leaf = jsonPath.at(-1);
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || !Object.prototype.hasOwnProperty.call(target, leaf)
    || !Array.isArray(target[leaf]) || target[leaf].length !== 0) fail('PAYLOAD_INVALID');
  target[leaf] = records;
}

function readArray(generationDirectory, descriptor, counters) {
  if (!exactKeys(descriptor, CONTRACT.arrayDescriptorKeys)
    || !Number.isSafeInteger(descriptor.count) || descriptor.count < 0
    || !Array.isArray(descriptor.shards)) fail('PAYLOAD_INVALID');
  const records = [];
  for (const shard of descriptor.shards) {
    counters.shards += 1;
    if (counters.shards > CONTRACT.limits.shardCount
      || !exactKeys(shard, CONTRACT.shardDescriptorKeys)
      || !Number.isSafeInteger(shard.count) || shard.count < 1
      || !Number.isSafeInteger(shard.bytes) || shard.bytes < 1
      || shard.bytes > CONTRACT.limits.shardBytes) fail('PAYLOAD_INVALID');
    validateDigest(shard.sha256, 'PAYLOAD_INVALID');
    const bytes = readPayloadFile(generationDirectory, shard, CONTRACT.limits.shardBytes);
    counters.bytes += bytes.length;
    if (bytes.at(-1) !== 10) fail('PAYLOAD_INVALID');
    const lines = bytes.toString('utf8').slice(0, -1).split('\n');
    if (lines.length !== shard.count || lines.some(line => !line
      || Buffer.byteLength(`${line}\n`, 'utf8') > CONTRACT.limits.recordBytes)) fail('PAYLOAD_INVALID');
    const parsed = parseJson(`[${lines.join(',')}]`);
    if (!Array.isArray(parsed) || parsed.length !== lines.length) fail('PAYLOAD_INVALID');
    for (const record of parsed) records.push(record);
  }
  if (records.length !== descriptor.count
    || (descriptor.count === 0 && descriptor.shards.length !== 0)) fail('PAYLOAD_INVALID');
  return records;
}

function readPayload(generationDirectory, manifest, projectRoot) {
  const compatibilityPath = safeGenerationPath(
    generationDirectory,
    manifest.compatibility.path,
    'PAYLOAD_INVALID',
  );
  let compatibilityStat;
  try { compatibilityStat = fs.lstatSync(compatibilityPath); } catch { fail('PAYLOAD_INVALID'); }
  if (!compatibilityStat.isFile() || compatibilityStat.isSymbolicLink()
    || compatibilityStat.size !== manifest.compatibility.bytes) fail('PAYLOAD_INVALID');

  const skeletonBytes = readPayloadFile(
    generationDirectory,
    manifest.skeleton,
    CONTRACT.limits.controlFileBytes,
  );
  const skeleton = parseJson(skeletonBytes);
  const counters = { bytes: skeletonBytes.length, shards: 0 };
  const usedPaths = new Set();
  for (const descriptor of manifest.arrays) {
    const records = readArray(generationDirectory, descriptor, counters);
    setArrayAtPath(skeleton, descriptor.jsonPath, records, usedPaths);
  }
  const expectedTotal = manifest.compatibility.bytes + counters.bytes;
  if (expectedTotal !== manifest.totalBytes) fail('PAYLOAD_INVALID');

  try {
    const validator = createOverlayV1Validator({
      expectedProjectRoot: projectRoot.replace(/\\/g, '/'),
      expectedSourcePolicyDigest: CONTRACT.sourcePolicyDigest,
    });
    writePrettyJson(skeleton, chunk => validator.write(chunk));
    const evidence = validator.finish();
    if (evidence.schemaDigest !== CONTRACT.overlaySchemaDigest
      || evidence.sourcePolicyDigest !== CONTRACT.sourcePolicyDigest
      || evidence.artifact.bytes !== manifest.compatibility.bytes
      || evidence.artifact.sha256 !== manifest.compatibility.sha256) fail('PAYLOAD_INVALID');
  } catch (error) {
    if (error?.currentReceiptErrorCode) throw error;
    fail('PAYLOAD_INVALID');
  }
  return skeleton;
}

function readOverlayCurrentReceipt(projectRoot) {
  try {
    if (typeof projectRoot !== 'string' || projectRoot.length < 1) fail('INVALID_PROJECT_ROOT');
    const root = path.resolve(projectRoot);
    let rootStat;
    try { rootStat = fs.statSync(root); } catch { fail('INVALID_PROJECT_ROOT'); }
    if (!rootStat.isDirectory()) fail('INVALID_PROJECT_ROOT');
    const generationRoot = path.join(root, ...CONTRACT.paths.generationRoot.split('/'));
    const currentPath = path.join(generationRoot, CONTRACT.paths.current);
    const currentBytes = readBytes(
      currentPath,
      CONTRACT.limits.controlFileBytes,
      'CURRENT_MISSING',
      'CURRENT_INVALID',
    );
    const current = parseCanonical(currentBytes, CONTRACT.currentKeys, 'CURRENT_INVALID');
    validateCurrent(current);
    const generationDirectory = path.join(generationRoot, current.generationId);
    let generationStat;
    try { generationStat = fs.lstatSync(generationDirectory); } catch { fail('GENERATION_INVALID'); }
    if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) fail('GENERATION_INVALID');

    const manifestBytes = readBytes(
      path.join(generationDirectory, CONTRACT.paths.manifest),
      CONTRACT.limits.controlFileBytes,
      'MANIFEST_INVALID',
      'MANIFEST_INVALID',
    );
    if (sha256(manifestBytes) !== current.manifestDigest) fail('MANIFEST_INVALID');
    const manifest = parseCanonical(manifestBytes, CONTRACT.manifestKeys, 'MANIFEST_INVALID');
    validateManifest(manifest, current);
    const receiptBytes = readBytes(
      path.join(generationDirectory, CONTRACT.paths.receipt),
      CONTRACT.limits.controlFileBytes,
      'RECEIPT_INVALID',
      'RECEIPT_INVALID',
    );
    const receipt = parseCanonical(receiptBytes, CONTRACT.receiptKeys, 'RECEIPT_INVALID');
    validateReceipt(receipt, current, manifest);
    const overlay = readPayload(generationDirectory, manifest, root);
    const currentReadback = readBytes(
      currentPath,
      CONTRACT.limits.controlFileBytes,
      'SELECTOR_DRIFT',
      'SELECTOR_DRIFT',
    );
    if (!currentBytes.equals(currentReadback)) fail('SELECTOR_DRIFT');
    return deepFreeze({ ok: true, current, manifest, receipt, overlay });
  } catch (error) {
    const errorCode = ERROR_CODES.has(error?.currentReceiptErrorCode)
      ? error.currentReceiptErrorCode
      : 'IO_FAILURE';
    return deepFreeze({ ok: false, errorCode });
  }
}

module.exports = Object.freeze({ readOverlayCurrentReceipt });
