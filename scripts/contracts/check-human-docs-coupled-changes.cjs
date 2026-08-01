#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadRequiredFilesManifest } = require('./required-files-manifest.cjs');

const projectRoot = process.cwd();
const coveragePath = 'docs/handbook/change-coverage.json';
const catalogPath = 'docs/handbook/catalog.json';
const TEST_ONLY_PATH = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:spec|test)\.[cm]?[jt]sx?$|\.spec-helpers\.[cm]?[jt]sx?$/;

function normalizePath(input) {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toAbsolute(relativePath) {
  return path.join(projectRoot, relativePath);
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
    });
  } catch {
    throw new Error('human-docs-coupled-evidence-unavailable');
  }
}

function parseNulFields(output) {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new Error('human-docs-coupled-evidence-unavailable');
  const fields = output.slice(0, -1).split('\0');
  if (fields.some(field => field.length === 0)) throw new Error('human-docs-coupled-evidence-unavailable');
  return fields;
}

function parseNameStatus(output) {
  const fields = parseNulFields(output);
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const firstPath = fields[index++];
    if (!/^[ACMRD]/.test(status) || firstPath === undefined) {
      throw new Error('human-docs-coupled-evidence-unavailable');
    }
    files.push(firstPath);
    if (/^[RC]/.test(status)) {
      const secondPath = fields[index++];
      if (secondPath === undefined) throw new Error('human-docs-coupled-evidence-unavailable');
      files.push(secondPath);
    }
  }
  return files.map(normalizePath);
}

