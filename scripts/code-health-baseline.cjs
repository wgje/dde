#!/usr/bin/env node

const { execSync } = require('node:child_process');
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const ROOT = process.cwd();
const SOURCE_ROOTS = ['src'];
const EXTENSIONS = new Set(['.ts', '.html', '.scss', '.css']);
const DEFAULT_LIMIT = 25;
const ESLINT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.angular',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const GENERATED_LINE_COUNT_EXCLUSIONS = new Set([
  'src/types/supabase.ts',
]);

function parseLimit() {
  const arg = process.argv.find(value => value.startsWith('--limit='));
  if (!arg) return DEFAULT_LIMIT;

  const value = Number(arg.slice('--limit='.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LIMIT;
}

function parseNumericOption(name) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  if (!arg) return null;

  const value = Number(arg.slice(name.length + 3));
  return Number.isFinite(value) ? value : null;
}

function walkFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        walkFiles(fullPath, files);
      }
      continue;
    }

    if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function countLines(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (content.length === 0) return 0;

  return content.split(/\r\n|\r|\n/).length;
}

function collectFiles() {
  return SOURCE_ROOTS
    .map(root => path.join(ROOT, root))
    .filter(sourceRoot => existsSync(sourceRoot))
    .flatMap(sourceRoot => walkFiles(sourceRoot))
    .map(filePath => {
      const relativePath = path.relative(ROOT, filePath).replaceAll(path.sep, '/');
      return {
        path: relativePath,
        lines: countLines(filePath),
        bytes: statSync(filePath).size,
      };
    })
    .filter(file => !GENERATED_LINE_COUNT_EXCLUSIONS.has(file.path))
    .sort((left, right) => right.lines - left.lines);
}

function summarizeLintReports(reports) {
  return reports.reduce(
    (summary, report) => ({
      files: summary.files + 1,
      errors: summary.errors + report.errorCount,
      warnings: summary.warnings + report.warningCount,
      fixableErrors: summary.fixableErrors + report.fixableErrorCount,
      fixableWarnings: summary.fixableWarnings + report.fixableWarningCount,
    }),
    {
      files: 0,
      errors: 0,
      warnings: 0,
      fixableErrors: 0,
      fixableWarnings: 0,
    },
  );
}

function parseLintStdout(stdout) {
  const text = stdout.trim();
  if (!text) {
    return {
      files: 0,
      errors: -1,
      warnings: -1,
      fixableErrors: 0,
      fixableWarnings: 0,
    };
  }

  return summarizeLintReports(JSON.parse(text));
}

function collectLintSummary() {
  try {
    const output = execSync('npx eslint src --format json --no-warn-ignored', {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: ESLINT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return parseLintStdout(output);
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error
      ? String(error.stdout)
      : '';

    return parseLintStdout(stdout);
  }
}

const limit = parseLimit();
const files = collectFiles();
const lint = collectLintSummary();

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    files: files.length,
    over800: files.filter(file => file.lines > 800).length,
    over1500: files.filter(file => file.lines > 1500).length,
  },
  lint,
  largestFiles: files.slice(0, limit),
};

console.log(JSON.stringify(report, null, 2));

const maxWarnings = parseNumericOption('max-warnings');
const maxOver800 = parseNumericOption('max-over800');
const maxOver1500 = parseNumericOption('max-over1500');

function applyCeiling(label, currentValue, maxValue) {
  if (maxValue === null || currentValue <= maxValue) {
    return;
  }

  console.error(`Code health ${label} ceiling exceeded: ${currentValue} > ${maxValue}`);
  process.exitCode = 1;
}

if (report.lint.errors > 0) {
  console.error(`Code health lint errors found: ${report.lint.errors}`);
  process.exitCode = 1;
}
if (report.lint.errors < 0 || report.lint.warnings < 0) {
  console.error('Code health lint summary unavailable; ESLint did not produce a parseable JSON report');
  process.exitCode = 1;
}
if (maxWarnings !== null && report.lint.warnings > maxWarnings) {
  console.error(`Code health warning ceiling exceeded: ${report.lint.warnings} > ${maxWarnings}`);
  process.exitCode = 1;
}
applyCeiling('over800', report.totals.over800, maxOver800);
applyCeiling('over1500', report.totals.over1500, maxOver1500);
