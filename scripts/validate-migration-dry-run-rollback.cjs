#!/usr/bin/env node

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MANIFEST = 'scripts/migration-dry-run-manifest.json';
const DEFAULT_ALIAS_MANIFEST = 'scripts/migration-version-alias-manifest.json';
const DEFAULT_LEDGER_SNAPSHOT = 'scripts/migration-ledger-snapshot.json';
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

function readGitHead(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function gitIsAncestor(root, ancestorSha, descendantSha) {
  const result = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestorSha, descendantSha]);
  return result.status === 0;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    manifest: null,
    aliasManifest: null,
    ledgerSnapshot: null,
    now: null,
    currentTargetSha: null,
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
    if (arg === '--alias-manifest') { options.aliasManifest = path.resolve(argv[index + 1] ?? ''); index += 1; continue; }
    if (arg === '--ledger-snapshot') { options.ledgerSnapshot = path.resolve(argv[index + 1] ?? ''); index += 1; continue; }
    if (arg === '--now') { options.now = argv[index + 1] ?? ''; index += 1; continue; }
    if (arg === '--current-target-sha') { options.currentTargetSha = argv[index + 1] ?? ''; index += 1; continue; }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.manifest) options.manifest = path.join(options.root, DEFAULT_MANIFEST);
  if (!options.aliasManifest) options.aliasManifest = path.join(options.root, DEFAULT_ALIAS_MANIFEST);
  if (!options.ledgerSnapshot) options.ledgerSnapshot = path.join(options.root, DEFAULT_LEDGER_SNAPSHOT);
  if (!options.now) options.now = new Date().toISOString();
  if (!options.currentTargetSha) options.currentTargetSha = readGitHead(options.root);

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

function loadJsonFile(filePath, unavailableCode, invalidCode) {
  let canonicalPath, stats;
  try {
    canonicalPath = fs.realpathSync(filePath);
    stats = fs.statSync(canonicalPath);
  } catch {
    throw new Error(unavailableCode);
  }
  if (!stats.isFile()) throw new Error(unavailableCode);
  try {
    return JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  } catch {
    throw new Error(invalidCode);
  }
}

function loadLedgerSnapshot(snapshotPath, root, expectedProjectRef = null, currentTargetSha = null, nowUtc = null) {
  const parsed = loadJsonFile(
    snapshotPath,
    'migration-ledger-snapshot-path-unavailable',
    'migration-ledger-snapshot-invalid-json',
  );
  if (!parsed || parsed.format !== 'SUPABASE_SCHEMA_MIGRATIONS_V1'
    || parsed.source !== 'mcp__supabase.execute_sql'
    || !/^[A-Z0-9]{64}$/i.test(String(parsed.canonicalRowsSha256 || ''))
    || !/^[a-z0-9]{20}$/.test(String(parsed.projectRef || ''))
    || !/^[a-f0-9]{40}$/i.test(String(parsed.sourceGitSha || ''))
    || !/^[a-f0-9]{40}$/i.test(String(parsed.expectedGitSha || ''))
    || parsed.expectedGitSha.toLowerCase() !== parsed.sourceGitSha.toLowerCase()
    || !Array.isArray(parsed.rows)
    || parsed.rowCount !== parsed.rows.length
    || (!parsed.sourceEvidence || parsed.sourceEvidence.tool !== 'mcp__supabase.execute_sql'
      || !['queryId','query','resultRowCount'].every(key => parsed.sourceEvidence[key] !== undefined)
      || !Number.isInteger(parsed.maxAgeSeconds) || parsed.maxAgeSeconds <= 0
      || !Number.isFinite(Date.parse(parsed.capturedAtUtc)))) {
    throw new Error('migration-ledger-snapshot-schema-invalid');
  }
  if (expectedProjectRef && parsed.projectRef !== expectedProjectRef) throw new Error('migration-ledger-snapshot-project-mismatch');
  if (currentTargetSha && !gitIsAncestor(root, parsed.sourceGitSha.toLowerCase(), currentTargetSha.toLowerCase())) throw new Error('migration-ledger-snapshot-source-not-ancestor');
  const nowMs = Date.parse(String(nowUtc || ''));
  const capturedMs = Date.parse(String(parsed.capturedAtUtc || ''));
  if (!Number.isFinite(nowMs)) throw new Error('migration-ledger-snapshot-current-time-invalid');
  if (!Number.isFinite(capturedMs)) throw new Error('migration-ledger-snapshot-captured-at-invalid');
  if (capturedMs > nowMs) throw new Error('migration-ledger-snapshot-captured-in-future');
  if (nowMs - capturedMs > parsed.maxAgeSeconds * 1000) throw new Error('migration-ledger-snapshot-stale');
  if (parsed.sourceEvidence.resultRowCount !== parsed.rows.length) throw new Error('migration-ledger-snapshot-capture-evidence-mismatch');
  return parsed;
}

