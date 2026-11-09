#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadRequiredFilesManifest } = require('./required-files-manifest.cjs');

const projectRoot = process.cwd();
const expectedIndexAbsences = new Set();

const RULES = [
  {
    name: 'local-persistence-backup-restore',
    description: 'owner-scoped 本地持久化改动需要同步检查备份/恢复契约',
    triggers: [
      'src/services/dock-snapshot-persistence.service.ts',
      'src/services/launch-snapshot.service.ts',
      'src/services/conflict-storage.service.ts',
      'src/services/action-queue-storage.service.ts',
      'src/app/core/services/sync/retry-queue.service.ts',
      'src/app/core/external-sources/external-source-cache.service.ts',
    ],
    requireAny: [
      'src/services/disaster-backup.service.ts',
      'src/services/import.service.ts',
      'src/services/import.service.spec.ts',
      'supabase/functions/_shared/backup-utils.ts',
      'src/services/disaster-backup.service.spec.ts',
    ],
    evidencePattern: /(nanoflow\.|localStorage\.(?:setItem|getItem|removeItem)|indexedDB|createObjectStore|objectStore\(|idb-keyval|keyval-store|IDB)/i,
    nextStep: '同步检查 DisasterBackupService / BackupLocalState / ImportService / disaster-backup spec。',
  },
  {
    name: 'supabase-schema-types',
    description: 'DDL 类 migration 改动需要同步刷新前端 Supabase 类型',
    triggers: [/^supabase\/migrations\/.*\.sql$/],
    requireAny: [
      'src/types/supabase.ts',
    ],
    evidencePattern: /\b(create|alter|drop)\s+(table|type|view|materialized\s+view)\b|\b(add|drop|alter|rename)\s+column\b/i,
    nextStep: '运行 npm run db:types，并将 src/types/supabase.ts 一并提交。',
  },
  {
    name: 'siyuan-preview-contract',
    description: '思源预览 payload 边界改动需要同步检查 model/normalizer/UI/spec',
    triggers: [
      'src/app/core/external-sources/siyuan/siyuan-direct-provider.ts',
      'src/app/core/external-sources/siyuan/siyuan-extension-provider.ts',
      'extensions/siyuan-relay/src/background.js',
    ],
    requireAny: [
      'src/app/core/external-sources/external-source.model.ts',
      'src/app/core/external-sources/siyuan/siyuan-preview-utils.ts',
      /^src\/app\/core\/external-sources\/siyuan\/.*\.spec\.ts$/,
      'src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.component.ts',
      'src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.component.spec.ts',
      'src/app/features/flow/services/flow-template.service.ts',
    ],
    nextStep: '同步检查 preview model、normalizePreview、popover、flow badge 与 provider/relay 规格测试。',
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

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    throw new Error('coupled-change-evidence-unavailable');
  }
}

function getGitFiles(args) {
  return runGit(args)
    .split(/\r?\n/)
    .map(item => normalizePath(item.trim()))
    .filter(Boolean);
}

function parseNameStatus(output, indexRole) {
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; fields[index];) {
    const status = fields[index++];
    const firstPath = fields[index++];
    files.push(firstPath);
    if (/^[RC]/.test(status)) {
      const secondPath = fields[index++];
      files.push(secondPath);
      if (indexRole === 'staged' && status.startsWith('R')) expectedIndexAbsences.add(firstPath);
    } else if (status === 'D' && indexRole === 'staged') {
      expectedIndexAbsences.add(firstPath);
    }
  }
  return files.map(normalizePath);
}

