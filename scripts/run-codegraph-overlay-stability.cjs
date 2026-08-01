#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  createParticipantToken,
  fileEvidence,
  planDigest,
} = require('./lib/codegraph-overlay-stability.cjs');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

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
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    });
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
      if (timedOut) {
        reject(new Error(`codegraph-overlay-stability-timeout: ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`codegraph-overlay-stability-generator-failed: code=${code} signal=${signal ?? 'none'}`));
        return;
      }
      resolve({
        output: fileEvidence(outputPath),
        participantToken,
        planDigest: digest,
      });
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
