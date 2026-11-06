'use strict';

const path = require('node:path');

const HASHED_ROOT_JS = /^\/[^/]+-[A-Z0-9]+\.js$/;
const HASHED_MAIN_JS = /^\/main-[A-Z0-9]+\.js$/;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function control(value) { return /[\u0000-\u001f\u007f]/.test(value); }
function artifactIdentity(stat, code = 'artifact-evidence-file-identity') {
  if (!stat || !Number.isFinite(stat.dev) || stat.dev <= 0 || !Number.isFinite(stat.ino)
    || stat.ino <= 0 || !Number.isSafeInteger(stat.size) || stat.size < 0
    || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.ctimeMs)
    || !Number.isFinite(stat.birthtimeMs)) fail(code);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}
function sameArtifactIdentity(left, right) {
  try {
    const a = artifactIdentity(left);
    const b = artifactIdentity(right);
    return Object.keys(a).every((key) => a[key] === b[key]);
  } catch { return false; }
}

function sameArtifactDirectoryIdentity(left, right) {
  try {
    const a = artifactIdentity(left);
    const b = artifactIdentity(right);
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
      && left.mode === right.mode;
  } catch { return false; }
}

function sameArtifactMovedIdentity(left, right) {
  try {
    const a = artifactIdentity(left);
    const b = artifactIdentity(right);
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size
      && a.mtimeMs === b.mtimeMs && a.birthtimeMs === b.birthtimeMs;
  } catch { return false; }
}

function transactionResidue(name) {
  return typeof name === 'string' && /(?:^|\.)(?:tmp|bak|quarantine|lock)(?:\.|$)/i.test(name);
}

function artifactRoot(fsImpl, directory, code = 'artifact-evidence-ngsw') {
  let stat;
  try { stat = fsImpl.lstatSync(directory); } catch { fail(code); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
  artifactIdentity(stat, code);
  let real;
  try { real = (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(directory); } catch { fail(code); }
  if (path.resolve(real) !== path.resolve(directory)) fail(code);
  return { stat, realPath: real };
}

function verifyArtifactRoot(fsImpl, observed, code = 'artifact-evidence-ngsw') {
  const current = artifactRoot(fsImpl, observed.path, code);
  if (current.realPath !== observed.realPath || !sameArtifactIdentity(current.stat, observed.stat)) fail(code);
  return current;
}

function scanArtifactResidue(fsImpl, directory) {
  const result = [];
  function walk(current) {
    let entries;
    try { entries = fsImpl.readdirSync(current, { withFileTypes: true }); } catch { fail('artifact-evidence-output-residue'); }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (transactionResidue(entry.name)) result.push({ path: full, name: entry.name });
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  }
  walk(directory);
  return result;
}

function contained(root, candidate, code) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code);
}

function normalized(value, output) {
  if (typeof value !== 'string' || !value || control(value)) fail('artifact-evidence-stats');
  if (output && value.includes('\\')) fail('artifact-evidence-stats');
  let result = output ? value : value.replace(/\\/g, '/');
  if (output) {
    if (result.startsWith('./')) result = result.slice(2);
    if (result.startsWith('dist/browser/')) result = result.slice('dist/browser/'.length);
  }
  if (path.posix.isAbsolute(result) || path.win32.isAbsolute(result) || /^[A-Za-z]:/.test(result)) {
    fail('artifact-evidence-stats');
  }
  const parts = result.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) fail('artifact-evidence-stats');
  return parts.join('/');
}

function outputPath(value) { return `/${normalized(value, true)}`; }
function inputPath(value) { return normalized(value, false); }
function isHashedMainPath(value) { return typeof value === 'string' && HASHED_MAIN_JS.test(value); }

function canonicalNgswUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || value.includes('?') || value.includes('#') || value.includes('%')
    || control(value) || value.trim() !== value) fail('artifact-evidence-ngsw-hash-table');
  const parts = value.slice(1).split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    fail('artifact-evidence-ngsw-hash-table');
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function digest(algorithm, bytes) {
  return require('node:crypto').createHash(algorithm).update(bytes).digest('hex');
}

function sha256(bytes) { return digest('sha256', bytes); }

function canonicalNgswHash(value) {
  if (!isPlainObject(value)) fail('artifact-evidence-ngsw');
  const copy = structuredClone(value);
  delete copy.timestamp;
  return digest('sha256', JSON.stringify(stableJson(copy)));
}

