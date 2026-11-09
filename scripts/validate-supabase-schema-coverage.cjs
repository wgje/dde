#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  analyzeRepositorySchemaCoverage,
} = require('./lib/supabase-schema-coverage.cjs');
const {
  analyzeRepositoryRpcFunctionCoverage,
} = require('./lib/supabase-rpc-function-coverage.cjs');

function sortedKeys(record) {
  return Object.keys(record).sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatList(values) {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function formatRedundantIndexGroups(groups) {
  return groups.map(group => `${group.table}(${group.indexes.join(',')})`);
}

function expectList(errors, label, actual, expected) {
  if (!arraysEqual(actual, expected)) {
    errors.push(`${label}: expected ${formatList(expected)}; received ${formatList(actual)}`);
  }
}

function expectCount(errors, label, actual, expected) {
  if (actual !== expected) errors.push(`${label}: expected ${expected}; received ${actual}`);
}

function formatAnalyzerError(error, root) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedRoot = root.replace(/\\/g, '/');
  return message.replace(/\\/g, '/').replaceAll(normalizedRoot, '<root>').split(/\r?\n/, 1)[0];
}

function main() {
  const root = process.cwd();
  const manifestPath = path.join(root, 'scripts', 'supabase-schema-coverage-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = analyzeRepositorySchemaCoverage(root);
  const errors = [];
  let rpcReport;
  try {
    rpcReport = analyzeRepositoryRpcFunctionCoverage(root);
  } catch (error) {
    console.error('Supabase schema coverage: failed');
    console.error(`- RPC function coverage analysis: ${formatAnalyzerError(error, root)}`);
    process.exitCode = 1;
    return;
  }

  for (const [groupName, group] of Object.entries(manifest)) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      errors.push(`${groupName}: manifest group must be an object`);
      continue;
    }
    for (const [table, reason] of Object.entries(group)) {
      if (typeof reason !== 'string' || reason.trim().length <= 20) {
        errors.push(`${groupName}.${table}: drift reason must be concrete`);
      }
    }
  }

  expectList(errors, 'active refs missing from fresh-init', report.activeRefsMissingFromFreshInit, []);
  expectList(
    errors,
    'fresh-init tables missing from migration replay',
    report.freshInitMissingFromMigrationReplay,
    [],
  );
  expectList(
    errors,
    'generated columns ahead of fresh-init',
    report.generatedColumnsMissingFromFreshInit,
    sortedKeys(manifest.generatedTypeColumnsAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init columns ahead of generated types',
    report.freshInitColumnsMissingFromGeneratedTypes,
    sortedKeys(manifest.freshInitColumnsAheadOfGeneratedTypes),
  );
  expectList(
    errors,
    'migration replay columns ahead of fresh-init',
    report.migrationReplayColumnsMissingFromFreshInit,
    sortedKeys(manifest.migrationReplayColumnsAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init columns ahead of migration replay',
    report.freshInitColumnsMissingFromMigrationReplay,
    sortedKeys(manifest.freshInitColumnsAheadOfMigrationReplay),
  );
  expectList(
    errors,
    'generated NOT NULL columns ahead of fresh-init',
    report.generatedNotNullMissingFromFreshInit,
    sortedKeys(manifest.generatedTypeNotNullAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init NOT NULL columns ahead of generated types',
    report.freshInitNotNullMissingFromGeneratedTypes,
    sortedKeys(manifest.freshInitNotNullAheadOfGeneratedTypes),
  );
  expectList(
    errors,
    'migration replay NOT NULL columns ahead of fresh-init',
    report.migrationReplayNotNullMissingFromFreshInit,
    sortedKeys(manifest.migrationReplayNotNullAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init NOT NULL columns ahead of migration replay',
    report.freshInitNotNullMissingFromMigrationReplay,
    sortedKeys(manifest.freshInitNotNullAheadOfMigrationReplay),
  );
  expectList(
    errors,
    'generated required Insert columns ahead of fresh-init',
    report.generatedTypeRequiredInsertAheadOfFreshInit,
    sortedKeys(manifest.generatedTypeRequiredInsertAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init required Insert columns ahead of generated types',
    report.freshInitRequiredInsertAheadOfGeneratedTypes,
    sortedKeys(manifest.freshInitRequiredInsertAheadOfGeneratedTypes),
  );
  expectList(
    errors,
    'migration replay required Insert columns ahead of fresh-init',
    report.migrationReplayRequiredInsertAheadOfFreshInit,
    sortedKeys(manifest.migrationReplayRequiredInsertAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init required Insert columns ahead of migration replay',
    report.freshInitRequiredInsertAheadOfMigrationReplay,
    sortedKeys(manifest.freshInitRequiredInsertAheadOfMigrationReplay),
  );
  expectList(
    errors,
    'migration replay tables intentionally omitted from fresh-init',
    report.migrationReplayMissingFromFreshInit,
    sortedKeys(manifest.freshInitOmissions),
  );
  expectList(
    errors,
    'generated types ahead of fresh-init',
    report.generatedTypesMissingFromFreshInit,
    sortedKeys(manifest.generatedTypesAheadOfFreshInit),
  );
  expectList(
    errors,
    'fresh-init ahead of generated types',
    report.freshInitMissingFromGeneratedTypes,
    sortedKeys(manifest.freshInitAheadOfGeneratedTypes),
  );
  expectList(
    errors,
    'fresh-init foreign keys missing a covering index prefix',
    report.unindexedForeignKeys,
    [],
  );
  expectList(
    errors,
    'fresh-init direct RLS identity columns missing a covering index prefix',
    report.unindexedRlsPolicyColumns,
    [],
  );
  expectList(
    errors,
    'fresh-init RLS tables missing FORCE ROW LEVEL SECURITY',
    report.unforcedRlsTables,
    [],
  );
  expectList(
    errors,
    'fresh-init redundant index groups',
    formatRedundantIndexGroups(report.freshInitRedundantIndexes),
    [],
  );
  expectList(
    errors,
    'migration replay redundant index groups',
    formatRedundantIndexGroups(report.migrationReplayRedundantIndexes),
    [],
  );
  expectList(
    errors,
    'generated views missing from fresh-init',
    report.generatedViewsMissingFromFreshInit,
    [],
  );
  expectList(
    errors,
    'fresh-init views missing from generated types',
    report.freshInitViewsMissingFromGeneratedTypes,
    [],
  );
  expectList(
    errors,
    'migration replay views missing from fresh-init',
    report.migrationReplayViewsMissingFromFreshInit,
    [],
  );
  expectList(
    errors,
    'fresh-init views missing from migration replay',
    report.freshInitViewsMissingFromMigrationReplay,
    [],
  );
  expectList(
    errors,
    'migration replay views without security_invoker',
    report.migrationReplayNonSecurityInvokerViews,
    [],
  );
  expectList(
    errors,
    'fresh-init views without security_invoker',
    report.freshInitNonSecurityInvokerViews,
    [],
  );
  expectList(
    errors,
    'migration replay unsafe view privilege states',
    report.migrationReplayUnsafeViewPrivileges,
    [],
  );
  expectList(
    errors,
    'fresh-init unsafe view privilege states',
    report.freshInitUnsafeViewPrivileges,
    [],
  );
  expectCount(errors, 'production RPC reference sites', rpcReport.references.length, 32);
  expectCount(errors, 'production RPC function names', rpcReport.rpcNames.length, 31);
  expectList(
    errors,
    'unresolved production RPC reference sites',
    rpcReport.unresolvedDynamicSites.map(site =>
      `${site.path}:${site.line}:${site.column}:${site.reason}`
    ),
    [],
  );
  expectList(
    errors,
    'fresh-init RPC functions missing',
    rpcReport.missingFromFreshInit,
    [],
  );
  expectList(
    errors,
    'fresh-init RPC function lifecycle indeterminate',
    rpcReport.freshInitRpcDeclarations.indeterminate,
    [],
  );
  expectList(
    errors,
    'fresh-init RPC functions ahead of generated types',
    rpcReport.missingFromGeneratedTypes,
    sortedKeys(manifest.freshInitRpcFunctionsAheadOfGeneratedTypes),
  );
  expectCount(
    errors,
    'generated RPC function types missing',
    rpcReport.missingFromGeneratedTypes.length,
    10,
  );

  const unknownActiveTypeDrift = report.activeRefsMissingFromGeneratedTypes.filter(
    table => !(table in manifest.freshInitAheadOfGeneratedTypes),
  );
  expectList(
    errors,
    'active refs missing from generated types without an explicit pending-replay reason',
    unknownActiveTypeDrift,
    [],
  );

  if (errors.length > 0) {
    console.error('Supabase schema coverage: failed');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log('Supabase schema coverage: passed');
  console.log(`- generated public tables: ${report.generatedTypeTables.length}`);
  console.log(`- generated public views: ${report.generatedTypeViews.length}`);
  console.log(`- active database table refs: ${Object.keys(report.activeDatabaseTableRefs).length}`);
  console.log(`- migration replay tables: ${report.migrationReplayTables.length}`);
  console.log(`- migration replay views: ${report.migrationReplayViews.length}`);
  console.log(`- fresh-init tables: ${report.freshInitTables.length}`);
  console.log(`- fresh-init views: ${report.freshInitViews.length}`);
  console.log(`- generated columns missing from fresh-init: ${report.generatedColumnsMissingFromFreshInit.length}`);
  console.log(`- fresh-init columns missing from generated types: ${report.freshInitColumnsMissingFromGeneratedTypes.length}`);
  console.log(`- migration replay columns missing from fresh-init: ${report.migrationReplayColumnsMissingFromFreshInit.length}`);
  console.log(`- fresh-init columns missing from migration replay: ${report.freshInitColumnsMissingFromMigrationReplay.length}`);
  console.log(`- generated NOT NULL columns missing from fresh-init: ${report.generatedNotNullMissingFromFreshInit.length}`);
  console.log(`- fresh-init NOT NULL columns missing from generated types: ${report.freshInitNotNullMissingFromGeneratedTypes.length}`);
  console.log(`- migration replay NOT NULL columns missing from fresh-init: ${report.migrationReplayNotNullMissingFromFreshInit.length}`);
  console.log(`- fresh-init NOT NULL columns missing from migration replay: ${report.freshInitNotNullMissingFromMigrationReplay.length}`);
  console.log(`- generated required Insert columns ahead of fresh-init: ${report.generatedTypeRequiredInsertAheadOfFreshInit.length}`);
  console.log(`- fresh-init required Insert columns ahead of generated types: ${report.freshInitRequiredInsertAheadOfGeneratedTypes.length}`);
  console.log(`- migration replay required Insert columns ahead of fresh-init: ${report.migrationReplayRequiredInsertAheadOfFreshInit.length}`);
  console.log(`- fresh-init required Insert columns ahead of migration replay: ${report.freshInitRequiredInsertAheadOfMigrationReplay.length}`);
  console.log(`- unindexed foreign keys: ${report.unindexedForeignKeys.length}`);
  console.log(`- unindexed direct RLS identity columns: ${report.unindexedRlsPolicyColumns.length}`);
  console.log(`- unforced RLS tables: ${report.unforcedRlsTables.length}`);
  console.log(`- fresh-init redundant index groups: ${report.freshInitRedundantIndexes.length}`);
  console.log(`- migration replay redundant index groups: ${report.migrationReplayRedundantIndexes.length}`);
  console.log(`- migration replay non-security-invoker views: ${report.migrationReplayNonSecurityInvokerViews.length}`);
  console.log(`- fresh-init non-security-invoker views: ${report.freshInitNonSecurityInvokerViews.length}`);
  console.log(`- migration replay unsafe view privilege states: ${report.migrationReplayUnsafeViewPrivileges.length}`);
  console.log(`- fresh-init unsafe view privilege states: ${report.freshInitUnsafeViewPrivileges.length}`);
  console.log(`- pending generated-type replay entries: ${report.freshInitMissingFromGeneratedTypes.length}`);
  console.log(`- production RPC reference sites: ${rpcReport.references.length}`);
  console.log(`- production RPC function names: ${rpcReport.rpcNames.length}`);
  console.log(`- fresh-init RPC functions missing: ${rpcReport.missingFromFreshInit.length}`);
  console.log(`- generated RPC function types missing: ${rpcReport.missingFromGeneratedTypes.length}`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
