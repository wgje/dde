#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, 'src');
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const testFilePattern = /\.(spec|test)\.ts$/;
const testBedPattern = /\bTestBed\b/;

const MAX_LIST_PREVIEW = 30;

const toPosix = (value) => value.split(path.sep).join('/');

function collectTestFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (entry.isFile() && testFilePattern.test(entry.name)) {
        files.push(toPosix(path.relative(projectRoot, absolutePath)));
      }
    }
  }

  files.sort();
  return files;
}

function classifyBuckets(testFiles) {
  const minimalFiles = [];
  const testBedFiles = [];

  for (const relativeFile of testFiles) {
    const absoluteFile = path.join(projectRoot, relativeFile);
    const content = fs.readFileSync(absoluteFile, 'utf8');
    if (testBedPattern.test(content)) {
      testBedFiles.push(relativeFile);
    } else {
      minimalFiles.push(relativeFile);
    }
  }

  return { minimalFiles, testBedFiles };
}

function summarizeList(list) {
  if (list.length <= MAX_LIST_PREVIEW) {
    return list.join('\n');
  }
  const preview = list.slice(0, MAX_LIST_PREVIEW).join('\n');
  return `${preview}\n... (+${list.length - MAX_LIST_PREVIEW} more)`;
}

function validateCoverage(allFiles, minimalFiles, testBedFiles) {
  const allSet = new Set(allFiles);
  const minimalSet = new Set(minimalFiles);
  const testBedSet = new Set(testBedFiles);

  const overlap = minimalFiles.filter((file) => testBedSet.has(file));
  if (overlap.length > 0) {
    throw new Error(
      [
        'Bucket overlap detected between minimal and testbed files:',
        summarizeList(overlap),
      ].join('\n')
    );
  }

  const unionSet = new Set([...minimalSet, ...testBedSet]);
  const missing = allFiles.filter((file) => !unionSet.has(file));
  const extra = [...unionSet].filter((file) => !allSet.has(file));

  if (missing.length > 0 || extra.length > 0) {
    const lines = ['Bucket coverage validation failed.'];
    if (missing.length > 0) {
      lines.push(`Missing files (${missing.length}):`);
      lines.push(summarizeList(missing));
    }
    if (extra.length > 0) {
      lines.push(`Unexpected files (${extra.length}):`);
      lines.push(summarizeList(extra));
    }
    throw new Error(lines.join('\n'));
  }
}

function parseArgs(argv) {
  let bucket = 'all';
  let parallel = true;
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (arg === '--no-parallel') {
      parallel = false;
      continue;
    }

    if (arg === '--parallel') {
      parallel = true;
      continue;
    }

    if (arg.startsWith('--bucket=')) {
      bucket = arg.slice('--bucket='.length);
      continue;
    }

    if (arg === '--bucket') {
      bucket = argv[i + 1];
      i += 1;
      continue;
    }

    passthrough.push(arg);
  }

  if (!['all', 'minimal', 'testbed'].includes(bucket)) {
    throw new Error(`Invalid --bucket value: ${bucket}. Use all|minimal|testbed.`);
  }

  return { bucket, parallel, passthrough };
}

function spawnVitest(commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(npxBin, commandArgs, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });

    child.on('error', () => resolve(1));
  });
}

function buildVitestArgs(bucket, files, passthrough) {
  const args = ['vitest', 'run'];
  if (bucket === 'minimal') {
    args.push('--config', 'vitest.minimal.config.mts');
  }

  // 默认开启文件隔离，避免单 worker 分桶运行时的跨文件状态污染。
  // 若调用方显式传入 --no-isolate，则尊重调用方参数。
  const hasIsolateFlag = passthrough.some((arg) => (
    arg === '--isolate'
    || arg === '--no-isolate'
    || arg.startsWith('--isolate=')
  ));
  if (!hasIsolateFlag) {
    args.push('--isolate');
  }

  args.push('--maxWorkers=1');
  args.push(...passthrough);
  args.push(...files);
  return args;
}

async function runBucket(bucket, files, passthrough) {
  if (files.length === 0) {
    console.log(`[test:run] ${bucket} bucket is empty, skipping.`);
    return 0;
  }

  console.log(`[test:run] start ${bucket} bucket: ${files.length} files`);
  const args = buildVitestArgs(bucket, files, passthrough);
  const exitCode = await spawnVitest(args);
  console.log(`[test:run] finish ${bucket} bucket: exit=${exitCode}`);
  return exitCode;
}

async function main() {
  const { bucket, parallel, passthrough } = parseArgs(process.argv.slice(2));
  const allFiles = collectTestFiles(srcRoot);
  const { minimalFiles, testBedFiles } = classifyBuckets(allFiles);

  validateCoverage(allFiles, minimalFiles, testBedFiles);

  console.log(
    `[test:run] discovered ${allFiles.length} files (minimal=${minimalFiles.length}, testbed=${testBedFiles.length})`
  );

  if (bucket === 'minimal') {
    const code = await runBucket('minimal', minimalFiles, passthrough);
    process.exit(code);
  }

  if (bucket === 'testbed') {
    const code = await runBucket('testbed', testBedFiles, passthrough);
    process.exit(code);
  }

  let minimalExit = 0;
  let testBedExit = 0;

  if (parallel) {
    [minimalExit, testBedExit] = await Promise.all([
      runBucket('minimal', minimalFiles, passthrough),
      runBucket('testbed', testBedFiles, passthrough),
    ]);
  } else {
    minimalExit = await runBucket('minimal', minimalFiles, passthrough);
    testBedExit = await runBucket('testbed', testBedFiles, passthrough);
  }

  if (minimalExit !== 0 || testBedExit !== 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[test:run] failed: ${message}`);
  process.exit(1);
});