function decodeUtf8(bytes, code) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(code); }
}

function parseNgsw(bytes) {
  let value;
  try { value = JSON.parse(decodeUtf8(bytes, 'artifact-evidence-ngsw')); }
  catch (error) {
    if (String(error?.code).startsWith('artifact-evidence-')) throw error;
    fail('artifact-evidence-ngsw');
  }
  if (!isPlainObject(value) || !Array.isArray(value.assetGroups) || value.assetGroups.length === 0
    || !isPlainObject(value.hashTable)) fail('artifact-evidence-ngsw');
  const urls = new Set();
  for (const group of value.assetGroups) {
    if (!isPlainObject(group) || typeof group.name !== 'string' || !group.name.trim()
      || !Array.isArray(group.urls)) fail('artifact-evidence-ngsw');
    for (const raw of group.urls) {
      const url = canonicalNgswUrl(raw);
      if (urls.has(url)) fail('artifact-evidence-ngsw-hash-table');
      urls.add(url);
    }
  }
  for (const key of Object.keys(value.hashTable)) canonicalNgswUrl(key);
  return value;
}

function fileSize(file) {
  if (!file || typeof file !== 'object') return null;
  if (Number.isSafeInteger(file.size) && file.size >= 0) return file.size;
  if (Buffer.isBuffer(file.bytes)) return file.bytes.length;
  return null;
}

function fileMap(files) {
  const result = new Map();
  for (const [raw, value] of files instanceof Map ? files : Object.entries(files ?? {})) {
    const key = outputPath(raw.startsWith('/') ? raw.slice(1) : raw);
    if (result.has(key)) fail('artifact-evidence-stats');
    result.set(key, value);
  }
  return result;
}

function rawComponentCss(output, rawKeys, normalizedKeys, inputs) {
  const keys = [...rawKeys];
  const normalized = [...normalizedKeys];
  const rawCanonical = keys[0]?.replace(/\\/g, '/');
  if (output.entryPoint !== undefined || keys.length !== 1 || normalized.length !== 1
    || !inputs.has(normalized[0])) return false;
  if (rawCanonical?.startsWith('angular:styles/component:css;')) return true;
  return output['ng-component'] === true && /\.(?:css|scss)$/i.test(normalized[0]);
}

function imports(value) {
  if (!Array.isArray(value)) fail('artifact-evidence-stats');
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.path !== 'string' || typeof item.kind !== 'string'
      || (item.external !== undefined && typeof item.external !== 'boolean')
      || (item.original !== undefined && typeof item.original !== 'string')
      || control(item.path) || control(item.kind)) fail('artifact-evidence-stats');
  }
  return value;
}

function requiredCacheableBrowserOutputs(outputs, files) {
  return [...outputs.keys()]
    .filter((key) => (key.endsWith('.js') || key.endsWith('.css')) && files.has(key))
    .sort();
}

function validateNgswAssetEvidence(ngsw, byPath, hash, requiredOutputs = []) {
  if (!Object.hasOwn(ngsw, 'timestamp') || !Number.isSafeInteger(ngsw.timestamp)
    || ngsw.timestamp < 0 || ngsw.timestamp > Number.MAX_SAFE_INTEGER) fail('artifact-evidence-ngsw');
  const urls = new Set();
  for (const group of ngsw.assetGroups) {
    for (const raw of group.urls) {
      const url = canonicalNgswUrl(raw);
      if (urls.has(url)) fail('artifact-evidence-ngsw-hash-table');
      urls.add(url);
    }
  }
  const tableKeys = Object.keys(ngsw.hashTable);
  if (tableKeys.length !== urls.size) fail('artifact-evidence-ngsw-hash-table');
  for (const raw of tableKeys) {
    const url = canonicalNgswUrl(raw);
    const record = byPath.get(url);
    if (!urls.has(url) || !record || !/^[a-f0-9]{40}$/.test(ngsw.hashTable[raw])
      || ngsw.hashTable[raw] !== hash(record.bytes)) fail('artifact-evidence-ngsw-hash-table');
  }
  for (const url of urls) if (!byPath.has(url)) fail('artifact-evidence-ngsw-hash-table');
  for (const raw of requiredOutputs) {
    const url = canonicalNgswUrl(raw);
    const record = byPath.get(url);
    if (!urls.has(url) || !record || !/^[a-f0-9]{40}$/.test(ngsw.hashTable[url])
      || ngsw.hashTable[url] !== hash(record.bytes)) fail('artifact-evidence-ngsw-hash-table');
  }
}

