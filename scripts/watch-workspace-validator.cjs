#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set([
  '.angular',
  '.cache',
  '.git',
  '.tmp',
  '.worktrees',
  'build',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp',
]);

const MODES = {
  sql: {
    label: 'validate-sql-watch',
    extensions: new Set(['.sql']),
    command: process.execPath,
    args: [path.join('scripts', 'validate-sql-structure.cjs')],
  },
  xml: {
    label: 'validate-xml-watch',
    extensions: new Set(['.xml']),
    command: 'pwsh',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join('scripts', 'validate-xml-wellformed.ps1'),
    ],
  },
};

const mode = MODES[process.argv[2] ?? ''];

if (!mode) {
  console.error('Usage: node scripts/watch-workspace-validator.cjs <sql|xml>');
  process.exit(1);
}

let running = false;
let pending = false;
let debounceHandle = null;

function isIgnoredPath(relativePath) {
  return relativePath.split(path.sep).some(segment => IGNORED_DIRS.has(segment));
}

function isRelevantPath(filename) {
  if (!filename) {
    return false;
  }

  const normalizedPath = filename.replace(/\//g, path.sep);
  const relativePath = path.isAbsolute(normalizedPath)
    ? path.relative(PROJECT_ROOT, normalizedPath)
    : normalizedPath;

  if (!relativePath || relativePath.startsWith('..') || isIgnoredPath(relativePath)) {
    return false;
  }

  return mode.extensions.has(path.extname(relativePath).toLowerCase());
}

function writeMarker(suffix) {
  process.stdout.write(`[${mode.label}] ${suffix}\n`);
}

function runValidation() {
  if (running) {
    pending = true;
    return;
  }

  running = true;
  pending = false;
  writeMarker('cycle start');

  const child = spawn(mode.command, mode.args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
  });

  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
  });

  child.on('exit', code => {
    if (code !== 0) {
      process.stdout.write(`[${mode.label}] validator exited with code ${code}\n`);
    }

    writeMarker('cycle end');
    running = false;

    if (pending) {
      runValidation();
    }
  });
}

function scheduleValidation() {
  if (debounceHandle) {
    clearTimeout(debounceHandle);
  }

  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    runValidation();
  }, 250);
}

let watcher;

try {
  watcher = fs.watch(PROJECT_ROOT, { recursive: true }, (_eventType, filename) => {
    if (isRelevantPath(filename)) {
      scheduleValidation();
    }
  });
} catch (error) {
  console.error(`[${mode.label}] failed to start watcher: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

watcher.on('error', error => {
  console.error(`[${mode.label}] watcher error: ${error instanceof Error ? error.message : String(error)}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (debounceHandle) {
      clearTimeout(debounceHandle);
    }
    watcher.close();
    process.exit(0);
  });
}

runValidation();
process.stdout.write(`[${mode.label}] watching for changes\n`);
