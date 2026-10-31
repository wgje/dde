#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MANIFEST = 'scripts/migration-dry-run-manifest.json';
const MIGRATION_DIR = 'supabase/migrations';
const RISK_PATTERNS = [
  {
    category: 'out-of-transaction',
    pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
    label: 'CREATE INDEX CONCURRENTLY',
  },
  {
    category: 'out-of-transaction',
    pattern: /\bREINDEX\s+(?:\w+\s+)?CONCURRENTLY\b/i,
    label: 'REINDEX CONCURRENTLY',
  },
  {
    category: 'out-of-transaction',
    pattern: /\bVACUUM\b/i,
    label: 'VACUUM',
  },
  {
    category: 'out-of-transaction',
    pattern: /\bALTER\s+SYSTEM\b/i,
    label: 'ALTER SYSTEM',
  },
  {
    category: 'out-of-transaction',
    pattern: /\b(?:CREATE|DROP)\s+(?:DATABASE|TABLESPACE)\b/i,
    label: 'database/tablespace DDL',
  },
  {
    category: 'explicit-transaction',
    pattern: /\bBEGIN\s*;/i,
    label: 'BEGIN',
  },
  {
    category: 'explicit-transaction',
    pattern: /\bCOMMIT\s*;+/i,
    label: 'COMMIT',
  },
  {
    category: 'explicit-transaction',
    pattern: /\bROLLBACK\s*;+/i,
    label: 'ROLLBACK',
  },
];

