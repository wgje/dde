'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const CONTROL_PATH_PATTERN = /[\u0000-\u001f\u007f]/u;
const TRACKED_RECORD_PATTERN = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9]+)\t([\s\S]+)$/u;
const TRACKED_PREFIX_PATTERN = /^[0-7]{6} /u;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const GIT_LIST_ARGS = ['ls-files', '-z', '--stage', '--cached', '--others', '--exclude-standard'];
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

class GitVisibleWorktreeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GitVisibleWorktreeError';
    this.code = code;
  }
}

function fail(code) {
  throw new GitVisibleWorktreeError(code);
}

function getGitVisibleErrorCode(error) {
  return error instanceof GitVisibleWorktreeError
    ? error.code
    : 'git-visible-internal';
}

function sanitizeGitChildEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^git_/iu.test(key)),
  );
}

function decodeUtf8(buffer, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(code);
  }
}

function pathIdentity(value, platform = process.platform) {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function validateRelativePath(relativePath) {
  if (CONTROL_PATH_PATTERN.test(relativePath)) {
    fail('git-visible-path-control');
  }
  if (
    relativePath.length === 0
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
    || /^[a-z]:\//iu.test(relativePath)
    || relativePath.startsWith('//')
  ) {
    fail('git-visible-path-unsafe');
  }

  const segments = relativePath.split('/');
  if (
    segments.some(segment => segment === '' || segment === '.' || segment === '..')
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    fail('git-visible-path-unsafe');
  }
}

function splitNulRecords(output) {
  if (!Buffer.isBuffer(output)) {
    fail('git-visible-record-malformed');
  }
  if (output.length === 0) {
    return [];
  }
  if (output[output.length - 1] !== 0) {
    fail('git-visible-record-malformed');
  }

  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue;
    }
    if (index === start) {
      fail('git-visible-record-malformed');
    }
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function parseGitLsFilesRecords(output, options = {}) {
  const platform = options.platform ?? process.platform;
  const identities = new Set();
  const records = [];

  for (const rawRecord of splitNulRecords(output)) {
    const decoded = decodeUtf8(rawRecord, 'git-visible-record-invalid-utf8');
    const trackedMatch = TRACKED_RECORD_PATTERN.exec(decoded);
    if (!trackedMatch && TRACKED_PREFIX_PATTERN.test(decoded)) {
      fail('git-visible-record-malformed');
    }
    if (trackedMatch && options.rawPathExists?.(decoded)) {
      fail('git-visible-path-control');
    }

    const stage = trackedMatch?.[3] ?? null;
    const relativePath = trackedMatch?.[4] ?? decoded;
    if (stage !== null && stage !== '0') {
      fail('git-visible-stage-unsupported');
    }
    validateRelativePath(relativePath);

    const identity = pathIdentity(relativePath, platform);
    if (identities.has(identity)) {
      fail('git-visible-path-duplicate');
    }
    identities.add(identity);
    records.push({
      relativePath,
      mode: trackedMatch?.[1] ?? null,
      tracked: trackedMatch !== null,
    });
  }

  return records;
}

function runGit(root, args, env, failureCode) {
  const result = spawnSync('git', args, {
    cwd: root,
    env,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail(failureCode);
  }
  return result.stdout;
}

function realpath(value, failureCode) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    fail(failureCode);
  }
}

function canonicalRoot(requestedRoot, env) {
  const resolvedRoot = path.resolve(requestedRoot);
  const root = realpath(resolvedRoot, 'git-visible-root-unverified');
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    fail('git-visible-root-unverified');
  }
  if (!rootStat.isDirectory()) {
    fail('git-visible-root-unverified');
  }

  const rootOutput = runGit(
    root,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    env,
    'git-visible-root-unverified',
  );
  const decodedRoot = decodeUtf8(rootOutput, 'git-visible-root-unverified')
    .replace(/\r?\n$/u, '');
  if (!decodedRoot || CONTROL_PATH_PATTERN.test(decodedRoot)) {
    fail('git-visible-root-unverified');
  }
  const repositoryRoot = realpath(decodedRoot, 'git-visible-root-unverified');
  if (pathIdentity(repositoryRoot) !== pathIdentity(root)) {
    fail('git-visible-root-mismatch');
  }
  return root;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function statIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(':');
}

function lstatBigInt(absolutePath, missingCode) {
  try {
    return fs.lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail(missingCode);
    }
    fail('git-visible-path-unverified');
  }
}

