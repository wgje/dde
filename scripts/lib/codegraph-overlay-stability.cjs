#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildBaseline } = require('./codegraph-overlay-baseline.cjs');

const DOC_TRANSACTION_RELATIVE_DIR = path.join('.codegraph', 'codegraph-overlay-doc-sync-transaction');
const NORMALIZED_TIMESTAMP = '<codegraph-overlay-stability-timestamp>';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizeGeneratedAt(value) {
  if (Array.isArray(value)) return value.map(normalizeGeneratedAt);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'generatedAt' ? NORMALIZED_TIMESTAMP : normalizeGeneratedAt(item),
  ]));
}

function normalizeOverlayForStability(overlay) {
  const normalized = normalizeGeneratedAt(overlay);
  for (const node of normalized?.graph?.nodes ?? []) {
    if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, 'updatedAt')) {
      node.updatedAt = NORMALIZED_TIMESTAMP;
    }
  }
  return normalized;
}

function fingerprintOverlay(overlay) {
  const bytes = Buffer.from(stableJson(normalizeOverlayForStability(overlay)), 'utf8');
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function semanticBaselineForStability(overlay) {
  const { graphNodes: _graphNodes, graphEdges: _graphEdges, ...semantic } = buildBaseline(overlay);
  return canonicalize(semantic);
}

function assertStableOverlay(first, second) {
  const firstFingerprint = fingerprintOverlay(first);
  const secondFingerprint = fingerprintOverlay(second);
  if (stableJson(firstFingerprint) !== stableJson(secondFingerprint)) {
    throw new Error(`codegraph-overlay-normalized-drift: ${firstFingerprint.sha256} != ${secondFingerprint.sha256}`);
  }
  const firstSemantic = semanticBaselineForStability(first);
  const secondSemantic = semanticBaselineForStability(second);
  if (stableJson(firstSemantic) !== stableJson(secondSemantic)) {
    throw new Error('codegraph-overlay-semantic-count-drift');
  }
  return { fingerprint: secondFingerprint, semantic: secondSemantic };
}

function manifestDigest(manifest) {
  return sha256(Buffer.from(stableJson(manifest), 'utf8'));
}

function assertSourceManifestEqual(left, right) {
  const leftDigest = manifestDigest(left);
  const rightDigest = manifestDigest(right);
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(`codegraph-overlay-source-manifest-drift: ${leftDigest} != ${rightDigest}`);
  }
  return rightDigest;
}

function planDigest(plan) {
  return sha256(Buffer.from(stableJson(plan), 'utf8'));
}

function createParticipantToken(plan) {
  return `${planDigest(plan).slice(0, 16)}-${crypto.randomBytes(16).toString('hex')}`;
}

function assertParticipantPlan(plan, env = process.env) {
  const token = env.NANOFLOW_CODEGRAPH_STABILITY_PARTICIPANT_TOKEN;
  const digest = env.NANOFLOW_CODEGRAPH_STABILITY_PLAN_DIGEST;
  if (!token && !digest) return;
  if (!token || !digest || !/^[a-f0-9]{16}-[a-f0-9]{32}$/.test(token)) {
    throw new Error('codegraph-overlay-stability-participant-invalid');
  }
  if (digest !== planDigest(plan)) {
    throw new Error('codegraph-overlay-stability-plan-digest-mismatch');
  }
}

function fileEvidence(filePath) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    bytes: bytes.length,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(bytes),
  };
}

function writeFsynced(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'w');
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeFileAtomically(outputPath, content) {
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const tempPath = path.join(outputDir, `${path.basename(outputPath)}.tmp-${process.pid}-${Date.now()}`);
  writeFsynced(tempPath, content);
  renameWithRetry(tempPath, outputPath);
}

function renameWithRetry(tempPath, outputPath) {
  const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.renameSync(tempPath, outputPath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error?.code) || attempt === 8) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
    }
  }
  try {
    fs.unlinkSync(tempPath);
  } catch {
    // Preserve the rename failure.
  }
  throw lastError;
}

function assertNumericTokenOnlyChange(before, after, label) {
  const nonNumeric = value => String(value).split(/[0-9]+(?:,[0-9]{3})*/g);
  const beforeParts = nonNumeric(before);
  const afterParts = nonNumeric(after);
  if (stableJson(beforeParts) !== stableJson(afterParts)) {
    throw new Error(`codegraph-overlay-doc-sync-nonnumeric-change: ${label}`);
  }
}

function docsTransactionPaths(root) {
  const directory = path.join(root, DOC_TRANSACTION_RELATIVE_DIR);
  const preparingDirectory = `${directory}.preparing`;
  return {
    directory,
    journal: path.join(directory, 'journal.json'),
    preparingDirectory,
    preparingJournal: path.join(preparingDirectory, 'journal.json'),
  };
}

function inspectDocsTransaction(root) {
  const paths = docsTransactionPaths(root);
  return {
    ...paths,
    pending: fs.existsSync(paths.directory) || fs.existsSync(paths.preparingDirectory),
  };
}

function assertDocsTransactionClean(root) {
  const state = inspectDocsTransaction(root);
  if (state.pending) {
    const pendingPath = fs.existsSync(state.directory) ? state.directory : state.preparingDirectory;
    throw new Error(`codegraph-overlay-doc-sync-pending: ${toPosix(path.relative(root, pendingPath))}`);
  }
  return state;
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

module.exports = {
  DOC_TRANSACTION_RELATIVE_DIR,
  assertDocsTransactionClean,
  assertNumericTokenOnlyChange,
  assertParticipantPlan,
  assertSourceManifestEqual,
  assertStableOverlay,
  createParticipantToken,
  docsTransactionPaths,
  fileEvidence,
  fingerprintOverlay,
  inspectDocsTransaction,
  manifestDigest,
  normalizeOverlayForStability,
  planDigest,
  semanticBaselineForStability,
  sha256,
  stableJson,
  writeFileAtomically,
  writeFsynced,
};
