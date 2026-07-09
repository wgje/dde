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

function collectMigrationFiles(root) {
  const dir = path.join(root, MIGRATION_DIR);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map(entry => path.join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return { schemaVersion: 1, entries: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error('migration dry-run manifest must contain an entries array');
  }

  return parsed;
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
  const migrationFiles = collectMigrationFiles(options.root);
  const manifest = loadManifest(options.manifest);
  const manifestByPath = new Map(manifest.entries.map(entry => [normalizePath(entry.path ?? ''), entry]));
  const errors = [];
  const transactionDryRunFiles = [];
  const manualReview = [];

  for (const filePath of migrationFiles) {
    const relative = relativePath(options.root, filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const classification = classifyMigration(source);

    if (classification.category === 'transaction-safe') {
      transactionDryRunFiles.push(relative);
      continue;
    }

    const manifestEntry = manifestByPath.get(relative);
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
  stripSqlCommentsAndStrings,
  validate,
};
