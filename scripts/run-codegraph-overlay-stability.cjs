#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  createParticipantToken,
  fileEvidence,
  planDigest,
} = require('./lib/codegraph-overlay-stability.cjs');
const {
  CONTRACT,
  CONTRACT_DIGEST,
  canonicalControlBytes,
} = require('./lib/codegraph-overlay-generation-format.cjs');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GENERATOR_RESULT_PREFIX = '[codegraph-overlay] ';
const SHA256 = new RegExp(CONTRACT.patterns.sha256);
const GENERATION_ID = new RegExp(CONTRACT.patterns.generationId);
const SEQUENCE = new RegExp(CONTRACT.patterns.sequence);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function parseGeneratorPublication(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(GENERATOR_RESULT_PREFIX));
  if (lines.length !== 1) throw new Error('codegraph-overlay-stability-result-invalid');
  let publication;
  try { publication = JSON.parse(lines[0].slice(GENERATOR_RESULT_PREFIX.length)); } catch { /* below */ }
  if (!exactKeys(publication, ['compatibilityDigest', 'generationId', 'sequence'])
    || !SHA256.test(publication.compatibilityDigest)
    || !GENERATION_ID.test(publication.generationId)
    || !SEQUENCE.test(publication.sequence)) {
    throw new Error('codegraph-overlay-stability-result-invalid');
  }
  return Object.freeze(publication);
}

function readCanonicalCurrent(currentPath) {
  const bytes = fs.readFileSync(currentPath);
  if (bytes.length > CONTRACT.limits.controlFileBytes) {
    throw new Error('codegraph-overlay-stability-current-invalid');
  }
  let current;
  try { current = JSON.parse(bytes.toString('utf8')); } catch { /* below */ }
  if (!exactKeys(current, CONTRACT.currentKeys) || !canonicalControlBytes(current).equals(bytes)
    || !GENERATION_ID.test(current.generationId) || !SHA256.test(current.compatibilityDigest)
    || !SHA256.test(current.manifestDigest) || !SHA256.test(current.receiptDigest)
    || !SEQUENCE.test(current.sequence) || !canonicalTimestamp(current.publishedAt)
    || current.schemaVersion !== CONTRACT.schemaVersion || current.protocol !== CONTRACT.protocol
    || current.contractDigest !== CONTRACT_DIGEST
    || current.overlaySchemaDigest !== CONTRACT.overlaySchemaDigest
    || current.sourcePolicyDigest !== CONTRACT.sourcePolicyDigest) {
    throw new Error('codegraph-overlay-stability-current-invalid');
  }
  return { bytes, current };
}

function readPublishedOutput(root, publication) {
  const generationRoot = path.join(root, ...CONTRACT.paths.generationRoot.split('/'));
  const currentPath = path.join(generationRoot, CONTRACT.paths.current);
  const before = readCanonicalCurrent(currentPath);
  if (before.current.generationId !== publication.generationId
    || before.current.sequence !== publication.sequence
    || before.current.compatibilityDigest !== publication.compatibilityDigest) {
    throw new Error('codegraph-overlay-stability-publication-mismatch');
  }
  const compatibilityPath = path.join(
    generationRoot,
    publication.generationId,
    ...CONTRACT.paths.compatibility.split('/'),
  );
  const output = fileEvidence(compatibilityPath);
  const after = readCanonicalCurrent(currentPath);
  if (!before.bytes.equals(after.bytes)) throw new Error('codegraph-overlay-stability-current-drift');
  if (output.sha256 !== publication.compatibilityDigest) {
    throw new Error('codegraph-overlay-stability-compatibility-drift');
  }
  return output;
}

function buildStableGenerationPlan(options) {
  return {
    version: 1,
    participant: 'generate-codegraph-nanoflow-overlay',
    buildCount: 2,
    root: path.resolve(options.root),
    outputPath: path.resolve(options.outputPath),
  };
}

function runStableGenerator(options) {
  const root = path.resolve(options.root);
  const outputPath = path.resolve(options.outputPath);
  const plan = buildStableGenerationPlan({ root, outputPath });
  const digest = planDigest(plan);
  const participantToken = createParticipantToken(plan);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const args = [options.generatorPath, '--root', root, '--out', outputPath, ...(options.generatorArgs ?? [])];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        NANOFLOW_CODEGRAPH_STABILITY_PARTICIPANT_TOKEN: participantToken,
        NANOFLOW_CODEGRAPH_STABILITY_PLAN_DIGEST: digest,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let captureError = null;
    const capture = (current, chunk, target) => {
      if (captureError) return current;
      if (Buffer.byteLength(current, 'utf8') + chunk.length > CONTRACT.limits.controlFileBytes) {
        captureError = new Error('codegraph-overlay-stability-output-limit');
        child.kill('SIGTERM');
        return current;
      }
      if (options.stdio === undefined || options.stdio === 'inherit') target.write(chunk);
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk, process.stdout); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk, process.stderr); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try {
        if (timedOut) throw new Error(`codegraph-overlay-stability-timeout: ${timeoutMs}ms`);
        if (captureError) throw captureError;
        if (code !== 0) {
          throw new Error(`codegraph-overlay-stability-generator-failed: code=${code} signal=${signal ?? 'none'}`);
        }
        const publication = parseGeneratorPublication(stdout);
        resolve({
          output: readPublishedOutput(root, publication),
          participantToken,
          planDigest: digest,
          publication,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    outputPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    generatorArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      parsed.root = requireValue(argv, ++index, arg);
    } else if (arg === '--out' || arg === '--output') {
      parsed.outputPath = requireValue(argv, ++index, arg);
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = positiveInteger(requireValue(argv, ++index, arg), 0);
      if (!parsed.timeoutMs) throw new Error('--timeout-ms must be a positive integer');
    } else if (arg === '--android-import-source' || arg === '--android-function-source') {
      parsed.generatorArgs.push(arg, requireValue(argv, ++index, arg));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  parsed.root = path.resolve(parsed.root);
  parsed.outputPath = path.resolve(parsed.outputPath ?? path.join(parsed.root, '.codegraph', 'nanoflow-overlay.json'));
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runStableGenerator({
    ...args,
    generatorPath: path.join(__dirname, 'generate-codegraph-nanoflow-overlay.mjs'),
  });
  process.stdout.write(`[codegraph-overlay-stability] ${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[codegraph-overlay-stability] ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildStableGenerationPlan,
  parseArgs,
  runStableGenerator,
};