function uniqueFiles(files) {
  return [...new Set(files)].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function getStagedFiles() {
  return parseNameStatus(runGit(['diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD']));
}

function getUnstagedFiles() {
  return parseNameStatus(runGit(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD']));
}

function getUntrackedFiles() {
  return parseNulFields(runGit(['ls-files', '--others', '--exclude-standard', '-z'])).map(normalizePath);
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
  return parseNameStatus(runGit(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD', range]));
}

function getHeadCommitFiles() {
  return parseNameStatus(runGit([
    'diff-tree', '--no-commit-id', '--name-status', '-z', '--find-renames', '-r', '--diff-filter=ACMRD', 'HEAD',
  ]));
}

function getCiComparisonFiles() {
  const explicitBase = (process.env.HUMAN_DOCS_GUARD_DIFF_BASE || process.env.COUPLED_GUARD_DIFF_BASE || '').trim();
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

function globToRegex(glob) {
  let pattern = '^';
  const normalized = normalizePath(glob);

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    pattern += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`${pattern}$`);
}

function matches(pattern, relativePath) {
  return globToRegex(pattern).test(relativePath);
}

function getCatalogPages(catalog) {
  const pages = new Set([catalog.root]);
  for (const category of catalog.categories ?? []) {
    pages.add(category.landing);
    for (const article of category.articles ?? []) {
      pages.add(article.path);
    }
  }
  return pages;
}

function readAudience(relativePath) {
  const text = fs.readFileSync(toAbsolute(relativePath), 'utf8');
  const audience = text.match(/^audience:\s*(.+)$/m)?.[1] ?? '';
  return audience.trim();
}

function loadCoverage() {
  const errors = [];
  let coverage;
  let catalog;

  try {
    coverage = JSON.parse(fs.readFileSync(toAbsolute(coveragePath), 'utf8'));
  } catch (error) {
    errors.push(`${coveragePath} must be valid JSON: ${error.message}`);
  }

  try {
    catalog = JSON.parse(fs.readFileSync(toAbsolute(catalogPath), 'utf8'));
  } catch (error) {
    errors.push(`${catalogPath} must be valid JSON: ${error.message}`);
  }

  if (errors.length > 0 || !coverage || !catalog) {
    return { coverage: null, errors };
  }

  if (coverage.version !== 1) {
    errors.push(`${coveragePath} version must be 1`);
  }
  if (!Array.isArray(coverage.routes) || coverage.routes.length === 0) {
    errors.push(`${coveragePath} must define at least one route`);
    return { coverage: null, errors };
  }

  const catalogPages = getCatalogPages(catalog);
  const ids = new Set();
  const routes = [];

  for (const route of coverage.routes) {
    if (!route || typeof route !== 'object') {
      errors.push(`${coveragePath} contains an invalid route`);
      continue;
    }

    const { id, description, triggers, handbook } = route;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`${coveragePath} route must have an id`);
      continue;
    }
    if (ids.has(id)) {
      errors.push(`${coveragePath} route id must be unique: ${id}`);
      continue;
    }
    ids.add(id);

    if (typeof description !== 'string' || description.length < 12) {
      errors.push(`${coveragePath} route ${id} must have a useful description`);
    }
    if (!Array.isArray(triggers) || triggers.length === 0 || triggers.some(item => typeof item !== 'string' || item.length === 0)) {
      errors.push(`${coveragePath} route ${id} must define non-empty triggers`);
    }
    if (!Array.isArray(handbook) || handbook.length === 0 || handbook.some(item => typeof item !== 'string' || item.length === 0)) {
      errors.push(`${coveragePath} route ${id} must define handbook pages`);
    }

    for (const handbookPage of handbook ?? []) {
      const absolutePath = toAbsolute(handbookPage);
      if (!fs.existsSync(absolutePath)) {
        errors.push(`${coveragePath} route ${id} references missing handbook page: ${handbookPage}`);
        continue;
      }
      if (!catalogPages.has(handbookPage)) {
        errors.push(`${coveragePath} route ${id} handbook page must be listed in ${catalogPath}: ${handbookPage}`);
      }
      if (!/\b(user|operator)\b/.test(readAudience(handbookPage))) {
        errors.push(`${coveragePath} route ${id} handbook page must be user-facing: ${handbookPage}`);
      }
    }

    if (Array.isArray(triggers) && Array.isArray(handbook)) {
      routes.push({ id, description, triggers, handbook });
    }
  }

  return { coverage: routes, errors };
}

function getChangedFiles(mode, explicitFiles) {
  if (explicitFiles.length > 0) return explicitFiles;
  if (mode === 'staged') return getStagedFiles();
  if (mode === 'staged-or-head') {
    const staged = getStagedFiles();
    return staged.length > 0 ? staged : getCiComparisonFiles();
  }
  if (mode === 'working-tree') return getWorkingTreeFiles();
  if (mode === 'working-tree-or-head') {
    const workingTree = getWorkingTreeFiles();
    return workingTree.length > 0 ? workingTree : getCiComparisonFiles();
  }
  throw new Error(`unsupported mode: ${mode}`);
}

function collectViolations(changedFiles, routes) {
  const productFiles = changedFiles.filter(file => !TEST_ONLY_PATH.test(file));
  const violations = [];

  for (const route of routes) {
    const triggeredFiles = productFiles.filter(file => route.triggers.some(trigger => matches(trigger, file)));
    if (triggeredFiles.length === 0) continue;

    const hasCompanion = productFiles.some(file => route.handbook.includes(file));
    if (!hasCompanion) {
      violations.push({ route, triggeredFiles });
    }
  }

  return violations;
}

function main() {
  const { coverage, errors } = loadCoverage();

  if (errors.length > 0 || !coverage) {
    console.error('[human-docs-coupled-changes] invalid coverage configuration:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  let mode = 'required-files-manifest';
  let changedFiles;
  try {
    const manifestFiles = loadRequiredFilesManifest({ projectRoot });
    if (manifestFiles) {
      changedFiles = manifestFiles;
    } else {
      const explicitFiles = parseFilesArg();
      mode = parseModeArg();
      changedFiles = getChangedFiles(mode, explicitFiles);
    }
  } catch (error) {
    console.error(`[human-docs-coupled-changes] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    console.log(`[human-docs-coupled-changes] no files found for mode=${mode}, skipping`);
    return;
  }

  const violations = collectViolations(changedFiles, coverage);
  if (violations.length === 0) {
    console.log('[human-docs-coupled-changes] passed');
    return;
  }

  console.error('[human-docs-coupled-changes] blocked because user-visible implementation changes did not update their mapped Chinese handbook page:');
  for (const violation of violations) {
    console.error(`- ${violation.route.id}: ${violation.route.description}`);
    console.error(`  changed: ${violation.triggeredFiles.join(', ')}`);
    console.error(`  require one of: ${violation.route.handbook.join(', ')}`);
  }
  console.error('Update the matching handbook page in the same change, or narrow the coverage route if the implementation is demonstrably not user-visible.');
  process.exit(1);
}

main();
