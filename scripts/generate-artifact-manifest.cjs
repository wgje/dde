#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  projectStats,
  requiredCacheableBrowserOutputs,
  isHashedMainPath,
  canonicalNgswHash,
  parseNgsw,
  validateNgswAssetEvidence,
  artifactIdentity,
  sameArtifactIdentity,
  transactionResidue,
  artifactRoot,
  verifyArtifactRoot,
  canonicalDigest,
} = require('./lib/artifact-stats-evidence.cjs');
const { validateOutput, publishOutput } = require('./lib/artifact-output-publication.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const REQUIRED_FILES = ['/_headers', '/index.html', '/launch.html', '/ngsw.json', '/version.json'];
const EXTERNAL_CANDIDATES = Object.freeze([
  ['.github/workflows/context7-refresh.yml', 'workflow'], ['.github/workflows/copilot-setup-steps.yml', 'workflow'],
  ['.github/workflows/database-hardening-gates.yml', 'workflow'], ['.github/workflows/deploy-cloudflare-pages-dry-run.yml', 'workflow'],
  ['.github/workflows/deploy-cloudflare-pages.yml', 'workflow'], ['.github/workflows/perf-and-resume-gates.yml', 'workflow'],
  ['.github/workflows/perf-nightly-audit.yml', 'workflow'], ['.github/workflows/supabase-logical-backup.yml', 'workflow'],
  ['.github/workflows/test-full-suite.yml', 'workflow'], ['.github/workflows/vercel-prebuilt-recovery.yml', 'workflow'],
  ['package.json', 'dependency'], ['scripts/generate-launch-html.cjs', 'dependency'],
  ['scripts/inject-modulepreload.cjs', 'dependency'], ['scripts/perf-no-regression-guard.cjs', 'dependency'],
  ['scripts/perf-startup-guard.cjs', 'dependency'], ['scripts/run-ng.cjs', 'dependency'],
  ['scripts/validate-launch-shared-markers.cjs', 'dependency'],
]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function attempt(code, action) {
  try { return action(); } catch (error) {
    if (String(error?.code).startsWith('artifact-evidence-')) throw error;
    fail(code);
  }
}
function ordinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hash(algorithm, bytes) { return crypto.createHash(algorithm).update(bytes).digest('hex'); }
function stableSharedJson(value) {
  if (Array.isArray(value)) return value.map(stableSharedJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSharedJson(value[key])]));
}
function sharedIdentityBytes(record) {
  if (record.requestPath !== '/ngsw.json' && record.requestPath !== '/version.json') return record.bytes;
  const value = attempt('artifact-evidence-shared-identity', () => JSON.parse(decode(record.bytes, 'artifact-evidence-shared-identity')));
  if (record.requestPath === '/ngsw.json') value.timestamp = 0;
  if (record.requestPath === '/version.json') value.buildTime = '<build-time>';
  return Buffer.from(JSON.stringify(stableSharedJson(value)), 'utf8');
}
function readCandidateCensus(repoRoot) {
  const candidates = EXTERNAL_CANDIDATES.map(([relativePath, kind]) => {
    const filePath = path.join(repoRoot, relativePath);
    const stat = attempt('artifact-evidence-candidate', () => fs.lstatSync(filePath));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('artifact-evidence-candidate');
    const bytes = attempt('artifact-evidence-candidate', () => fs.readFileSync(filePath));
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('artifact-evidence-candidate');
    const text = attempt('artifact-evidence-candidate', () => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const lines = text.split('\n');
    return {
      bytes: bytes.length, encoding: 'UTF8_NO_BOM', finalLF: bytes.at(-1) === 0x0a, kind,
      maxLine: Math.max(...lines.map(line => Buffer.byteLength(line.replace(/\r$/, ''), 'utf8'))),
      path: relativePath, physicalLF: (text.match(/\n/g) ?? []).length,
      role: 'EXTERNAL_DEPENDENCY_ONLY', sha256: hash('sha256', bytes),
    };
  });
  if (candidates.length !== 17 || new Set(candidates.map(candidate => candidate.path)).size !== 17) {
    fail('artifact-evidence-candidate-set');
  }
  return { candidateCount: candidates.length, candidateSetDigest: canonicalDigest(candidates), candidates };
}
function canonicalPath(fsImpl, filePath, code) {
  return attempt(code, () => (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(filePath));
}
function assertContained(root, candidate, code) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail(code);
}
function assertIdentity(stat) {
  artifactIdentity(stat);
}
function assertRegular(stat, linksCode = 'artifact-evidence-file-links') {
  if (!stat.isFile()) fail('artifact-evidence-entry-special');
  assertIdentity(stat);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) fail('artifact-evidence-file-identity');
  if (stat.nlink !== 1) fail(linksCode);
}
function observeOutput(fsImpl, outputPath, rootReal) {
  return validateOutput(fsImpl, outputPath, rootReal);
}
function captureFile(fsImpl, filePath, rootReal) {
  const before = attempt('artifact-evidence-file-unavailable', () => fsImpl.lstatSync(filePath));
  if (before.isSymbolicLink()) fail('artifact-evidence-entry-symlink');
  if (!before.isFile()) fail('artifact-evidence-entry-special');
  assertRegular(before);
  const fileReal = canonicalPath(fsImpl, filePath, 'artifact-evidence-file-realpath');
  assertContained(rootReal, fileReal, 'artifact-evidence-file-escape');
  const flags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0)
    | (fsImpl.constants.O_NONBLOCK || 0);
  const fd = attempt('artifact-evidence-file-open', () => fsImpl.openSync(filePath, flags));
  let first;
  let second;
  let bytes;
  let primary;
  try {
    first = fsImpl.fstatSync(fd);
    assertRegular(first);
    if (!sameArtifactIdentity(before, first)) fail('artifact-evidence-file-drift');
    bytes = Buffer.alloc(first.size);
    for (let offset = 0; offset < bytes.length;) {
      const read = fsImpl.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(read) || read <= 0) fail('artifact-evidence-short-read');
      offset += read;
    }
    if (fsImpl.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
      fail('artifact-evidence-file-drift');
    }
    second = fsImpl.fstatSync(fd);
    if (!sameArtifactIdentity(first, second)) fail('artifact-evidence-file-drift');
  } catch (error) {
    primary = String(error?.code).startsWith('artifact-evidence-')
      ? error : Object.assign(error, { code: 'artifact-evidence-read' });
  }
  let closeError;
  try { fsImpl.closeSync(fd); } catch (error) { closeError = error; }
  if (primary) {
    if (closeError) primary.cleanupCode = 'artifact-evidence-close';
    throw primary;
  }
  if (closeError) fail('artifact-evidence-close');
  const after = attempt('artifact-evidence-file-drift', () => fsImpl.lstatSync(filePath));
  if (!after.isFile() || !sameArtifactIdentity(second, after)
    || canonicalPath(fsImpl, filePath, 'artifact-evidence-file-drift') !== fileReal) {
    fail('artifact-evidence-file-drift');
  }
  return bytes;
}
const kindOf = (entry) => entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory'
  : entry.isFile() ? 'file' : 'special';
