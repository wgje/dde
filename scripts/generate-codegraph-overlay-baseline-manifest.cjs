#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildBaseline } = require('./lib/codegraph-overlay-baseline.cjs');
const { counterContract } = require('./lib/codegraph-overlay-contract-manifest.cjs');
const {
  readOverlayCurrentReceipt,
} = require('./lib/codegraph-overlay-current-receipt.cjs');

const DEFAULT_OUTPUT_PATH = path.join('.codegraph', 'nanoflow-overlay-baseline-manifest.json');

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    output: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      parsed.root = path.resolve(requireValue(argv, ++index, '--root'));
      continue;
    }
    if (arg === '--output') {
      parsed.output = requireValue(argv, ++index, '--output');
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function toPosix(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

function normalizePathIdentity(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsReferToSameFile(leftPath, rightPath) {
  if (normalizePathIdentity(leftPath) === normalizePathIdentity(rightPath)) return true;
  if (!fs.existsSync(rightPath)) return false;
  const left = fs.statSync(leftPath, { bigint: true });
  const right = fs.statSync(rightPath, { bigint: true });
  return left.dev === right.dev && left.ino === right.ino;
}

function buildManifest(root) {
  const currentReceipt = readOverlayCurrentReceipt(root);
  if (!currentReceipt.ok) {
    throw new Error(`baseline-current-receipt-${currentReceipt.errorCode.toLowerCase().replaceAll('_', '-')}`);
  }
  const overlayPath = path.join(
    root,
    '.codegraph',
    'nanoflow-generations',
    currentReceipt.current.generationId,
    ...currentReceipt.manifest.compatibility.path.split('/'),
  );
  const baseline = buildBaseline(currentReceipt.overlay);
  const counters = Object.fromEntries(
    Object.entries(baseline).map(([name, value]) => [
      name,
      {
        value,
        ...counterContract(name, value),
      },
    ]),
  );

  return {
    overlayPath,
    manifest: {
      schemaVersion: 1,
      generatedFrom: toPosix(path.relative(root, overlayPath)),
      counters,
    },
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { manifest, overlayPath } = buildManifest(args.root);
    const outputPath = path.resolve(args.root, args.output);
    if (pathsReferToSameFile(overlayPath, outputPath)) throw new Error('baseline-output-collides-overlay');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      output: toPosix(path.relative(args.root, outputPath)),
      counterCount: Object.keys(manifest.counters).length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