function uniqueFiles(files) {
  return [...new Set(files.filter(Boolean))].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function getStagedFiles() {
  return getGitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']);
}

function getWorkingTreeFiles() {
  const staged = parseNameStatus(runGit(['diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD']), 'staged');
  const unstaged = parseNameStatus(runGit(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD']));
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0').map(normalizePath).filter(Boolean);
  for (const file of untracked) expectedIndexAbsences.add(file);
  return uniqueFiles([
    ...staged,
    ...unstaged,
    ...untracked,
  ]);
}

function getHeadCommitFiles() {
  return getGitFiles(['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=ACMRD', 'HEAD']);
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

function getCiComparisonFiles() {
  const explicitBase = (process.env.COUPLED_GUARD_DIFF_BASE || '').trim();
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

function readStagedDiff(relPath) {
  return runGit(['diff', '--cached', '--unified=0', '--', relPath]);
}

function indexAbsenceExpected(relPath) {
  if (expectedIndexAbsences.has(relPath)) return true;
  parseNameStatus(runGit(['diff', '--cached', '--name-status', '-z', '--find-renames', '--', relPath]), 'staged');
  if (expectedIndexAbsences.has(relPath)) return true;
  return runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', relPath]).split('\0').map(normalizePath).includes(relPath);
}

function readStagedContent(relPath) {
  const indexed = runGit(['ls-files', '--stage', '--', relPath]);
  if (indexed) return runGit(['show', `:${relPath}`]);
  if (indexAbsenceExpected(relPath)) return '';
  throw new Error('coupled-change-evidence-unavailable');
}

function readWorkingTreeDiff(relPath) {
  return runGit(['diff', 'HEAD', '--unified=0', '--', relPath]);
}

function matches(patterns, relPath) {
  return patterns.some(pattern => (
    typeof pattern === 'string'
      ? pattern === relPath
      : pattern.test(relPath)
  ));
}

function hasRequiredCompanion(rule, changedFiles) {
  return changedFiles.some(file => matches(rule.requireAny, file));
}

function hasTriggerEvidence(rule, relPath, evidenceSource) {
  if (!rule.evidencePattern) {
    return true;
  }

  if (evidenceSource === 'explicit') {
    const absolutePath = path.join(projectRoot, relPath);
    const content = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
    return rule.evidencePattern.test(content);
  }

  if (evidenceSource === 'working-tree') {
    const absolutePath = path.join(projectRoot, relPath);
    const content = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
    return rule.evidencePattern.test(content)
      || rule.evidencePattern.test(readStagedContent(relPath))
      || rule.evidencePattern.test(readWorkingTreeDiff(relPath));
  }

  const diff = readStagedDiff(relPath);
  if (diff && rule.evidencePattern.test(diff)) {
    return true;
  }

  const content = readStagedContent(relPath);
  return rule.evidencePattern.test(content);
}

function collectViolations(changedFiles, evidenceSource) {
  const violations = [];

  for (const rule of RULES) {
    const triggeredFiles = changedFiles.filter(file => matches(rule.triggers, file));
    if (triggeredFiles.length === 0) {
      continue;
    }

    const relevantTriggers = triggeredFiles.filter(file => hasTriggerEvidence(rule, file, evidenceSource));
    if (relevantTriggers.length === 0) {
      continue;
    }

    if (hasRequiredCompanion(rule, changedFiles)) {
      continue;
    }

    violations.push({
      rule,
      triggeredFiles: relevantTriggers,
    });
  }

  return violations;
}

function main() {
  let mode = 'required-files-manifest';
  let evidenceSource = 'staged';
  let changedFiles;
  let violations = [];
  try {
    const manifestFiles = loadRequiredFilesManifest({ projectRoot });
    if (manifestFiles) {
      changedFiles = manifestFiles;
      evidenceSource = 'explicit';
    } else {
      const explicitFiles = parseFilesArg();
      mode = parseModeArg();
      changedFiles = explicitFiles;
      if (explicitFiles.length > 0) evidenceSource = 'explicit';

      if (changedFiles.length === 0) {
        if (mode === 'staged') {
          changedFiles = getStagedFiles();
        } else if (mode === 'staged-or-head') {
          const stagedFiles = getStagedFiles();
          changedFiles = stagedFiles.length > 0 ? stagedFiles : getCiComparisonFiles();
        } else if (mode === 'working-tree-or-head') {
          changedFiles = getWorkingTreeFiles();
          if (changedFiles.length > 0) evidenceSource = 'working-tree';
          else changedFiles = getCiComparisonFiles();
        } else {
          throw new Error(`unsupported mode: ${mode}`);
        }
      }
    }
    if (changedFiles.length > 0) violations = collectViolations(changedFiles, evidenceSource);
  } catch (error) {
    console.error(`[quality:guard:coupled-changes] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    console.log(`[quality:guard:coupled-changes] no files found for mode=${mode}, skipping`);
    process.exit(0);
  }

  if (violations.length === 0) {
    console.log('[quality:guard:coupled-changes] passed');
    process.exit(0);
  }

  console.error('[quality:guard:coupled-changes] blocked because a high-risk coupled surface changed without its companion contract files:');
  for (const violation of violations) {
    console.error(`- ${violation.rule.name}: ${violation.rule.description}`);
    console.error(`  changed: ${violation.triggeredFiles.join(', ')}`);
    console.error(`  require one of: ${violation.rule.requireAny.map(item => typeof item === 'string' ? item : item.toString()).join(', ')}`);
    console.error(`  next: ${violation.rule.nextStep}`);
  }
  console.error('If this is an intentional pure refactor, use git commit --no-verify and explain why in the PR/commit context.');
  process.exit(1);
}

main();