const CLI_INCOMPATIBLE_PATTERNS = [
  {
    pattern: /\bDROP\s+INDEX\s+CONCURRENTLY\b/i,
    message: 'DROP INDEX CONCURRENTLY is incompatible with Supabase CLI db push; use SET LOCAL lock_timeout with a regular DROP INDEX so lock contention fails fast and rolls back.',
  },
];

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    manifest: null,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = path.resolve(argv[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (arg === '--manifest') {
      options.manifest = path.resolve(argv[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.manifest) {
    options.manifest = path.join(options.root, DEFAULT_MANIFEST);
  }

  return options;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function relativePath(root, filePath) {
  return normalizePath(path.relative(root, filePath));
}

function pathIdentityKey(pathApi, filePath) {
  return pathApi.sep === '\\' ? filePath.toLowerCase() : filePath;
}

function isPathContained(pathApi, root, candidate) {
  const relative = pathApi.relative(root, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function collectMigrationFiles(root) {
  const dir = path.join(root, MIGRATION_DIR);
  let stats, canonicalRoot, canonicalDir;
  try {
    stats = fs.statSync(dir);
    canonicalRoot = fs.realpathSync(root);
    canonicalDir = fs.realpathSync(dir);
  } catch {
    throw new Error('migration-evidence-migrations-path-unavailable');
  }
  if (!stats.isDirectory()) {
    throw new Error('migration-evidence-migrations-path-not-directory');
  }
  if (!isPathContained(path, canonicalRoot, canonicalDir)) throw new Error('migration-evidence-migrations-path-canonical-escape');

  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map(entry => {
      const filePath = path.join(dir, entry.name);
      const readPath = fs.realpathSync(filePath);
      if (!isPathContained(path, canonicalDir, readPath)) throw new Error('migration-evidence-migration-path-canonical-escape');
      return { filePath, readPath };
    })
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  if (files.length === 0) {
    throw new Error('migration-evidence-migration-set-empty');
  }
  return { canonicalDir, files };
}

function loadManifest(manifestPath) {
  let stats, canonicalPath;
  try {
    canonicalPath = fs.realpathSync(manifestPath);
    stats = fs.statSync(canonicalPath);
  } catch {
    throw new Error('migration-evidence-manifest-path-unavailable');
  }
  if (!stats.isFile()) {
    throw new Error('migration-evidence-manifest-path-not-file');
  }

  // Realpath-before-read reduces static link escapes but is not race-free.
  const parsed = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error('migration dry-run manifest must contain an entries array');
  }

  return parsed;
}

function prepareManifest(root, canonicalDir, entries) {
  const byPath = new Map();
  const reverse = [];
  const errors = [];
  const seen = new Set();
  for (const entry of entries) {
    const raw = typeof entry?.path === 'string' ? entry.path : '';
    if (!raw) {
      errors.push('manifest entry must contain a path');
      continue;
    }
    const absolute = path.resolve(root, path.posix.normalize(raw.replace(/\\/g, '/')));
    const key = pathIdentityKey(path, relativePath(root, absolute));
    if (seen.has(key)) {
      errors.push(`${raw}: duplicate migration dry-run manifest entry`);
      continue;
    }
    seen.add(key);
    if (!isPathContained(path, path.join(root, MIGRATION_DIR), absolute)) {
      errors.push(`${raw}: manifest path must stay inside ${MIGRATION_DIR}`);
      continue;
    }
    let canonical;
    try { canonical = fs.realpathSync(absolute); } catch {
      reverse.push({ key, raw, stale: true });
      continue;
    }
    if (!isPathContained(path, canonicalDir, canonical)) {
      errors.push(`${raw}: manifest path canonical target must stay inside migration directory`);
      continue;
    }
    byPath.set(key, entry);
    reverse.push({ key, raw, stale: false });
  }
  return { byPath, errors, reverse };
}

function stripSqlCommentsAndStrings(source) {
  let output = '';
  let index = 0;
  let state = 'code';
  let dollarTag = null;

  while (index < source.length) {
    const char = source[index];
    const nextChar = source[index + 1] ?? '';

    if (state === 'line-comment') {
      output += char === '\n' ? '\n' : ' ';
      index += 1;
      if (char === '\n') state = 'code';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && nextChar === '/') {
        output += '  ';
        index += 2;
        state = 'code';
        continue;
      }
      output += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (state === 'single-quote') {
      if (char === "'" && nextChar === "'") {
        output += '  ';
        index += 2;
        continue;
      }
      output += char === '\n' ? '\n' : ' ';
      index += 1;
      if (char === "'") state = 'code';
      continue;
    }

    if (state === 'dollar-quote') {
      if (dollarTag && source.startsWith(dollarTag, index)) {
        output += ' '.repeat(dollarTag.length);
        index += dollarTag.length;
        state = 'code';
        dollarTag = null;
        continue;
      }
      output += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (char === '-' && nextChar === '-') {
      output += '  ';
      index += 2;
      state = 'line-comment';
      continue;
    }

    if (char === '/' && nextChar === '*') {
      output += '  ';
      index += 2;
      state = 'block-comment';
      continue;
    }

    if (char === "'") {
      output += ' ';
      index += 1;
      state = 'single-quote';
      continue;
    }

    if (char === '$') {
      const match = source.slice(index).match(/^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/);
      if (match) {
        dollarTag = match[0];
        output += ' '.repeat(dollarTag.length);
        index += dollarTag.length;
        state = 'dollar-quote';
        continue;
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

function classifyMigration(source) {
  const stripped = stripSqlCommentsAndStrings(source);
  const matches = [];

  for (const rule of RISK_PATTERNS) {
    if (rule.pattern.test(stripped)) {
      matches.push(rule);
    }
  }

  if (matches.length === 0) {
    return { category: 'transaction-safe', reasons: [] };
  }

  const explicit = matches.filter(match => match.category === 'explicit-transaction');
  if (explicit.length > 0) {
    return {
      category: 'explicit-transaction',
      reasons: explicit.map(match => match.label),
    };
  }

  return {
    category: 'out-of-transaction',
    reasons: matches.map(match => match.label),
  };
}

function validateCliCompatibility(source) {
  const stripped = stripSqlCommentsAndStrings(source);
  return CLI_INCOMPATIBLE_PATTERNS
    .filter(rule => rule.pattern.test(stripped))
    .map(rule => rule.message);
}

function validateManifestEntry(entry, expectedCategory) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return ['manifest entry must be an object'];
  }
  if (entry.category !== expectedCategory) {
    errors.push(`manifest category must be ${expectedCategory}`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
    errors.push('manifest reason is required');
  }
  if (typeof entry.rollbackStrategy !== 'string' || entry.rollbackStrategy.length === 0) {
    errors.push('manifest rollbackStrategy is required');
  }
  if (entry.requiresDataSafetyExport !== true) {
    errors.push('manifest requiresDataSafetyExport must be true');
  }
  return errors;
}

function buildPsqlPlan(transactionSafeFiles) {
  const lines = [
    '\\set ON_ERROR_STOP on',
    'BEGIN;',
    'SAVEPOINT nanoflow_migration_dry_run;',
    ...transactionSafeFiles.map(file => `\\i ${file}`),
    'ROLLBACK TO SAVEPOINT nanoflow_migration_dry_run;',
    'ROLLBACK;',
  ];
  return `${lines.join('\n')}\n`;
}

function validate(options) {
  const { canonicalDir, files: migrationFiles } = collectMigrationFiles(options.root);
  const manifestState = prepareManifest(options.root, canonicalDir, loadManifest(options.manifest).entries);
  const errors = [];
  const transactionDryRunFiles = [];
  const manualReview = [];
  const migrationByPath = new Map();

  for (const { filePath, readPath } of migrationFiles) {
    const relative = relativePath(options.root, filePath);
    const source = fs.readFileSync(readPath, 'utf8');
    const classification = classifyMigration(source);
    migrationByPath.set(pathIdentityKey(path, relative), classification);
    const compatibilityErrors = validateCliCompatibility(source);
    if (compatibilityErrors.length > 0) {
      errors.push(...compatibilityErrors.map(error => `${relative}: ${error}`));
      continue;
    }
    if (classification.category === 'transaction-safe') {
      transactionDryRunFiles.push(relative);
      continue;
    }

    const manifestEntry = manifestState.byPath.get(pathIdentityKey(path, relative));
    if (!manifestEntry) {
      errors.push(`${relative}: missing migration dry-run manifest entry for ${classification.category} (${classification.reasons.join(', ')})`);
      continue;
    }

    const entryErrors = validateManifestEntry(manifestEntry, classification.category);
    if (entryErrors.length > 0) {
      errors.push(...entryErrors.map(error => `${relative}: ${error}`));
      continue;
    }

    manualReview.push({
      path: relative,
      category: classification.category,
      reasons: classification.reasons,
      rollbackStrategy: manifestEntry.rollbackStrategy,
      requiresDataSafetyExport: true,
    });
  }
  errors.push(...manifestState.errors);
  for (const item of manifestState.reverse) {
    const classification = migrationByPath.get(item.key);
    if (item.stale || !classification) {
      errors.push(`${item.raw}: stale migration dry-run manifest entry`);
    } else if (classification.category === 'transaction-safe') {
      errors.push(`${item.raw}: transaction-safe migration must not have a dry-run manifest entry`);
    }
  }

  const report = {
    summary: {
      total: migrationFiles.length,
      transactionSafe: transactionDryRunFiles.length,
      outOfTransaction: manualReview.filter(item => item.category === 'out-of-transaction').length,
      explicitTransaction: manualReview.filter(item => item.category === 'explicit-transaction').length,
      requiresDataSafetyExport: manualReview.filter(item => item.requiresDataSafetyExport).length,
    },
    rollbackPlan: {
      transactionDryRunFiles,
      psql: buildPsqlPlan(transactionDryRunFiles),
    },
    manualReview,
  };

  return { errors, report };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { errors, report } = validate(options);

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[migration-dry-run] ${error}`);
      }
      process.exit(1);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`[migration-dry-run] checked ${report.summary.total} migrations; ${report.summary.transactionSafe} transaction-safe, ${report.summary.requiresDataSafetyExport} require data-safety export`);
    }
  } catch (error) {
    console.error(`[migration-dry-run] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyMigration,
  isPathContained,
  pathIdentityKey,
  stripSqlCommentsAndStrings,
  validate,
};
