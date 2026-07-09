#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildBaseline } = require('./lib/codegraph-overlay-baseline.cjs');
const { counterContract } = require('./lib/codegraph-overlay-contract-manifest.cjs');

const DEFAULT_OVERLAY_PATH = path.join('.codegraph', 'nanoflow-overlay.json');
const DEFAULT_OUTPUT_PATH = path.join('.codegraph', 'nanoflow-overlay-baseline-manifest.json');

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    overlay: DEFAULT_OVERLAY_PATH,
    output: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      parsed.root = path.resolve(requireValue(argv, ++index, '--root'));
      continue;
    }
    if (arg === '--overlay') {
      parsed.overlay = requireValue(argv, ++index, '--overlay');
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

function buildManifest(root, overlayRelativePath) {
  const overlayPath = path.resolve(root, overlayRelativePath);
  const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
  const baseline = buildBaseline(overlay);
  const counters = Object.fromEntries(
    Object.entries(baseline).map(([name, value]) => [
      name,
      {
        value,
        ...counterContract(name),
      },
    ]),
  );

  return {
    schemaVersion: 1,
    generatedFrom: toPosix(path.relative(root, overlayPath)),
    counters,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = buildManifest(args.root, args.overlay);
    const outputPath = path.resolve(args.root, args.output);
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
