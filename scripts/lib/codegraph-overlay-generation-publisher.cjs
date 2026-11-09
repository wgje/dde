#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CONTRACT,
  CONTRACT_DIGEST,
  canonicalControlBytes,
  writeGenerationPayload,
  writePrettyJson,
} = require('./codegraph-overlay-generation-format.cjs');
const {
  createOverlayV1Validator,
} = require('./codegraph-nanoflow-overlay-v1-schema.cjs');

const SHA256 = new RegExp(CONTRACT.patterns.sha256);
const SEQUENCE = new RegExp(CONTRACT.patterns.sequence);
const TRANSACTION_ID = /^tx-[a-f0-9]{32}$/;
const LEASE_SCRIPT = path.resolve(__dirname, '../agent-file-lease.cjs');
const PUBLICATION_RESOURCE_ID = 'codegraph-overlay-generation';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sortedObject(value) {
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validateDigests(options) {
  for (const key of ['configDigest', 'setupDigest', 'sourceManifestDigest', 'toolchainDigest']) {
    if (!SHA256.test(options[key])) throw new TypeError('codegraph-overlay-publication-digest-invalid');
  }
}

function publicationLeaseProjection(evidence) {
  const barrier = evidence?.barrier;
  const resource = evidence?.resource;
  if (barrier?.state !== 'HELD' || typeof barrier.owner !== 'string' || !barrier.owner
    || !Number.isSafeInteger(barrier.fence) || barrier.fence < 1
    || !Number.isSafeInteger(barrier.heldEpoch) || barrier.heldEpoch < 0
    || resource?.state !== 'ACTIVE' || resource.kind !== 'build'
    || resource.resourceId !== 'codegraph-overlay-generation'
    || resource.owner !== barrier.owner || resource.fence !== barrier.fence
    || resource.heldEpoch !== barrier.heldEpoch) {
    throw new Error('codegraph-overlay-publication-lease-invalid');
  }
  return deepFreeze({
    owner: barrier.owner,
    fence: barrier.fence,
    heldEpoch: barrier.heldEpoch,
  });
}

function writeFsynced(filePath, bytes, flags = 'wx') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, flags);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function equalOptionalBytes(left, right) {
  return left === null ? right === null : Buffer.isBuffer(right) && left.equals(right);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function readCurrentSequence(bytes) {
  if (bytes === null) return null;
  if (bytes.length > CONTRACT.limits.controlFileBytes) {
    throw new Error('codegraph-overlay-publication-current-invalid');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('codegraph-overlay-publication-current-invalid');
  }
  if (!exactKeys(value, CONTRACT.currentKeys) || !canonicalControlBytes(value).equals(bytes)
    || value.schemaVersion !== CONTRACT.schemaVersion || value.protocol !== CONTRACT.protocol
    || !SEQUENCE.test(value.sequence)) {
    throw new Error('codegraph-overlay-publication-current-invalid');
  }
  return value.sequence;
}

function validateOverlay(overlay, projectRoot) {
  try {
    const validator = createOverlayV1Validator({
      expectedProjectRoot: projectRoot.replace(/\\/g, '/'),
      expectedSourcePolicyDigest: CONTRACT.sourcePolicyDigest,
    });
    writePrettyJson(overlay, chunk => validator.write(chunk));
    const result = validator.finish();
    if (result.schemaDigest !== CONTRACT.overlaySchemaDigest
      || result.sourcePolicyDigest !== CONTRACT.sourcePolicyDigest) {
      throw new Error('schema authority digest mismatch');
    }
    return result.artifact;
  } catch (cause) {
    const error = new Error('codegraph-overlay-publication-schema-invalid');
    error.cause = cause;
    throw error;
  }
}

function createFileOpener(rootDirectory) {
  const resolvedRoot = path.resolve(rootDirectory);
  return relativePath => {
    const filePath = path.resolve(resolvedRoot, ...relativePath.split('/'));
    if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error('codegraph-overlay-publication-path-escape');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const descriptor = fs.openSync(filePath, 'wx');
    let closed = false;
    return {
      write(chunk) {
        if (closed) throw new Error('codegraph-overlay-publication-file-closed');
        fs.writeSync(descriptor, chunk);
      },
      close() {
        if (closed) throw new Error('codegraph-overlay-publication-file-closed');
        closed = true;
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      },
    };
  };
}

function runLeaseCommand(projectRoot, owner, args, token) {
  const result = spawnSync(process.execPath, [
    LEASE_SCRIPT,
    '--root', projectRoot,
    '--owner', owner,
    ...args,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: token,
    windowsHide: true,
    maxBuffer: CONTRACT.limits.controlFileBytes,
    env: process.env,
  });
  let body = null;
  try { body = JSON.parse(result.stdout); } catch { /* fixed error below */ }
  if (result.error || result.signal || result.status !== 0 || !body?.ok) {
    throw new Error('codegraph-overlay-publication-lease-command-failed');
  }
  return body;
}

function acquireOverlayPublicationLease({ projectRoot, owner, ttlMs }) {
  const root = path.resolve(String(projectRoot ?? ''));
  if (!path.isAbsolute(root) || typeof owner !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(owner)
    || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60 * 1000) {
    throw new TypeError('codegraph-overlay-publication-lease-request-invalid');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFingerprint = sha256(Buffer.from(token, 'ascii')).slice(0, 12);
  const barrier = runLeaseCommand(root, owner, ['--barrier-token-stdin', 'barrier-acquire'], token);
  if (barrier.barrier?.state !== 'HELD') {
    try {
      runLeaseCommand(root, owner, ['--barrier-token', token, 'barrier-release']);
    } catch {
      // The caller receives a fixed failure and the registry retains recovery evidence.
    }
    throw new Error('codegraph-overlay-publication-barrier-not-held');
  }
  try {
    runLeaseCommand(root, owner, [
      '--ttl-ms', String(ttlMs),
      '--resource-kind', 'build',
      '--resource-id', PUBLICATION_RESOURCE_ID,
      '--resource-token-stdin',
      'resource-lease-acquire',
    ], token);
  } catch (error) {
    try {
      runLeaseCommand(root, owner, ['--barrier-token', token, 'barrier-release']);
    } catch {
      // Preserve the resource acquisition failure.
    }
    throw error;
  }
  let released = false;
  const readLeaseEvidence = () => {
    if (released) throw new Error('codegraph-overlay-publication-lease-released');
    const status = runLeaseCommand(root, owner, ['status']);
    const resource = status.resourceLeases?.active?.find(entry => (
      entry.kind === 'build' && entry.resourceId === PUBLICATION_RESOURCE_ID
      && entry.owner === owner && entry.tokenFingerprint === tokenFingerprint
    ));
    if (!resource) throw new Error('codegraph-overlay-publication-resource-missing');
    return {
      workspaceEpoch: status.workspaceEpoch,
      barrier: status.barrier,
      resource,
    };
  };
  return Object.freeze({
    readLeaseEvidence,
    release() {
      if (released) return;
      runLeaseCommand(root, owner, [
        '--ttl-ms', String(ttlMs),
        '--resource-kind', 'build',
        '--resource-id', PUBLICATION_RESOURCE_ID,
        '--resource-token-stdin',
        'resource-lease-release',
      ], token);
      runLeaseCommand(root, owner, ['--barrier-token', token, 'barrier-release']);
      released = true;
    },
  });
}

function createOverlayGenerationPublisher(dependencies = {}) {
  const readLeaseEvidence = dependencies.readLeaseEvidence;
  const transactionId = dependencies.transactionId
    ?? (() => `tx-${crypto.randomBytes(16).toString('hex')}`);
  if (typeof readLeaseEvidence !== 'function' || typeof transactionId !== 'function') {
    throw new TypeError('codegraph-overlay-publisher-dependencies-invalid');
  }

  function publish(options) {
    const projectRoot = path.resolve(String(options?.projectRoot ?? ''));
    if (!path.isAbsolute(projectRoot) || !options?.overlay || typeof options.overlay !== 'object'
      || (options.sequence !== undefined && !SEQUENCE.test(options.sequence))
      || !canonicalTimestamp(options.publishedAt)) {
      throw new TypeError('codegraph-overlay-publication-request-invalid');
    }
    validateDigests(options);
    const firstLease = publicationLeaseProjection(readLeaseEvidence());
    const tx = transactionId();
    if (!TRANSACTION_ID.test(tx)) throw new Error('codegraph-overlay-publication-transaction-invalid');

    const root = path.join(projectRoot, ...CONTRACT.paths.generationRoot.split('/'));
    const transactionRoot = path.join(root, CONTRACT.paths.transactions);
    const transactionDirectory = path.join(transactionRoot, tx);
    const preparingDirectory = path.join(transactionDirectory, 'generation');
    const quarantineRoot = path.join(root, CONTRACT.paths.quarantine);
    const currentPath = path.join(root, CONTRACT.paths.current);
    const initialCurrent = readIfExists(currentPath);
    const previousSequence = readCurrentSequence(initialCurrent);
    const sequence = options.sequence ?? (previousSequence === null
      ? '1'
      : String(BigInt(previousSequence) + 1n));
    if (!SEQUENCE.test(sequence)) throw new Error('codegraph-overlay-publication-sequence-exhausted');
    if (previousSequence !== null && BigInt(sequence) <= BigInt(previousSequence)) {
      throw new Error('codegraph-overlay-publication-sequence-rollback');
    }
    const compatibilityEvidence = validateOverlay(options.overlay, projectRoot);
    let finalDirectory = null;
    let currentCommitted = false;

    fs.mkdirSync(transactionRoot, { recursive: true });
    fs.mkdirSync(transactionDirectory);
    try {
      writeFsynced(path.join(transactionDirectory, 'COMMITTING.json'), canonicalControlBytes({
        barrier: firstLease,
        protocol: CONTRACT.protocol,
        publishedAt: options.publishedAt,
        sequence,
        sourceManifestDigest: options.sourceManifestDigest,
        transactionId: tx,
      }));
      fs.mkdirSync(preparingDirectory);

      const generationProjection = {
        compatibilityDigest: compatibilityEvidence.sha256,
        overlaySchemaDigest: CONTRACT.overlaySchemaDigest,
        sequence,
        sourceManifestDigest: options.sourceManifestDigest,
        sourcePolicyDigest: CONTRACT.sourcePolicyDigest,
      };
      const generationId = `g-${sha256(canonicalControlBytes(generationProjection))}`;
      const payload = writeGenerationPayload({
        overlay: options.overlay,
        generationId,
        sequence,
        openFile: createFileOpener(preparingDirectory),
      });
      if (payload.compatibility.bytes !== compatibilityEvidence.bytes
        || payload.compatibility.sha256 !== compatibilityEvidence.sha256) {
        throw new Error('codegraph-overlay-publication-compatibility-drift');
      }
      const manifest = {
        arrays: payload.arrays,
        compatibility: payload.compatibility,
        contractDigest: CONTRACT_DIGEST,
        generationId,
        overlaySchemaDigest: CONTRACT.overlaySchemaDigest,
        protocol: CONTRACT.protocol,
        schemaVersion: CONTRACT.schemaVersion,
        sequence,
        skeleton: payload.skeleton,
        sourceManifestDigest: options.sourceManifestDigest,
        sourcePolicyDigest: CONTRACT.sourcePolicyDigest,
        totalBytes: payload.totalBytes,
      };
      const manifestBytes = canonicalControlBytes(manifest);
      const manifestDigest = sha256(manifestBytes);
      const receiptProjection = {
        barrier: firstLease,
        compatibilityDigest: payload.compatibility.sha256,
        configDigest: options.configDigest,
        contractDigest: CONTRACT_DIGEST,
        generationId,
        manifestDigest,
        overlaySchemaDigest: CONTRACT.overlaySchemaDigest,
        protocol: CONTRACT.protocol,
        publishedAt: options.publishedAt,
        schemaVersion: CONTRACT.schemaVersion,
        sequence,
        setupDigest: options.setupDigest,
        sourceManifestDigest: options.sourceManifestDigest,
        sourcePolicyDigest: CONTRACT.sourcePolicyDigest,
        toolchainDigest: options.toolchainDigest,
      };
      const receiptDigest = sha256(canonicalControlBytes(receiptProjection));
      const receipt = { ...receiptProjection, receiptDigest };
      writeFsynced(path.join(preparingDirectory, CONTRACT.paths.manifest), manifestBytes);
      writeFsynced(
        path.join(preparingDirectory, CONTRACT.paths.receipt),
        canonicalControlBytes(receipt),
      );

      finalDirectory = path.join(root, generationId);
      if (fs.existsSync(finalDirectory)) throw new Error('codegraph-overlay-publication-generation-conflict');
      fs.renameSync(preparingDirectory, finalDirectory);

      const finalLease = publicationLeaseProjection(readLeaseEvidence());
      if (!canonicalControlBytes(firstLease).equals(canonicalControlBytes(finalLease))) {
        throw new Error('codegraph-overlay-publication-lease-drift');
      }
      if (!equalOptionalBytes(initialCurrent, readIfExists(currentPath))) {
        throw new Error('codegraph-overlay-publication-current-drift');
      }
      const current = sortedObject({
        compatibilityDigest: payload.compatibility.sha256,
        contractDigest: CONTRACT_DIGEST,
        generationId,
        manifestDigest,
        overlaySchemaDigest: CONTRACT.overlaySchemaDigest,
        protocol: CONTRACT.protocol,
        publishedAt: options.publishedAt,
        receiptDigest,
        schemaVersion: CONTRACT.schemaVersion,
        sequence,
        sourcePolicyDigest: CONTRACT.sourcePolicyDigest,
      });
      const currentBytes = canonicalControlBytes(current);
      const currentTempPath = path.join(root, `.CURRENT.${tx}.tmp`);
      writeFsynced(currentTempPath, currentBytes);
      fs.renameSync(currentTempPath, currentPath);
      const readback = fs.readFileSync(currentPath);
      if (!readback.equals(currentBytes)) throw new Error('codegraph-overlay-publication-current-readback-drift');
      currentCommitted = true;
      fs.rmSync(transactionDirectory, { recursive: true });
      return deepFreeze({
        current,
        generationPath: finalDirectory,
        manifest,
        receipt,
      });
    } catch (error) {
      try {
        fs.mkdirSync(quarantineRoot, { recursive: true });
        const quarantineDirectory = path.join(quarantineRoot, tx);
        if (fs.existsSync(transactionDirectory)) fs.renameSync(transactionDirectory, quarantineDirectory);
        if (!currentCommitted && finalDirectory && fs.existsSync(finalDirectory)) {
          const target = fs.existsSync(quarantineDirectory)
            ? path.join(quarantineDirectory, 'generation')
            : quarantineDirectory;
          fs.renameSync(finalDirectory, target);
        }
      } catch {
        // Preserve the primary publication failure and any remaining evidence in place.
      }
      throw error;
    }
  }

  return Object.freeze({ publish });
}

module.exports = Object.freeze({
  acquireOverlayPublicationLease,
  createOverlayGenerationPublisher,
});