function canonicalRowsSha256(rows) {
  const ordered = [...rows].sort((a, b) => String(a.version).localeCompare(String(b.version))
    || String(a.name).localeCompare(String(b.name)));
  return crypto.createHash('sha256')
    .update(JSON.stringify(ordered)).digest('hex').toUpperCase();
}

function validateAliasLedger(root, canonicalDir, aliasManifestPath, ledgerSnapshotPath, migrationFiles, freshness = {}) {
  const errors = [];
  const aliasManifest = loadJsonFile(
    aliasManifestPath,
    'migration-version-alias-manifest-path-unavailable',
    'migration-version-alias-manifest-invalid-json',
  );
  const ledger = loadLedgerSnapshot(ledgerSnapshotPath, root, freshness.projectRef, freshness.currentTargetSha, freshness.nowUtc);
  if (canonicalRowsSha256(ledger.rows) !== String(ledger.canonicalRowsSha256).toUpperCase()) {
    errors.push('migration-ledger-snapshot-rows-sha-mismatch');
  }
  const ledgerPairs = new Map();
  const ledgerVersions = new Map();
  for (const row of ledger.rows) {
    if (!row || !/^[0-9]{14}$/.test(String(row.version || ''))
      || typeof row.name !== 'string' || row.name.length === 0) {
      errors.push('migration-ledger-snapshot-row-invalid');
      continue;
    }
    if (ledgerVersions.has(row.version)) errors.push(`migration-ledger-snapshot-duplicate-version:${row.version}`);
    ledgerVersions.set(row.version, row.name);
    ledgerPairs.set(`${row.version}:${row.name}`, row);
  }
  if (!aliasManifest || aliasManifest.schemaVersion !== 2
    || aliasManifest.format !== 'MIGRATION_VERSION_ALIASES_V1'
    || aliasManifest.ledgerSnapshotPath !== DEFAULT_LEDGER_SNAPSHOT
    || !Array.isArray(aliasManifest.aliases)) {
    return { errors: errors.concat('migration-version-alias-manifest-schema-invalid'), bySource: new Map(), ledger };
  }
  const knownSourcePath = 'supabase/migrations/20261121060000_widget_focus_action_durable_receipt.sql';
  const knownMigrationPresent = migrationFiles.some(item => relativePath(root, item.filePath) === knownSourcePath);
  const knownSource = aliasManifest.aliases.find(entry => entry && entry.sourcePath === knownSourcePath);
  if (knownMigrationPresent && !knownSource) {
    errors.push('migration-version-alias-known-source-missing');
  } else if (knownMigrationPresent) {
    const aliases = Array.isArray(knownSource.appliedAliases) ? knownSource.appliedAliases : [];
    const exact = aliases.length === 2
      && aliases.some(alias => alias.version === '20261122053816' && alias.name === 'widget_focus_action_durable_receipt')
      && aliases.some(alias => alias.version === '20261122053936' && alias.name === 'widget_focus_action_durable_receipt_exact_repair');
    if (!exact) errors.push('migration-version-alias-known-chain-invalid');
  }
  const migrationByRelative = new Map(migrationFiles.map(item => [
    pathIdentityKey(path, relativePath(root, item.filePath)), item,
  ]));
  const bySource = new Map();
  const globalAliasVersions = new Map();
  const globalAliasNames = new Map();
  const declaredPairs = new Map();
  const sourceVersions = [];
  for (const alias of aliasManifest.aliases) {
    const sourcePath = typeof alias?.sourcePath === 'string'
      ? path.posix.normalize(alias.sourcePath.replace(/\\/g, '/')) : '';
    const sourceVersion = typeof alias?.sourceVersion === 'string' ? alias.sourceVersion : '';
    const sourceName = typeof alias?.sourceName === 'string' ? alias.sourceName : '';
    const sourceSha256 = typeof alias?.sourceSha256 === 'string' ? alias.sourceSha256.toUpperCase() : '';
    const appliedAliases = alias?.appliedAliases;
    if (!sourcePath || !/^[0-9]{14}$/.test(sourceVersion) || !sourceName
      || !/^[A-F0-9]{64}$/.test(sourceSha256)
      || !Array.isArray(appliedAliases) || appliedAliases.length === 0) {
      errors.push('migration-version-alias-entry-invalid');
      continue;
    }
    const key = pathIdentityKey(path, sourcePath);
    if (bySource.has(key)) {
      errors.push(`${sourcePath}: duplicate migration-version-alias source`);
      continue;
    }
    bySource.set(key, alias);
    sourceVersions.push(sourceVersion);
    const migration = migrationByRelative.get(key);
    if (!migration) { errors.push(`${sourcePath}: migration-version-alias source missing`); continue; }
    const absolute = path.resolve(root, sourcePath);
    if (!isPathContained(path, path.join(root, MIGRATION_DIR), absolute)) {
      errors.push(`${sourcePath}: migration-version-alias source must stay inside ${MIGRATION_DIR}`); continue;
    }
    if (!path.basename(sourcePath).startsWith(`${sourceVersion}_`)) {
      errors.push(`${sourcePath}: migration-version-alias source version does not match filename`);
    }
    let canonical;
    try { canonical = fs.realpathSync(absolute); } catch { errors.push(`${sourcePath}: migration-version-alias source unavailable`); continue; }
    if (!isPathContained(path, canonicalDir, canonical)) {
      errors.push(`${sourcePath}: migration-version-alias source canonical target must stay inside migration directory`); continue;
    }
    if (sha256File(canonical) !== sourceSha256) {
      errors.push(`${sourcePath}: migration-version-alias source SHA mismatch`);
    }
    const sourcePair = `${sourceVersion}:${sourceName}`;
    if (!ledgerPairs.has(sourcePair)) errors.push(`${sourcePath}: ledger source row missing or name mismatch`);
    declaredPairs.set(sourcePair, 'source');
    for (const applied of appliedAliases) {
      const version = typeof applied?.version === 'string' ? applied.version : '';
      const name = typeof applied?.name === 'string' ? applied.name : '';
      if (!/^[0-9]{14}$/.test(version) || !name) {
        errors.push(`${sourcePath}: invalid applied migration-version-alias`); continue;
      }
      const pair = `${version}:${name}`;
      if (!ledgerPairs.has(pair)) errors.push(`${sourcePath}: ledger alias missing or name mismatch ${version}`);
      if (globalAliasVersions.has(version)) errors.push(`${sourcePath}: migration-version-alias version belongs to multiple sources ${version}`);
      if (globalAliasNames.has(name)) errors.push(`${sourcePath}: migration-version-alias name belongs to multiple sources ${name}`);
      globalAliasVersions.set(version, sourcePath);
      globalAliasNames.set(name, sourcePath);
      declaredPairs.set(pair, 'alias');
    }
  }
  for (const pair of declaredPairs.keys()) {
    if (!ledgerPairs.has(pair)) errors.push(`migration-ledger-snapshot-missing-declared-row:${pair}`);
  }
  if (sourceVersions.length > 0) {
    const aliasChainFloor = sourceVersions.reduce((min, version) => min < version ? min : version);
    const ledgerAliasChain = new Set(ledger.rows
      .filter(row => row.version >= aliasChainFloor)
      .map(row => `${row.version}:${row.name}`));
    for (const pair of ledgerAliasChain) {
      if (!declaredPairs.has(pair)) errors.push(`migration-ledger-snapshot-unexpected-alias-chain-row:${pair}`);
    }
    for (const pair of declaredPairs.keys()) {
      if (!ledgerAliasChain.has(pair)) errors.push(`migration-ledger-snapshot-missing-alias-chain-row:${pair}`);
    }
  }
  return { errors, bySource, ledger };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
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
  const aliasManifest = loadJsonFile(options.aliasManifest, 'migration-version-alias-manifest-path-unavailable', 'migration-version-alias-manifest-invalid-json');
  const expectedProjectRef = String(aliasManifest.expectedProjectRef || '').trim();
  if (!/^[a-z0-9]{20}$/.test(expectedProjectRef)) throw new Error('migration-version-alias-manifest-project-ref-invalid');
  const aliasState = validateAliasLedger(options.root, canonicalDir, options.aliasManifest, options.ledgerSnapshot, migrationFiles, { projectRef: expectedProjectRef, currentTargetSha: options.currentTargetSha, nowUtc: options.now });
  const errors = [...aliasState.errors];
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
    aliases: [...aliasState.bySource.values()],
    ledgerSnapshot: { rowCount: aliasState.ledger.rowCount, projectRef: aliasState.ledger.projectRef, sourceGitSha: aliasState.ledger.sourceGitSha, canonicalRowsSha256: aliasState.ledger.canonicalRowsSha256 },
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
  canonicalRowsSha256,
  loadLedgerSnapshot,
  sha256File,
  validateAliasLedger,
  isPathContained,
  pathIdentityKey,
  stripSqlCommentsAndStrings,
  validate,
};
