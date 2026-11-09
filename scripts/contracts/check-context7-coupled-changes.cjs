#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { loadRequiredFilesManifest } = require('./required-files-manifest.cjs');

const projectRoot = process.cwd();

const DOCUMENTATION_COMPANIONS = [
  /^docs\/context7\/.+/,
  'context7.json',
  'llms.txt',
];

const RULES = [
  {
    name: 'architecture-and-state-docs',
    description: 'architecture, state, shell, and shared UI changes must keep Context7 architecture/source-map docs current',
    triggers: [
      /^src\/app\/core\/.+/,
      /^src\/app\/shared\/.+/,
      /^src\/app\/features\/.+/,
      /^src\/services\/.+/,
      /^src\/state\/.+/,
      /^src\/models\/.+/,
    ],
    companions: DOCUMENTATION_COMPANIONS,
    allow: [/\.spec\.ts$/],
    nextStep: 'Update the matching docs/context7 guide, source-map, API reference, contract, runbook, or catalog route.',
  },
  {
    name: 'configuration-reference-docs',
    description: 'configuration changes must keep Context7 configuration and compatibility references current',
    triggers: [
      /^src\/config\/.+/,
      'angular.json',
      'package.json',
      'package-lock.json',
      'playwright.config.ts',
      'vitest.config.mts',
      /^vitest\..+\.mts$/,
      /^scripts\/(?:set-env|validate-env|run-test-matrix|supabase-cli|sentry-cli)\.cjs$/,
    ],
    companions: [
      /^docs\/context7\/(?:reference\/configuration-reference|compatibility-matrix|development|05-file-conventions\/.+|08-migration\/versioning)\.md$/,
      /^docs\/context7\/.+/,
      'llms.txt',
      'context7.json',
    ],
    nextStep: 'Update configuration-reference, compatibility-matrix, development, versioning, or related Context7 docs.',
  },
  {
    name: 'sync-and-offline-contract-docs',
    description: 'sync, offline, retry queue, tombstone, and LWW changes must keep Context7 sync contracts accurate',
    triggers: [
      /^src\/app\/core\/services\/sync\/.+/,
      'src/app/core/services/simple-sync.service.ts',
      /^src\/services\/(?:sync|delta-sync|action-queue|event-driven-sync|mobile-sync|project-sync|conflict|dock-cloud-sync|black-box-sync).+/,
      /^src\/app\/core\/state\/persistence\/.+/,
    ],
    companions: [
      'docs/context7/sync-offline.md',
      'docs/context7/contracts/sync-contract.md',
      'docs/context7/runbooks/sync-debugging.md',
      'docs/context7/03-api-reference/sync-services.md',
      'docs/context7/04-architecture/sync-architecture.md',
      /^docs\/context7\/.+/,
    ],
    nextStep: 'Update sync-offline, sync-contract, sync debugging runbook, sync API reference, or sync architecture docs.',
  },
  {
    name: 'data-model-and-schema-docs',
    description: 'model, migration, schema, and Edge Function changes must keep Context7 model/schema/API docs current',
    triggers: [
      /^src\/models\/.+/,
      /^src\/types\/supabase\.ts$/,
      /^supabase\/migrations\/.+\.sql$/,
      /^supabase\/functions\/.+/,
    ],
    companions: [
      'docs/context7/data-model.md',
      'docs/context7/reference/model-field-reference.md',
      'docs/context7/reference/supabase-schema-reference.md',
      'docs/context7/03-api-reference/models.md',
      'docs/context7/03-api-reference/edge-functions.md',
      'docs/context7/08-migration/schema-migrations.md',
      /^docs\/context7\/.+/,
    ],
    nextStep: 'Update model-field-reference, schema reference, Edge Function API docs, migration docs, or catalog routes.',
  },
  {
    name: 'security-and-operations-docs',
    description: 'auth, security, upload, Sentry, environment, and operational changes must keep Context7 security/runbook docs current',
    triggers: [
      /^src\/services\/auth.+/,
      /^src\/services\/guards\/.+/,
      /^src\/services\/sentry.+/,
      /^src\/services\/file-type-validator.+/,
      /^src\/utils\/supabase-error\.ts$/,
      /^scripts\/contracts\/check-secrets\.cjs$/,
      /^supabase\/functions\/(?:_shared|virus-scan|.+auth.+)\/.+/,
    ],
    companions: [
      'docs/context7/operations-security.md',
      'docs/context7/contracts/security-contract.md',
      'docs/context7/06-errors/auth-security-errors.md',
      'docs/context7/runbooks/data-recovery.md',
      /^docs\/context7\/.+/,
    ],
    nextStep: 'Update operations-security, security-contract, auth/security error docs, or recovery runbook.',
  },
];

