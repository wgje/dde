'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FILES_MANIFEST_REQUIRED = 'REQUIRED_FILES_MANIFEST_REQUIRED';
const REQUIRED_FILES_MANIFEST_PATH = 'REQUIRED_FILES_MANIFEST_PATH';
const REQUIRED_FILES_MANIFEST_SCHEMA = 'schemaVersion=1';

function canonicalRealPath(targetPath) {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(targetPath)
    : fs.realpathSync(targetPath);
}

function canonicalPathIdentity(targetPath) {
  const normalizedPath = path.normalize(targetPath);
  return process.platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function isContainedWithinProjectRoot(projectRoot, targetPath) {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath === ''
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
    );
}

function readManifestText(manifestPath) {
  try {
    return fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`required-files manifest missing or unreadable: ${manifestPath} (${detail})`);
  }
}

function parseManifestLines(manifestText) {
  if (manifestText.includes('\r')) {
    throw new Error('required-files manifest must use LF newlines only');
  }

  const lines = manifestText.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function validateManifestRoot(projectRoot, rootLine) {
  if (!rootLine.startsWith('root=')) {
    throw new Error('required-files manifest root line must start with "root="');
  }

  const manifestRoot = rootLine.slice('root='.length).trim();
  if (!manifestRoot) {
    throw new Error('required-files manifest root must not be empty');
  }

  let canonicalManifestRoot;
  try {
    canonicalManifestRoot = canonicalRealPath(manifestRoot);
  } catch {
    throw new Error(`required-files manifest root must match project root: expected ${projectRoot}`);
  }

  if (manifestRoot !== canonicalManifestRoot) {
    throw new Error(`required-files manifest root must be the canonical real repo root: ${canonicalManifestRoot}`);
  }

  if (canonicalManifestRoot !== projectRoot) {
    throw new Error(`required-files manifest root must match project root: expected ${projectRoot}`);
  }
}

function validateManifestEntry(projectRoot, entry, index, previousEntry, seenEntries) {
  const label = `required-files manifest entry ${index + 1}`;
  if (!entry) {
    throw new Error(`${label} must not be empty`);
  }

  if (path.isAbsolute(entry)) {
    throw new Error(`${label} must be repo-relative: ${entry}`);
  }

  if (entry.includes('\\')) {
    throw new Error(`${label} must use forward slashes: ${entry}`);
  }

  const normalizedEntry = path.posix.normalize(entry);
  if (
    entry === '.'
    || entry === '..'
    || entry.startsWith('./')
    || entry.startsWith('../')
    || normalizedEntry === '.'
    || normalizedEntry === '..'
    || normalizedEntry.startsWith('../')
  ) {
    throw new Error(`${label} must be repo-relative and stay within the project root: ${entry}`);
  }

  if (normalizedEntry !== entry) {
    throw new Error(`${label} must be canonical repo-relative path: ${entry}`);
  }

  if (seenEntries.has(entry)) {
    throw new Error(`${label} is a duplicate: ${entry}`);
  }

  if (previousEntry !== null && previousEntry > entry) {
    throw new Error(`required-files manifest entries must be sorted in ascending ordinal order: ${entry}`);
  }

  const absolutePath = path.join(projectRoot, entry);
  let canonicalEntryPath;
  try {
    canonicalEntryPath = canonicalRealPath(absolutePath);
  } catch {
    throw new Error(`${label} references missing path: ${entry}`);
  }

  if (!isContainedWithinProjectRoot(projectRoot, canonicalEntryPath)) {
    throw new Error(`${label} must resolve within the project root: ${entry}`);
  }

  const canonicalEntry = path.relative(projectRoot, canonicalEntryPath).split(path.sep).join('/');
  if (canonicalEntry !== entry) {
    throw new Error(`${label} must be canonical repo-relative path: ${entry}`);
  }

  if (!fs.statSync(canonicalEntryPath).isFile()) {
    throw new Error(`${label} references missing path: ${entry}`);
  }

  const canonicalIdentity = canonicalPathIdentity(canonicalEntryPath);
  if (seenEntries.has(canonicalIdentity)) {
    throw new Error(`${label} is a duplicate: ${entry}`);
  }

  return {
    canonicalIdentity,
    canonicalEntry,
  };
}

function loadRequiredFilesManifest(options = {}) {
  const env = options.env ?? process.env;
  if (String(env[REQUIRED_FILES_MANIFEST_REQUIRED] ?? '').trim() !== '1') {
    return null;
  }

  const manifestPathValue = String(env[REQUIRED_FILES_MANIFEST_PATH] ?? '').trim();
  if (!manifestPathValue) {
    throw new Error(`${REQUIRED_FILES_MANIFEST_PATH} is required when ${REQUIRED_FILES_MANIFEST_REQUIRED}=1`);
  }

  const projectRoot = canonicalRealPath(path.resolve(options.projectRoot ?? process.cwd()));
  const manifestPath = path.resolve(manifestPathValue);
  const manifestText = readManifestText(manifestPath);
  const lines = parseManifestLines(manifestText);

  if (lines[0] !== REQUIRED_FILES_MANIFEST_SCHEMA) {
    throw new Error(`required-files manifest schemaVersion must be exactly "${REQUIRED_FILES_MANIFEST_SCHEMA}"`);
  }

  validateManifestRoot(projectRoot, lines[1] ?? '');

  const entries = lines.slice(2);
  if (entries.length === 0) {
    throw new Error('required-files manifest entries must include at least one path');
  }

  let previousEntry = null;
  const seenEntries = new Set();
  const canonicalEntries = [];
  for (const [index, entry] of entries.entries()) {
    const { canonicalIdentity, canonicalEntry } = validateManifestEntry(
      projectRoot,
      entry,
      index,
      previousEntry,
      seenEntries,
    );
    seenEntries.add(canonicalIdentity);
    canonicalEntries.push(canonicalEntry);
    previousEntry = entry;
  }

  return canonicalEntries;
}

module.exports = {
  loadRequiredFilesManifest,
};