function validateNgswPost(bytesOrValue, byPath, hash = (value) => digest('sha1', value), requiredOutputs) {
  const ngsw = Buffer.isBuffer(bytesOrValue) ? parseNgsw(bytesOrValue) : parseNgsw(Buffer.from(JSON.stringify(bytesOrValue)));
  validateNgswAssetEvidence(ngsw, byPath, hash, requiredOutputs);
  return ngsw;
}

function readBrowserFiles(fsImpl, directory) {
  const root = artifactRoot(fsImpl, directory);
  const files = new Map();
  function walk(current, relative = '', expected = null) {
    const before = expected ?? artifactRoot(fsImpl, current);
    const currentReal = before.realPath;
    const entries = fsImpl.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (transactionResidue(entry.name) || entry.name.includes('\\') || control(entry.name)) {
        fail('artifact-evidence-output-residue');
      }
      const full = path.join(current, entry.name);
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      let stat;
      try { stat = fsImpl.lstatSync(full); } catch { fail('artifact-evidence-ngsw'); }
      if (stat.isSymbolicLink()) fail('artifact-evidence-ngsw');
      if (stat.isDirectory()) walk(full, next);
      else if (!stat.isFile()) fail('artifact-evidence-ngsw');
      else {
        const real = (() => { try { return (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(full); } catch { fail('artifact-evidence-ngsw'); } })();
        contained(root.realPath, real, 'artifact-evidence-ngsw');
        let bytes;
        try { bytes = Buffer.from(fsImpl.readFileSync(full)); } catch { fail('artifact-evidence-ngsw'); }
        let after;
        try { after = fsImpl.lstatSync(full); } catch { fail('artifact-evidence-ngsw'); }
        if (!after.isFile() || !sameArtifactIdentity(stat, after)
          || (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(full) !== real) {
          fail('artifact-evidence-ngsw');
        }
        const key = `/${next}`;
        if (files.has(key)) fail('artifact-evidence-ngsw');
        files.set(key, { bytes, size: bytes.length, sha256: sha256(bytes), identity: artifactIdentity(after) });
      }
    }
    const after = artifactRoot(fsImpl, current);
    if (after.realPath !== currentReal || !sameArtifactIdentity(before.stat, after.stat)) {
      fail('artifact-evidence-ngsw');
    }
  }
  walk(directory, '', root);
  verifyArtifactRoot(fsImpl, { ...root, path: directory });
  return files;
}

function readStatsRequiredOutputs(fsImpl, directory, files) {
  const statsPath = path.join(path.dirname(directory), 'stats.json');
  let stat;
  try { stat = fsImpl.lstatSync(statsPath); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; fail('artifact-evidence-stats'); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('artifact-evidence-stats');
  let stats;
  try { stats = JSON.parse(decodeUtf8(fsImpl.readFileSync(statsPath), 'artifact-evidence-stats')); }
  catch (error) { if (String(error?.code).startsWith('artifact-evidence-')) throw error; fail('artifact-evidence-stats'); }
  return requiredCacheableBrowserOutputs(projectStats({ stats, files }), files);
}

function readNgswPost(fsImpl, directory, options = {}) {
  const files = readBrowserFiles(fsImpl, directory);
  const requiredOutputs = options.requiredOutputs ?? readStatsRequiredOutputs(fsImpl, directory, files);
  const source = options.value === undefined
    ? fsImpl.readFileSync(path.join(directory, 'ngsw.json')) : options.value;
  return validateNgswPost(source, files, (value) => digest('sha1', value), requiredOutputs);
}

function projectStats({ stats, files, requiredOutput } = {}) {
  if (!isPlainObject(stats) || !isPlainObject(stats.inputs) || !Object.keys(stats.inputs).length
    || !isPlainObject(stats.outputs) || !Object.keys(stats.outputs).length) fail('artifact-evidence-stats');
  const inputs = new Map();
  for (const [raw, value] of Object.entries(stats.inputs)) {
    const key = inputPath(raw);
    if (inputs.has(key) || !isPlainObject(value) || !safeCount(value.bytes)) fail('artifact-evidence-stats');
    imports(value.imports);
    inputs.set(key, value);
  }
  const outputs = new Map();
  const outputImports = new Map();
  const outputInputPaths = new Map();
  for (const [raw, value] of Object.entries(stats.outputs)) {
    const key = outputPath(raw);
    const isCssOutput = key.endsWith('.css');
    const hasValidExports = Array.isArray(value?.exports)
      ? value.exports.every((name) => typeof name === 'string')
      : isCssOutput && value?.exports === undefined;
    if (outputs.has(key) || !isPlainObject(value) || !safeCount(value.bytes)
      || !isPlainObject(value.inputs) || !hasValidExports
      || (value.entryPoint !== undefined && (typeof value.entryPoint !== 'string' || !value.entryPoint))) fail('artifact-evidence-stats');
    imports(value.imports);
    const contributionInputs = new Set();
    const rawInputs = Object.keys(value.inputs);
    for (const [input, contribution] of Object.entries(value.inputs)) {
      const keyInput = inputPath(input);
      if (contributionInputs.has(keyInput) || !inputs.has(keyInput) || !isPlainObject(contribution)
        || !safeCount(contribution.bytesInOutput) || contribution.bytesInOutput > value.bytes) fail('artifact-evidence-stats');
      contributionInputs.add(keyInput);
    }
    outputs.set(key, value);
    outputImports.set(key, value.imports);
    outputInputPaths.set(key, { raw: rawInputs, normalized: contributionInputs });
  }
  for (const [, value] of inputs) for (const item of imports(value.imports)) {
    if (item.external !== true && !inputs.has(inputPath(item.path))) fail('artifact-evidence-stats');
  }
  for (const [key, value] of outputs) for (const item of outputImports.get(key)) {
    if (item.external !== true && !outputs.has(outputPath(item.path))) fail('artifact-evidence-stats');
  }
  if (requiredOutput && !outputs.has(outputPath(requiredOutput.startsWith('/') ? requiredOutput.slice(1) : requiredOutput))) fail('artifact-evidence-stats-main');
  const physical = fileMap(files);
  for (const [key, value] of outputs) {
    const isJs = key.endsWith('.js');
    const isCss = key.endsWith('.css');
    if (!isJs && !isCss) continue;
    const file = physical.get(key);
    const inputInfo = outputInputPaths.get(key);
    if (!file) {
      if (isCss && rawComponentCss(value, inputInfo.raw, inputInfo.normalized, inputs)) continue;
      fail('artifact-evidence-stats-output');
    }
    if (fileSize(file) !== value.bytes) fail('artifact-evidence-stats-size');
  }
  const roots = new Set();
  for (const [key, value] of outputs) {
    if (value.entryPoint !== undefined) {
      if (!inputs.has(inputPath(value.entryPoint))) fail('artifact-evidence-stats');
      roots.add(key);
    }
  }
  const reachable = new Set(roots);
  const pending = [...roots];
  while (pending.length) {
    const key = pending.pop();
    for (const item of outputImports.get(key)) if (item.external !== true) {
      const target = outputPath(item.path);
      if (!reachable.has(target)) { reachable.add(target); pending.push(target); }
    }
  }
  for (const [key] of physical) if (HASHED_ROOT_JS.test(key)) {
    const output = outputs.get(key);
    if (!output || (Object.keys(output.inputs).length === 0 && output.entryPoint === undefined && !reachable.has(key))) fail('artifact-evidence-stats-output');
  }
  for (const [key, value] of outputs) if (key.endsWith('.js') && Object.keys(value.inputs).length === 0
    && value.entryPoint === undefined && !reachable.has(key)) fail('artifact-evidence-stats-output');
  return outputs;
}

module.exports = {
  artifactIdentity,
  sameArtifactIdentity,
  sameArtifactDirectoryIdentity,
  sameArtifactMovedIdentity,
  transactionResidue,
  artifactRoot,
  verifyArtifactRoot,
  scanArtifactResidue,
  contained,
  sha256,
  canonicalNgswHash,
  parseNgsw,
  projectStats,
  requiredCacheableBrowserOutputs,
  outputPath,
  inputPath,
  isHashedMainPath,
  validateNgswAssetEvidence,
  validateNgswPost,
  readNgswPost,
  readBrowserFiles, canonicalDigest: value => sha256(Buffer.from(JSON.stringify(stableJson(value)), 'utf8')),
};