function normalizePath(input) {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
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

function parseModeArg() {
  const arg = process.argv.slice(2).find(item => item.startsWith('--mode='));
  return arg ? arg.slice('--mode='.length) : 'staged';
}

function getGitFiles(args) {
  try {
    const output = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .split(/\r?\n/)
      .map(item => normalizePath(item.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getStagedFiles() {
  return getGitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']);
}

function getUnstagedFiles() {
  return getGitFiles(['diff', '--name-only', '--diff-filter=ACMRD']);
}

function getUntrackedFiles() {
  return getGitFiles(['ls-files', '--others', '--exclude-standard']);
}

function uniqueFiles(files) {
  return [...new Set(files)].sort();
}

function getWorkingTreeFiles() {
  return uniqueFiles([
    ...getStagedFiles(),
    ...getUnstagedFiles(),
    ...getUntrackedFiles(),
  ]);
}

function canResolveGitRef(ref) {
  if (!ref) return false;
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function getFilesForRange(range) {
  return getGitFiles(['diff', '--name-only', '--diff-filter=ACMRD', range]);
}

function getHeadCommitFiles() {
  return getGitFiles(['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=ACMRD', 'HEAD']);
}

function getCiComparisonFiles() {
  const explicitBase = (process.env.CONTEXT7_GUARD_DIFF_BASE || process.env.COUPLED_GUARD_DIFF_BASE || '').trim();
  if (explicitBase && canResolveGitRef(explicitBase)) {
    return getFilesForRange(`${explicitBase}...HEAD`);
  }

  const beforeSha = (process.env.GITHUB_EVENT_BEFORE || '').trim();
  if (beforeSha && !/^0+$/.test(beforeSha) && canResolveGitRef(beforeSha)) {
    return getFilesForRange(`${beforeSha}..HEAD`);
  }

  const baseRef = (process.env.GITHUB_BASE_REF || '').trim();
  if (baseRef) {
    const remoteBase = `origin/${baseRef}`;
    if (canResolveGitRef(remoteBase)) {
      return getFilesForRange(`${remoteBase}...HEAD`);
    }
  }

  return getHeadCommitFiles();
}

function matches(patterns, relPath) {
  return patterns.some(pattern => (
    typeof pattern === 'string'
      ? pattern === relPath
      : pattern.test(relPath)
  ));
}

function hasCompanion(rule, changedFiles) {
  return changedFiles.some(file => matches(rule.companions, file));
}

function collectViolations(changedFiles) {
  const violations = [];

  for (const rule of RULES) {
    const triggeredFiles = changedFiles.filter(file => (
      matches(rule.triggers, file) && !matches(rule.allow ?? [], file)
    ));

    if (triggeredFiles.length === 0 || hasCompanion(rule, changedFiles)) {
      continue;
    }

    violations.push({ rule, triggeredFiles });
  }

  return violations;
}

function main() {
  let mode = 'required-files-manifest';
  let changedFiles;
  try {
    const manifestFiles = loadRequiredFilesManifest({ projectRoot });
    if (manifestFiles) {
      changedFiles = manifestFiles;
    } else {
      const explicitFiles = parseFilesArg();
      mode = parseModeArg();
      changedFiles = explicitFiles;

      if (changedFiles.length === 0) {
        const stagedFiles = getStagedFiles();
        if (mode === 'staged') {
          changedFiles = stagedFiles;
        } else if (mode === 'staged-or-head') {
          changedFiles = stagedFiles.length > 0 ? stagedFiles : getCiComparisonFiles();
        } else if (mode === 'working-tree') {
          changedFiles = getWorkingTreeFiles();
        } else if (mode === 'working-tree-or-head') {
          const workingTreeFiles = getWorkingTreeFiles();
          changedFiles = workingTreeFiles.length > 0 ? workingTreeFiles : getCiComparisonFiles();
        } else {
          throw new Error(`unsupported mode: ${mode}`);
        }
      }
    }
  } catch (error) {
    console.error(`[context7-coupled-changes] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    console.log(`[context7-coupled-changes] no files found for mode=${mode}, skipping`);
    return;
  }

  const violations = collectViolations(changedFiles);
  if (violations.length === 0) {
    console.log('[context7-coupled-changes] passed');
    return;
  }

  console.error('[context7-coupled-changes] blocked because implementation-affecting changes did not include Context7 documentation updates:');
  for (const violation of violations) {
    console.error(`- ${violation.rule.name}: ${violation.rule.description}`);
    console.error(`  changed: ${violation.triggeredFiles.join(', ')}`);
    console.error(`  require one of: ${violation.rule.companions.map(item => typeof item === 'string' ? item : item.toString()).join(', ')}`);
    console.error(`  next: ${violation.rule.nextStep}`);
  }
  console.error('If the change is intentionally documentation-neutral, explain why in the PR/commit context and use the project-approved bypass.');
  process.exit(1);
}

main();