function inspectEntryPath(root, relativePath, tracked) {
  const segments = relativePath.split('/');
  let currentPath = root;
  let finalStat;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    try {
      finalStat = fs.lstatSync(currentPath, { bigint: true });
    } catch (error) {
      if (tracked && error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return null;
      }
      fail('git-visible-path-unverified');
    }
    if (finalStat.isSymbolicLink()) {
      fail('git-visible-path-symlink');
    }
    if (index < segments.length - 1 && !finalStat.isDirectory()) {
      fail('git-visible-path-type');
    }
  }

  if (!finalStat?.isFile()) {
    fail('git-visible-path-type');
  }
  const absolutePath = currentPath;
  const canonicalPath = realpath(absolutePath, 'git-visible-path-unverified');
  if (!isContained(root, canonicalPath)) {
    fail('git-visible-path-outside-root');
  }
  const confirmedStat = lstatBigInt(absolutePath, 'git-visible-path-unverified');
  if (confirmedStat.isSymbolicLink() || statIdentity(confirmedStat) !== statIdentity(finalStat)) {
    fail('git-visible-file-race');
  }
  return { absolutePath, canonicalPath, identity: statIdentity(confirmedStat) };
}

function readVerifiedBuffer(root, entry) {
  let descriptor;
  let pendingError;
  try {
    const currentStat = fs.lstatSync(entry.absolutePath, { bigint: true });
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
      fail('git-visible-file-race');
    }
    const currentCanonicalPath = fs.realpathSync.native(entry.absolutePath);
    if (
      !isContained(root, currentCanonicalPath)
      || pathIdentity(currentCanonicalPath) !== pathIdentity(entry.canonicalPath)
      || statIdentity(currentStat) !== entry.identity
    ) {
      fail('git-visible-file-race');
    }

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(entry.absolutePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    if (!openedStat.isFile() || statIdentity(openedStat) !== entry.identity) {
      fail('git-visible-file-race');
    }
    const buffer = fs.readFileSync(descriptor);
    const finalStat = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(finalStat) !== entry.identity || BigInt(buffer.length) !== finalStat.size) {
      fail('git-visible-file-race');
    }
    return buffer;
  } catch (error) {
    pendingError = error;
    if (error instanceof GitVisibleWorktreeError) {
      throw error;
    }
    fail(error && error.code === 'ENOENT'
      ? 'git-visible-file-race'
      : 'git-visible-file-read');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        if (!pendingError) {
          fail('git-visible-file-read');
        }
      }
    }
  }
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rawListingPathExists(root, candidate) {
  const segments = candidate.split('/');
  if (
    candidate.includes('\\')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return false;
  }
  try {
    fs.lstatSync(path.join(root, ...segments));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    fail('git-visible-path-unverified');
  }
}

function listGitVisibleWorktreeFiles(requestedRoot) {
  const env = sanitizeGitChildEnv(process.env);
  const root = canonicalRoot(requestedRoot, env);
  const listing = runGit(root, GIT_LIST_ARGS, env, 'git-visible-list-failed');
  const parsedRecords = parseGitLsFilesRecords(listing, {
    rawPathExists: candidate => rawListingPathExists(root, candidate),
  });
  const canonicalIdentities = new Set();
  const records = [];

  for (const parsed of parsedRecords) {
    if (parsed.mode === '120000') {
      fail('git-visible-mode-symlink');
    }
    if (parsed.mode === '160000') {
      fail('git-visible-mode-gitlink');
    }
    if (parsed.tracked && !REGULAR_FILE_MODES.has(parsed.mode)) {
      fail('git-visible-mode-unsupported');
    }

    const entry = inspectEntryPath(root, parsed.relativePath, parsed.tracked);
    if (entry === null) {
      continue;
    }
    const canonicalIdentity = pathIdentity(entry.canonicalPath);
    if (canonicalIdentities.has(canonicalIdentity)) {
      fail('git-visible-path-duplicate');
    }
    canonicalIdentities.add(canonicalIdentity);
    records.push(Object.freeze({
      relativePath: parsed.relativePath,
      mode: parsed.mode,
      tracked: parsed.tracked,
      readBuffer: () => readVerifiedBuffer(root, entry),
    }));
  }

  return records.sort((left, right) => ordinalCompare(left.relativePath, right.relativePath));
}

module.exports = {
  GitVisibleWorktreeError,
  getGitVisibleErrorCode,
  sanitizeGitChildEnv,
  parseGitLsFilesRecords,
  listGitVisibleWorktreeFiles,
};
