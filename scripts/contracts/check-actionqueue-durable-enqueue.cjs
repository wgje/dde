#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function normalizePath(input) {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseRootArg() {
  const arg = process.argv.slice(2).find(item => item.startsWith('--root='));
  return arg ? path.resolve(arg.slice('--root='.length)) : process.cwd();
}

function parseFilesArg() {
  const arg = process.argv.slice(2).find(item => item.startsWith('--files='));
  if (!arg) return [];

  return arg
    .slice('--files='.length)
    .split(',')
    .map(item => normalizePath(item.trim()))
    .filter(Boolean);
}

function collectTypeScriptFiles(root, dir, result = []) {
  if (!fs.existsSync(dir)) return result;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) {
        continue;
      }
      collectTypeScriptFiles(root, absolutePath, result);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      continue;
    }

    result.push(normalizePath(path.relative(root, absolutePath)));
  }

  return result;
}

function isIgnoredPath(relativePath) {
  const rel = normalizePath(relativePath);
  const basename = path.posix.basename(rel);

  return (
    rel === 'src/services/action-queue.service.ts'
    || rel.startsWith('src/tests/')
    || rel.includes('/mocks/')
    || rel.includes('/stubs/')
    || rel.includes('/fixtures/')
    || basename.startsWith('test-setup')
    || /\.spec\.ts$/.test(basename)
    || /\.test\.ts$/.test(basename)
    || /\.spec-helpers\.ts$/.test(basename)
    || /\.test-helpers\.ts$/.test(basename)
    || /\.spec-context\.ts$/.test(basename)
  );
}

function maskNonCode(source) {
  let output = '';
  let state = 'code';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      output += char === '\n' ? '\n' : ' ';
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (
        (state === 'single-quote' && char === "'")
        || (state === 'double-quote' && char === '"')
        || (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (char === "'") {
      output += ' ';
      state = 'single-quote';
      continue;
    }
    if (char === '"') {
      output += ' ';
      state = 'double-quote';
      continue;
    }
    if (char === '`') {
      output += ' ';
      state = 'template';
      continue;
    }

    output += char;
  }

  return output;
}

function getLineColumn(source, index) {
  const before = source.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function findViolations(root, files) {
  const violations = [];

  for (const relativePath of files) {
    const rel = normalizePath(relativePath);
    if (!rel.startsWith('src/') || isIgnoredPath(rel)) {
      continue;
    }

    const absolutePath = path.join(root, rel);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const source = fs.readFileSync(absolutePath, 'utf8');
    const maskedSource = maskNonCode(source);
    const enqueueCallPattern = /\.\s*enqueue\s*\(/g;
    let match = enqueueCallPattern.exec(maskedSource);

    while (match) {
      const { line, column } = getLineColumn(source, match.index);
      const sourceLine = source.split(/\r?\n/)[line - 1]?.trim() ?? '';
      violations.push({
        file: rel,
        line,
        column,
        sourceLine,
      });
      match = enqueueCallPattern.exec(maskedSource);
    }
  }

  return violations;
}

function main() {
  const root = parseRootArg();
  const explicitFiles = parseFilesArg();
  const files = explicitFiles.length > 0
    ? explicitFiles
    : collectTypeScriptFiles(root, path.join(root, 'src'));

  const violations = findViolations(root, files);
  if (violations.length === 0) {
    console.log('[quality:guard:actionqueue-durable-enqueue] passed');
    process.exit(0);
  }

  console.error('[quality:guard:actionqueue-durable-enqueue] blocked because production code calls synchronous ActionQueueService.enqueue():');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}:${violation.column}`);
    console.error('  use enqueueDurably(), enqueueManyDurably(), or enqueueDurablyForOwner() so Outbox writes are durably persisted before UI continues.');
    console.error(`  source: ${violation.sourceLine}`);
  }
  console.error('Compatibility enqueue() is allowed only inside ActionQueueService and test/helper files.');
  process.exit(1);
}

main();
