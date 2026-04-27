#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set([
  '.angular',
  '.cache',
  '.git',
  '.tmp',
  '.worktrees',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp',
]);
const IGNORED_FILES = new Set([
  // Historical remote dump with known Supabase-generated policy parentheses.
  // New migrations and init-supabase.sql still go through this lightweight guard.
  'supabase/migrations/20260126074130_remote_commit.sql',
]);

function shouldIgnore(fullPath) {
  const relativePath = path.relative(PROJECT_ROOT, fullPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return true;
  }

  const normalizedRelativePath = relativePath.split(path.sep).join('/');
  return IGNORED_FILES.has(normalizedRelativePath)
    || relativePath.split(path.sep).some(segment => IGNORED_DIRS.has(segment));
}

function collectSqlFiles(dirPath, sqlFiles = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (shouldIgnore(fullPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      collectSqlFiles(fullPath, sqlFiles);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
      sqlFiles.push(fullPath);
    }
  }

  return sqlFiles.sort((left, right) => left.localeCompare(right));
}

function createIssue(filePath, line, column, message) {
  return { filePath, line, column, message };
}

function scanSqlFile(filePath, source) {
  const issues = [];
  const parenStack = [];
  const blockCommentStack = [];
  let line = 1;
  let column = 1;
  let index = 0;
  let state = 'code';
  let stringStart = null;
  let dollarTag = null;
  let dollarStart = null;

  function advanceChar(char) {
    index += 1;
    if (char === '\n') {
      line += 1;
      column = 1;
      return;
    }

    column += 1;
  }

  function advanceText(text) {
    for (const char of text) {
      advanceChar(char);
    }
  }

  while (index < source.length) {
    const char = source[index];
    const nextChar = source[index + 1] ?? '';

    if (state === 'line-comment') {
      advanceChar(char);
      if (char === '\n') {
        state = 'code';
      }
      continue;
    }

    if (state === 'single-quote') {
      if (char === "'" && nextChar === "'") {
        advanceText("''");
        continue;
      }

      advanceChar(char);
      if (char === "'") {
        state = 'code';
        stringStart = null;
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && nextChar === '*') {
        blockCommentStack.push({ line, column });
        advanceText('/*');
        continue;
      }

      if (char === '*' && nextChar === '/') {
        blockCommentStack.pop();
        advanceText('*/');
        if (blockCommentStack.length === 0) {
          state = 'code';
        }
        continue;
      }

      advanceChar(char);
      continue;
    }

    if (state === 'dollar-quote') {
      if (dollarTag && source.startsWith(dollarTag, index)) {
        advanceText(dollarTag);
        state = 'code';
        dollarTag = null;
        dollarStart = null;
        continue;
      }

      advanceChar(char);
      continue;
    }

    if (char === '-' && nextChar === '-') {
      advanceText('--');
      state = 'line-comment';
      continue;
    }

    if (char === '/' && nextChar === '*') {
      blockCommentStack.push({ line, column });
      advanceText('/*');
      state = 'block-comment';
      continue;
    }

    if (char === "'") {
      stringStart = { line, column };
      advanceChar(char);
      state = 'single-quote';
      continue;
    }

    if (char === '$') {
      const match = source.slice(index).match(/^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/);
      if (match) {
        dollarTag = match[0];
        dollarStart = { line, column };
        advanceText(dollarTag);
        state = 'dollar-quote';
        continue;
      }
    }

    if (char === '(') {
      parenStack.push({ line, column });
      advanceChar(char);
      continue;
    }

    if (char === ')') {
      if (parenStack.length === 0) {
        issues.push(createIssue(filePath, line, column, 'Unmatched closing parenthesis'));
      } else {
        parenStack.pop();
      }
      advanceChar(char);
      continue;
    }

    advanceChar(char);
  }

  if (state === 'single-quote' && stringStart) {
    issues.push(createIssue(filePath, stringStart.line, stringStart.column, 'Unclosed single-quoted string'));
  }

  if (state === 'dollar-quote' && dollarStart && dollarTag) {
    issues.push(createIssue(filePath, dollarStart.line, dollarStart.column, `Unclosed dollar-quoted block ${dollarTag}`));
  }

  if (blockCommentStack.length > 0) {
    const unclosedComment = blockCommentStack[blockCommentStack.length - 1];
    issues.push(createIssue(filePath, unclosedComment.line, unclosedComment.column, 'Unclosed block comment'));
  }

  for (const paren of parenStack.slice(0, 20)) {
    issues.push(createIssue(filePath, paren.line, paren.column, 'Unclosed opening parenthesis'));
  }

  if (parenStack.length > 20) {
    const firstSuppressed = parenStack[20];
    issues.push(createIssue(filePath, firstSuppressed.line, firstSuppressed.column, `Suppressed ${parenStack.length - 20} additional unmatched opening parentheses`));
  }

  return issues;
}

function main() {
  const sqlFiles = collectSqlFiles(PROJECT_ROOT);
  const issues = [];

  for (const filePath of sqlFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    issues.push(...scanSqlFile(filePath, source));
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.log(`${issue.filePath}:${issue.line}:${issue.column}: error: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`[validate-sql-structure] checked ${sqlFiles.length} files`);
}

main();