function scanDirectory(fsImpl, directory) {
  return attempt('artifact-evidence-directory', () => fsImpl.readdirSync(directory, { withFileTypes: true }))
    .map((entry) => ({ entry, name: entry.name, kind: kindOf(entry) }))
    .sort((left, right) => ordinal(left.name, right.name));
}
function captureBrowserTree(fsImpl, distDir, outputPath) {
  const rootObservation = artifactRoot(fsImpl, distDir, 'artifact-evidence-dist-root');
  const rootStat = rootObservation.stat;
  const rootReal = rootObservation.realPath;
  const records = [];
  const directories = [];
  let outputState = null;
  function visit(directory, before = attempt('artifact-evidence-directory', () => fsImpl.lstatSync(directory)),
    real = canonicalPath(fsImpl, directory, 'artifact-evidence-directory')) {
    if (!before.isDirectory()) fail('artifact-evidence-directory');
    assertIdentity(before);
    assertContained(rootReal, real, 'artifact-evidence-directory');
    const entries = scanDirectory(fsImpl, directory);
    directories.push({ directory, before, real, signature: entries.map(({ name, kind }) => `${kind}:${name}`) });
    for (const { name, kind } of entries) {
      if (name.includes('\\')) fail('artifact-evidence-entry-path');
      if (transactionResidue(name)) fail('artifact-evidence-output-residue');
      const full = path.join(directory, name);
      if (path.resolve(full) === path.resolve(outputPath)) {
        outputState = observeOutput(fsImpl, outputPath, rootReal);
      } else if (path.resolve(full) === path.resolve(`${outputPath}.lock`)) {
        fail('artifact-evidence-output-lock');
      } else if (name.startsWith(`${path.basename(outputPath)}.`)
        && /\.(?:tmp|bak|quarantine)(?:\.|$)/.test(name)) {
        fail('artifact-evidence-output-residue');
      } else if (kind === 'link') {
        fail('artifact-evidence-entry-symlink');
      } else if (kind === 'directory') {
        visit(full);
      } else if (kind === 'file') {
        const relative = path.relative(distDir, full).split(path.sep).join('/');
        records.push({ requestPath: `/${relative}`, bytes: captureFile(fsImpl, full, rootReal) });
      } else {
        fail('artifact-evidence-entry-special');
      }
    }
  }
  visit(distDir, rootStat, rootReal);
  for (const { directory, before, real, signature } of directories) {
    const current = scanDirectory(fsImpl, directory).map(({ name, kind }) => `${kind}:${name}`);
    const after = attempt('artifact-evidence-directory', () => fsImpl.lstatSync(directory));
    if (!after.isDirectory() || !sameArtifactIdentity(before, after)
      || canonicalPath(fsImpl, directory, 'artifact-evidence-directory') !== real
      || JSON.stringify(current) !== JSON.stringify(signature)) fail('artifact-evidence-directory');
  }
  verifyArtifactRoot(fsImpl, { ...rootObservation, path: distDir }, 'artifact-evidence-dist-root');
  return {
    records: records.sort((left, right) => ordinal(left.requestPath, right.requestPath)),
    outputState, rootPath: distDir, rootState: rootStat,
  };
}
function decode(bytes, code) { return attempt(code, () => new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function parseJson(record, code) {
  const value = attempt(code, () => JSON.parse(decode(record.bytes, code)));
  if (!isPlainObject(value)) fail(code);
  return value;
}
function parseHeaders(record) {
  const rules = [];
  let current = null;
  for (const raw of decode(record.bytes, 'artifact-evidence-headers').split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (raw.startsWith('/')) {
      if (raw !== raw.trim() || /\s/.test(raw) || rules.some((rule) => rule.pattern === raw)) {
        fail('artifact-evidence-headers');
      }
      current = { pattern: raw, headers: Object.create(null) };
      rules.push(current);
      continue;
    }
    if (!current || !/^[ \t]+\S/.test(raw)) fail('artifact-evidence-headers');
    const line = raw.trim();
    const removal = line.match(/^!\s+([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/);
    const header = line.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(\S(?:.*\S)?)$/);
    const name = (removal?.[1] ?? header?.[1])?.toLowerCase();
    if (!name || Object.hasOwn(current.headers, name)) fail('artifact-evidence-headers');
    current.headers[name] = removal ? '!' : header[2];
  }
  if (rules.length === 0) fail('artifact-evidence-headers');
  return rules;
}
function headersForPath(rules, requestPath) {
  const headers = Object.create(null);
  for (const rule of rules) {
    const pattern = rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp(`^${pattern}$`).test(requestPath)) Object.assign(headers, rule.headers);
  }
  return headers;
}
function validateHeaders(rules, mainPath) {
  for (const requestPath of ['/', '/index.html', '/launch.html', '/ngsw.json', '/version.json']) {
    const policy = headersForPath(rules, requestPath)['cache-control'] ?? '';
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(policy)) fail('artifact-evidence-headers');
  }
  const mainHeaders = headersForPath(rules, mainPath);
  if (!/(?:^|,)\s*immutable\s*(?:,|$)/i.test(mainHeaders['cache-control'] ?? '')
    || mainHeaders.link !== '!') fail('artifact-evidence-headers');
}
function requireVersion(record) {
  const version = parseJson(record, 'artifact-evidence-version');
  const nonblank = (name) => typeof version[name] === 'string' && version[name].trim().length > 0;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(version.gitSha ?? '')
    || !nonblank('environment') || !nonblank('appVersion') || !nonblank('deploymentTarget')
    || !nonblank('supabaseProjectAlias') || typeof version.sentryRelease !== 'string'
    || typeof version.buildTime !== 'string' || Number.isNaN(Date.parse(version.buildTime))
    || new Date(version.buildTime).toISOString() !== version.buildTime
    || !/^[a-f0-9]{64}$/.test(version.ngswHash ?? '')) fail('artifact-evidence-version');
  return version;
}
function validateNgsw(record, version, requiredPaths, byPath, requiredOutputs) {
  const ngsw = parseNgsw(record.bytes);
  const urls = new Set(ngsw.assetGroups.flatMap((group) => group.urls));
  if (canonicalNgswHash(ngsw) !== version.ngswHash) {
    fail('artifact-evidence-ngsw-digest');
  }
  validateNgswAssetEvidence(ngsw, byPath, (bytes) => hash('sha1', bytes), requiredOutputs);
  for (const requestPath of requiredPaths) {
    const expected = ngsw.hashTable[requestPath];
    if (!urls.has(requestPath) || !/^[a-f0-9]{40}$/.test(expected ?? '')
      || expected !== hash('sha1', byPath.get(requestPath).bytes)) {
      fail('artifact-evidence-ngsw-hash-table');
    }
  }
  return ngsw;
}
function readStats(fsImpl, repoRoot, byPath, mainPath) {
  const statsPath = path.join(repoRoot, 'dist', 'stats.json');
  let stat;
  try {
    stat = fsImpl.lstatSync(statsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('artifact-evidence-stats');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('artifact-evidence-stats');
  const rootReal = canonicalPath(fsImpl, repoRoot, 'artifact-evidence-stats');
  const stats = parseJson({ bytes: captureFile(fsImpl, statsPath, rootReal) }, 'artifact-evidence-stats');
  try { return projectStats({ stats, files: byPath, requiredOutput: mainPath }); }
  catch (error) {
    if (String(error?.code).startsWith('artifact-evidence-')) throw error;
    fail('artifact-evidence-stats');
  }
}
function contentType(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'manifest.webmanifest') return 'application/manifest+json; charset=utf-8';
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8', '.pb': 'application/octet-stream',
  };
  return types[path.extname(name)] ?? 'application/octet-stream';
}
function generateArtifactManifest(options = {}) {
  const fsImpl = options.fs ?? fs;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const distDir = options.distDir ?? path.join(repoRoot, 'dist', 'browser');
  const outputPath = options.outputPath ?? path.join(distDir, 'artifact-manifest.json');
  const snapshot = captureBrowserTree(fsImpl, distDir, outputPath);
  const records = snapshot.records;
  const byPath = new Map(records.map((record) => [record.requestPath, record]));
  for (const requestPath of REQUIRED_FILES) {
    const record = byPath.get(requestPath);
    if (!record) fail('artifact-evidence-required-missing');
    if (record.bytes.length === 0) fail('artifact-evidence-required-empty');
  }
  const mainPaths = records.map((record) => record.requestPath).filter(isHashedMainPath);
  if (mainPaths.length !== 1) fail('artifact-evidence-main-count');
  const mainPath = mainPaths[0];
  const rules = parseHeaders(byPath.get('/_headers'));
  validateHeaders(rules, mainPath);
  const version = requireVersion(byPath.get('/version.json'));
  const stats = readStats(fsImpl, repoRoot, byPath, mainPath);
  const ngsw = validateNgsw(
    byPath.get('/ngsw.json'), version, ['/index.html', '/launch.html', mainPath], byPath,
    stats ? requiredCacheableBrowserOutputs(stats, byPath) : undefined,
  );
  const candidateCensus = readCandidateCensus(repoRoot);
  const sharedFiles = records.map((record) => {
    const identityBytes = sharedIdentityBytes(record);
    return {
      path: record.requestPath,
      bytes: identityBytes.length,
      sha256: hash('sha256', identityBytes),
    };
  });
  const sharedIdentity = {
    readerReceiptId: 'SRC-B', stable: true, fileCount: sharedFiles.length,
    filesDigest: canonicalDigest(sharedFiles), candidateSetDigest: candidateCensus.candidateSetDigest,
  };
  const files = {};
  let totalBytes = 0;
  let rootJsCount = 0;
  let gojsFlowChunkBytes = 0;
  for (const record of records) {
    const name = record.requestPath.slice(1);
    const atRoot = !name.includes('/');
    const headers = headersForPath(rules, record.requestPath);
    totalBytes += record.bytes.length;
    if (atRoot && name.endsWith('.js')) rootJsCount += 1;
    if (atRoot && name.endsWith('.js') && !/^(main|polyfills|runtime)-/.test(name)) {
      const output = stats?.get(record.requestPath);
      const matched = stats
        ? Object.keys(output?.inputs ?? {}).some((input) => /node_modules\/gojs\/|^src\/app\/features\/flow\/|^src\/utils\/flow-/.test(input.replace(/\\/g, '/')))
        : /go\.Diagram|FlowViewComponent|FlowTemplate|flow-task|floating-tree/i
          .test(record.bytes.subarray(0, 256 * 1024).toString('utf8'));
      if (matched) gojsFlowChunkBytes += record.bytes.length;
    }
    files[record.requestPath] = {
      sha256: hash('sha256', record.bytes),
      size: record.bytes.length,
      contentType: contentType(name),
      cachePolicy: headers['cache-control'] ?? null,
    };
    if (record.requestPath === '/index.html' || record.requestPath === '/launch.html') {
      const html = decode(record.bytes, 'artifact-evidence-html');
      files[record.requestPath].modulepreload = [...html.matchAll(
        /<link[^>]+rel=["']?modulepreload["']?[^>]*href=["']?([^"'\s>]+)["']?/g,
      )].map((match) => match[1]).sort(ordinal);
    }
  }
  const manifestBase = {
    schemaVersion: 1,
    gitSha: version.gitSha,
    deploymentTarget: version.deploymentTarget,
    ngswHash: version.ngswHash,
    metrics: {
      fileCount: records.length, totalBytes, rootJsCount, headerRuleCount: rules.length,
      ngswAssetCount: ngsw.assetGroups.reduce((sum, group) => sum + group.urls.length, 0),
      gojsFlowChunkBytes, candidateCount: candidateCensus.candidateCount,
      candidateSetDigest: candidateCensus.candidateSetDigest, candidates: candidateCensus.candidates,
      sharedIdentity,
    },
    files,
  };
  const manifest = {
    ...manifestBase,
    metrics: { ...manifestBase.metrics, manifestDigest: canonicalDigest(manifestBase) },
  };
  const serialized = attempt('artifact-evidence-serialization', () => `${JSON.stringify(manifest, null, 2)}\n`);
  const rootReal = canonicalPath(fsImpl, distDir, 'artifact-evidence-output');
  publishOutput(fsImpl, outputPath, serialized, rootReal, snapshot.outputState,
    snapshot.rootPath, snapshot.rootState);
  return { manifest, outputPath };
}
function main() {
  try {
    const result = generateArtifactManifest();
    console.log(`✓ Wrote ${path.relative(REPO_ROOT, result.outputPath)}`);
    console.log('  ' + JSON.stringify(result.manifest.metrics));
  } catch (error) {
    const code = String(error?.code).startsWith('artifact-evidence-')
      ? error.code
      : 'artifact-evidence-unexpected';
    console.error(`artifact-manifest-failed:${code}`);
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { generateArtifactManifest, main, readCandidateCensus };
