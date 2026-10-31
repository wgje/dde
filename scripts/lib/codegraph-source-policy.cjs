'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_POLICY_VERSION = 1;

const EXCLUDED_DIRECTORY_NAMES = Object.freeze([
  '.angular',
  '.cache',
  '.codegraph',
  '.feedback_images',
  '.git',
  '.gradle',
  '.next',
  '.nuxt',
  '.tmp',
  '.turbo',
  '.worktrees',
  'build',
  'cache',
  'coverage',
  'dist',
  'dist-ssr',
  'logs',
  'node_modules',
  'out',
  'playwright-report',
  'temp',
  'test-results',
  'tmp',
]);

const SOURCE_POLICY_DEFINITION = Object.freeze({
  schemaVersion: 1,
  version: SOURCE_POLICY_VERSION,
  excludedDirectories: EXCLUDED_DIRECTORY_NAMES,
  artifactSuffixes: Object.freeze([
    '.bak', '.log', '.map', '.swp', '.temp', '.tmp', '.tsbuildinfo',
  ]),
  packagedPatterns: Object.freeze(['*.min.js', '*.min.css']),
  sourceFamilies: Object.freeze([
    'typescript',
    'javascript',
    'angular-template',
    'angular-style',
    'sql',
    'supabase',
    'android-kotlin',
    'android-xml',
    'agent-instructions',
    'context7-contract',
    'codegraph-contract',
    'toolchain-contract',
  ]),
});

const EXCLUDED_DIRECTORY_SET = new Set(EXCLUDED_DIRECTORY_NAMES);
const SOURCE_POLICY_DIGEST = sha256(canonicalJson(SOURCE_POLICY_DEFINITION));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort(compareOrdinal)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRepositoryPath(relativePath) {
  const normalized = String(relativePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return normalized;
}

function isSourceDirectoryExcluded(relativePath) {
  const normalized = normalizeRepositoryPath(relativePath);
  if (!normalized) return false;
  return normalized
    .split('/')
    .some(segment => EXCLUDED_DIRECTORY_SET.has(segment.toLowerCase()));
}

function isPackagedOrTemporaryArtifact(fileName) {
  const lower = fileName.toLowerCase();
  return SOURCE_POLICY_DEFINITION.artifactSuffixes.some(suffix => lower.endsWith(suffix))
    || SOURCE_POLICY_DEFINITION.packagedPatterns.some(pattern => (
      pattern.startsWith('*')
      && !pattern.slice(1).includes('*')
      && lower.endsWith(pattern.slice(1))
    ));
}

function classifySourcePath(relativePath) {
  const normalized = normalizeRepositoryPath(relativePath);
  if (!normalized || isSourceDirectoryExcluded(normalized)) return null;
  const lower = normalized.toLowerCase();
  const fileName = lower.slice(lower.lastIndexOf('/') + 1);
  if (isPackagedOrTemporaryArtifact(fileName)) return null;

  if (fileName === 'agents.md') return 'agent-instructions';
  if (lower === '.codex/config.toml') return 'codegraph-config';
  if (/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(fileName)) {
    return 'toolchain-contract';
  }
  if (lower.startsWith('docs/codegraph-nanoflow-') && /\.(?:md|json)$/.test(lower)) {
    return 'codegraph-contract';
  }
  if (lower.includes('context7') && /\.(?:[cm]?[jt]sx?|json|md|toml|ya?ml)$/.test(lower)) {
    return 'context7-contract';
  }
  if (lower.startsWith('supabase/functions/') && /\.[cm]?[jt]sx?$/.test(lower)) {
    return 'supabase-edge-function';
  }
  if (lower.startsWith('supabase/') && lower.endsWith('.sql')) return 'supabase-sql';
  if (lower.startsWith('supabase/') && /\.(?:json|toml|ya?ml)$/.test(lower)) return 'supabase-contract';
  if (lower.startsWith('android/') && /\.kts?$/.test(lower)) return 'android-kotlin';
  if (lower.startsWith('android/') && lower.endsWith('.xml')) return 'android-xml';
  if (/\.(?:ts|tsx|mts|cts)$/.test(lower)) return 'typescript';
  if (/\.(?:js|jsx|mjs|cjs)$/.test(lower)) return 'javascript';
  if (lower.endsWith('.html')) return 'angular-template';
  if (/\.(?:css|scss|sass|less)$/.test(lower)) return 'angular-style';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.xml')) return 'xml-contract';
  return null;
}

function assertNoWindowsCaseCollisions(relativePaths) {
  const firstByFoldedPath = new Map();
  for (const relativePath of relativePaths) {
    const normalized = normalizeRepositoryPath(relativePath);
    if (!normalized) throw new Error(`source-policy-invalid-path: ${relativePath}`);
    const folded = normalized.toLowerCase();
    const first = firstByFoldedPath.get(folded);
    if (first !== undefined && first !== normalized) {
      throw new Error(`source-policy-path-case-collision: ${first} <> ${normalized}`);
    }
    firstByFoldedPath.set(folded, normalized);
  }
}

function listSourcePolicyFiles(projectRoot) {
  const root = path.resolve(projectRoot);
  const files = [];

  function visit(directory, relativeDirectory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isSourceDirectoryExcluded(relativePath)) visit(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const role = classifySourcePath(relativePath);
      if (role) files.push({ path: relativePath, role });
    }
  }

  visit(root, '');
  files.sort((left, right) => compareOrdinal(left.path, right.path));
  assertNoWindowsCaseCollisions(files.map(entry => entry.path));
  return files;
}

function statNanoseconds(stats, field) {
  const nanoseconds = stats[`${field}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds.toString();
  return (stats[`${field}Ms`] * 1_000_000n).toString();
}

function readStableSourceFile(projectRoot, source) {
  const filePath = path.join(projectRoot, ...source.path.split('/'));
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.size !== after.size
      || statNanoseconds(before, 'mtime') !== statNanoseconds(after, 'mtime')
      || statNanoseconds(before, 'ctime') !== statNanoseconds(after, 'ctime')) {
      throw new Error(`source-policy-file-changed-during-read: ${source.path}`);
    }
    if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`source-policy-file-too-large: ${source.path}`);
    }
    return {
      bytes,
      size: Number(after.size),
      mtimeNs: statNanoseconds(after, 'mtime'),
      ctimeNs: statNanoseconds(after, 'ctime'),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeDocumentInput(bytes, role) {
  if (role !== 'agent-instructions' && role !== 'codegraph-contract') return bytes;
  const normalized = bytes.toString('utf8')
    .replace(
      /<!--\s*nanoflow-derived:start\s*-->[\s\S]*?<!--\s*nanoflow-derived:end\s*-->/gi,
      '<!-- nanoflow-derived -->',
    )
    .replace(/<!--\s*nanoflow-generation:[^>]*-->/gi, '<!-- nanoflow-generation -->');
  return Buffer.from(normalized, 'utf8');
}

function digestProjection(label, projection) {
  return sha256(canonicalJson({
    schemaVersion: 1,
    sourcePolicyVersion: SOURCE_POLICY_VERSION,
    sourcePolicyDigest: SOURCE_POLICY_DIGEST,
    label,
    entries: projection,
  }));
}

function buildSourceManifest(projectRoot) {
  const entries = listSourcePolicyFiles(projectRoot).map(source => {
    const file = readStableSourceFile(projectRoot, source);
    return {
      path: source.path,
      role: source.role,
      size: file.size,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs,
      sha256: sha256(file.bytes),
      inputSha256: sha256(normalizeDocumentInput(file.bytes, source.role)),
    };
  });
  const metadataDigest = digestProjection('metadata', entries.map(({
    path: sourcePath, role, size, mtimeNs, ctimeNs,
  }) => ({ path: sourcePath, role, size, mtimeNs, ctimeNs })));
  const contentDigest = digestProjection('content', entries.map(({
    path: sourcePath, sha256: contentSha256,
  }) => ({ path: sourcePath, sha256: contentSha256 })));
  const inputDigest = digestProjection('input', entries.map(({
    path: sourcePath, inputSha256,
  }) => ({ path: sourcePath, inputSha256 })));
  const sourceManifestDigest = digestProjection('manifest', entries);
  return {
    schemaVersion: 1,
    sourcePolicyVersion: SOURCE_POLICY_VERSION,
    sourcePolicyDigest: SOURCE_POLICY_DIGEST,
    sourceManifestDigest,
    metadataDigest,
    contentDigest,
    inputDigest,
    entries,
  };
}

const SOURCE_POLICY_V2_VERSION = 2;
const V2_ROOT_CONTRACT_PATH = path.resolve(__dirname, '../contracts/codegraph-read-identity-v2.json');
const V2_COMPANION_CONTRACT_PATH = path.resolve(
  __dirname,
  '../contracts/codegraph-read-identity-v2-companion.json',
);
const V2_DOMAIN_PREFIX = Buffer.from('CG2F3\0', 'ascii');

function canonicalJsonV4(value) {
  return canonicalJson(value);
}

function uint32Bytes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError('SOURCE_POLICY_LIMIT');
  }
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function uint64Bytes(value) {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) {
    throw new TypeError('SOURCE_POLICY_LIMIT');
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
}

function fieldV3(fields) {
  if (!Array.isArray(fields) || fields.length > 0xffffffff) throw new TypeError('SOURCE_POLICY_LIMIT');
  const chunks = [V2_DOMAIN_PREFIX, uint32Bytes(fields.length)];
  const names = new Set();
  for (const [name, value] of fields) {
    if (typeof name !== 'string' || !/^[\x21-\x7e]+$/.test(name) || names.has(name)) {
      throw new TypeError('SOURCE_POLICY_PROJECTION');
    }
    names.add(name);
    const nameBytes = Buffer.from(name, 'ascii');
    const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    chunks.push(uint32Bytes(nameBytes.length), nameBytes, uint64Bytes(BigInt(valueBytes.length)), valueBytes);
  }
  return Buffer.concat(chunks);
}

function fieldV3Digest(fields) {
  return sha256(fieldV3(fields));
}

function lowerAscii(value) {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function ordinalIgnoreCaseEquals(left, right) {
  return lowerAscii(left) === lowerAscii(right);
}

function ordinalIgnoreCaseStartsWith(value, prefix) {
  return lowerAscii(value.slice(0, prefix.length)) === lowerAscii(prefix);
}

function ordinalIgnoreCaseEndsWith(value, suffix) {
  return lowerAscii(value.slice(-suffix.length)) === lowerAscii(suffix);
}

function normalizeSourcePolicyV2Path(relativePath) {
  if (typeof relativePath !== 'string' || relativePath !== relativePath.normalize('NFC')) return null;
  if (!relativePath || Buffer.byteLength(relativePath, 'utf8') > 32760
    || relativePath.includes('\0') || relativePath.includes('\\')
    || relativePath.startsWith('/') || relativePath.endsWith('/') || relativePath.includes('//')) return null;
  const components = relativePath.split('/');
  if (components.length > 100) return null;
  for (const component of components) {
    if (!component || component === '.' || component === '..' || Buffer.byteLength(component, 'utf8') > 255) {
      return null;
    }
  }
  return relativePath;
}

function parseDelimitedRows(chunks, fields) {
  const rows = chunks.join(';').split(';').filter(Boolean).map(row => row.split('|'));
  if (rows.some(row => row.length !== fields)) throw new TypeError('SOURCE_POLICY_PROJECTION');
  return rows;
}

function loadSourcePolicyV2Contracts() {
  const rootBytes = fs.readFileSync(V2_ROOT_CONTRACT_PATH);
  const companionBytes = fs.readFileSync(V2_COMPANION_CONTRACT_PATH);
  const rootText = rootBytes.toString('utf8');
  const companionText = companionBytes.toString('utf8');
  if (!Buffer.from(rootText, 'utf8').equals(rootBytes) || !Buffer.from(companionText, 'utf8').equals(companionBytes)) {
    throw new TypeError('SOURCE_POLICY_CONTENT');
  }
  const root = JSON.parse(rootText);
  const companion = JSON.parse(companionText);
  if (root.contractRevision !== 41 || root.pathPolicy?.pathPolicyId !== 'CG2-PATH-POLICY/3'
    || companion.pathPolicy?.pathPolicyId !== root.pathPolicy.pathPolicyId) {
    throw new TypeError('SOURCE_POLICY_PROJECTION');
  }
  return { companion, companionBytes, root, rootBytes };
}

function matchesV2FilenameGlob(fileName, pattern) {
  if (typeof pattern !== 'string' || /[^\x20-\x7e]/.test(pattern)) throw new TypeError('SOURCE_POLICY_ROLE');
  let fileIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let restartIndex = 0;
  while (fileIndex < fileName.length) {
    const token = pattern[patternIndex];
    if (token === '?' || (token && ordinalIgnoreCaseEquals(token, fileName[fileIndex]))) {
      fileIndex += 1;
      patternIndex += 1;
    } else if (token === '*') {
      starIndex = patternIndex++;
      restartIndex = fileIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      fileIndex = ++restartIndex;
    } else return false;
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

function sourcePolicyV2Classifier() {
  const { companion, root } = loadSourcePolicyV2Contracts();
  const classifier = companion.classifier;
  const excludedDirectories = classifier.excludedDirectoriesCsvChunks.join('').split(',');
  const suffixRoleRows = parseDelimitedRows(classifier.roleTokenSet.suffixRoleRows, 3);
  const ruleVersion = sha256(Buffer.from(canonicalJsonV4(classifier), 'utf8'));
  const policyDefinition = {
    excludedDirectories,
    matchSemantics: classifier.matchSemantics,
    pathPolicyId: root.pathPolicy.pathPolicyId,
    roleTokenSet: classifier.roleTokenSet,
    ruleVersion,
  };
  return Object.freeze({ classifier, excludedDirectories, policyDefinition, root, ruleVersion, suffixRoleRows });
}

function classifySourcePolicyV2Path(relativePath) {
  const normalized = normalizeSourcePolicyV2Path(relativePath);
  if (!normalized) throw new TypeError('SOURCE_POLICY_PATH_INVALID');
  const definition = sourcePolicyV2Classifier();
  const components = normalized.split('/');
  const fileName = components.at(-1);
  if (components.some(component => definition.excludedDirectories
    .some(excluded => ordinalIgnoreCaseEquals(component, excluded)))) return { class: 'EXCLUDE', role: 'NONE' };
  if (['.bak', '.log', '.map', '.swp', '.temp', '.tmp', '.tsbuildinfo']
    .some(suffix => ordinalIgnoreCaseEndsWith(fileName, suffix))
    || ['*.min.js', '*.min.css'].some(pattern => matchesV2FilenameGlob(fileName, pattern))) {
    return { class: 'EXCLUDE', role: 'NONE' };
  }
  if (ordinalIgnoreCaseEquals(fileName, 'agents.md')) return { class: 'INCLUDE', role: 'AGENT_INSTRUCTIONS' };
  if (ordinalIgnoreCaseEquals(normalized, '.codex/config.toml')) return { class: 'INCLUDE', role: 'CODEGRAPH_CONFIG' };
  if (['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
    .some(name => ordinalIgnoreCaseEquals(fileName, name))) return { class: 'INCLUDE', role: 'TOOLCHAIN_CONTRACT' };
  if (ordinalIgnoreCaseStartsWith(normalized, 'docs/codegraph-nanoflow-')
    && (ordinalIgnoreCaseEndsWith(fileName, '.md') || ordinalIgnoreCaseEndsWith(fileName, '.json'))) {
    return { class: 'INCLUDE', role: 'CODEGRAPH_CONTRACT' };
  }
  if (components.some(component => ordinalIgnoreCaseEquals(component, 'context7'))
    && /\.(?:cjs|mjs|js|ts|tsx|json|md|toml|yml|yaml)$/i.test(fileName)) {
    return { class: 'INCLUDE', role: 'CONTEXT7_CONTRACT' };
  }
  if (ordinalIgnoreCaseStartsWith(normalized, 'supabase/functions/') && /\.(?:cjs|mjs|js|ts|tsx)$/i.test(fileName)) {
    return { class: 'INCLUDE', role: 'SUPABASE_EDGE_FUNCTION' };
  }
  if (ordinalIgnoreCaseStartsWith(normalized, 'supabase/')) {
    if (ordinalIgnoreCaseEndsWith(fileName, '.sql')) return { class: 'INCLUDE', role: 'SUPABASE_SQL' };
    if (/\.(?:json|toml|yml|yaml)$/i.test(fileName)) return { class: 'INCLUDE', role: 'SUPABASE_CONTRACT' };
  }
  if (ordinalIgnoreCaseStartsWith(normalized, 'android/')) {
    if (/\.kts?$/i.test(fileName)) return { class: 'INCLUDE', role: 'ANDROID_KOTLIN' };
    if (ordinalIgnoreCaseEndsWith(fileName, '.xml')) return { class: 'INCLUDE', role: 'ANDROID_XML' };
  }
  for (const [suffix, className, role] of definition.suffixRoleRows) {
    if (ordinalIgnoreCaseEndsWith(fileName, suffix)) return { class: className, role };
  }
  return { class: 'EXCLUDE', role: 'EXCLUDE_UNCLASSIFIED' };
}

function deriveSourcePolicyV2() {
  const definition = sourcePolicyV2Classifier();
  const policyDefinitionDigest = fieldV3Digest([
    ['domain', Buffer.from('policy-definition-v4', 'ascii')],
    ['matchSemantics', Buffer.from(canonicalJsonV4(definition.policyDefinition.matchSemantics), 'utf8')],
    ['policyDefinition', Buffer.from(canonicalJsonV4(definition.policyDefinition), 'utf8')],
  ]);
  return Object.freeze({
    policyDefinition: definition.policyDefinition,
    policyDefinitionDigest,
    ruleVersion: definition.ruleVersion,
  });
}

function sourcePolicyV2Failure(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function v2Hex(value, length) {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
}

function v2Decimal(value, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try { return BigInt(value) <= BigInt(maximum); } catch { return false; }
}

function exactV2Keys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function deriveExact15PathSet() {
  const { root } = loadSourcePolicyV2Contracts();
  const rows = root.pathSet?.rows;
  if (!Array.isArray(rows) || rows.length !== 15 || rows.some((row, index) => row.row !== String(index + 1).padStart(2, '0'))) {
    return sourcePolicyV2Failure('SOURCE_POLICY_SCOPE_GAP');
  }
  const recordFields = root.pathSet.digestRecordFields;
  if (canonicalJsonV4(recordFields) !== canonicalJsonV4(['row', 'path', 'owner', 'status', 'encoding', 'cap'])) {
    return sourcePolicyV2Failure('SOURCE_POLICY_PROJECTION');
  }
  const normalizedRows = rows.map(row => {
    if (!exactV2Keys(row, recordFields) || typeof normalizeSourcePolicyV2Path(row.path) !== 'string') {
      return sourcePolicyV2Failure('SOURCE_POLICY_SCOPE_GAP');
    }
    return Object.freeze({ ...row });
  });
  return Object.freeze({
    digest: fieldV3Digest([
      ['domain', Buffer.from('exact15-path-set-v3', 'ascii')],
      ['rows', Buffer.from(canonicalJsonV4(normalizedRows), 'utf8')],
    ]),
    rows: Object.freeze(normalizedRows),
  });
}

function validateExact15NMinusOneWitness(witness) {
  const { root } = loadSourcePolicyV2Contracts();
  const schema = root.pathSet?.candidateUniverse?.negativeWitnessSchema;
  if (!schema || !exactV2Keys(witness, schema.requiredFields) || witness.witnessVersion !== 'EXACT15-NW/2'
    || witness.generatedHeaderExcluded !== true || !Array.isArray(witness.extraMutablePaths)
    || witness.extraMutablePaths.length !== 0 || !Array.isArray(witness.candidateRows)
    || !Array.isArray(witness.removalResults) || !v2Hex(witness.repositoryPathsDigest, 64)
    || !v2Decimal(witness.trackedPathCount, 0xffffffffffffffffn)) {
    return sourcePolicyV2Failure('SOURCE_POLICY_SCOPE_GAP');
  }
  const expectedRows = deriveExact15PathSet().rows.map(row => row.row);
  const expectedRemovals = root.pathSet.candidateUniverse.removalResults;
  if (canonicalJsonV4(witness.candidateRows) !== canonicalJsonV4(expectedRows)
    || canonicalJsonV4(witness.removalResults) !== canonicalJsonV4(expectedRemovals)) {
    return sourcePolicyV2Failure('SOURCE_POLICY_SCOPE_GAP');
  }
  return true;
}

function strictV2DecodedBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    return sourcePolicyV2Failure('SOURCE_POLICY_CONTENT');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return sourcePolicyV2Failure('SOURCE_POLICY_CONTENT');
  return bytes;
}

function rawEntryDigestV2(entry, session) {
  const bytes = strictV2DecodedBytes(entry.decodedBytesBase64);
  if (!v2Decimal(entry.entryIndex, 2047n) || !v2Decimal(entry.size, 100632000n)
    || entry.size !== entry.decodedLength || Number(entry.size) !== bytes.length
    || !v2Hex(entry.sha256, 64) || sha256(bytes) !== entry.sha256
    || typeof normalizeSourcePolicyV2Path(entry.relativePath) !== 'string') {
    return sourcePolicyV2Failure('SOURCE_POLICY_CONTENT');
  }
  return fieldV3Digest([
    ['domain', Buffer.from('raw-entry-v3', 'ascii')],
    ['rootIdentity', Buffer.from(session.rootIdentity, 'ascii')],
    ['snapshotId', Buffer.from(session.snapshotId, 'ascii')],
    ['sessionId', Buffer.from(session.sessionId, 'ascii')],
    ['entryIndex', Buffer.from(entry.entryIndex, 'ascii')],
    ['relativePath', Buffer.from(entry.relativePath, 'utf8')],
    ['identity', Buffer.from(canonicalJsonV4(entry.identity), 'utf8')],
    ['attestation', Buffer.from(canonicalJsonV4(entry.attestation), 'utf8')],
    ['size', Buffer.from(entry.size, 'ascii')],
    ['decodedBytes', bytes],
  ]);
}

function projectCapturedSourcePolicyV2(session, initialCensus, capturedEntries, finalCensus, chunkItems) {
  if (!session || !v2Hex(session.rootIdentity, 64) || !v2Hex(session.snapshotId, 32)
    || !v2Hex(session.sessionId, 32) || !Array.isArray(initialCensus) || !Array.isArray(capturedEntries)
    || !Array.isArray(finalCensus) || !Array.isArray(chunkItems)) return sourcePolicyV2Failure('SOURCE_POLICY_COVERAGE');
  const count = capturedEntries.length;
  if (count > 2048 || initialCensus.length !== count || finalCensus.length !== count
    || chunkItems.length !== count) return sourcePolicyV2Failure('SOURCE_POLICY_COVERAGE');
  const rawEntryDigests = [];
  const projectionEntries = [];
  const metadataRecords = [];
  const contentRecords = [];
  const uniquePaths = new Set();
  for (let index = 0; index < count; index += 1) {
    const entry = capturedEntries[index];
    const tuple = {
      attestation: entry?.attestation,
      entryIndex: entry?.entryIndex,
      identity: entry?.identity,
      relativePath: entry?.relativePath,
      sha256: entry?.sha256,
      size: entry?.size,
    };
    if (entry?.entryIndex !== String(index) || canonicalJsonV4(initialCensus[index]) !== canonicalJsonV4(tuple)
      || canonicalJsonV4(finalCensus[index]) !== canonicalJsonV4(tuple)
      || canonicalJsonV4(chunkItems[index]) !== canonicalJsonV4(tuple)) {
      return sourcePolicyV2Failure('SOURCE_POLICY_COVERAGE');
    }
    const foldedPath = lowerAscii(entry.relativePath);
    if (uniquePaths.has(foldedPath)) return sourcePolicyV2Failure('SOURCE_POLICY_PATH_DUPLICATE');
    uniquePaths.add(foldedPath);
    const rawEntryDigest = rawEntryDigestV2(entry, session);
    rawEntryDigests.push(rawEntryDigest);
    const classification = classifySourcePolicyV2Path(entry.relativePath);
    projectionEntries.push(Object.freeze({
      class: classification.class,
      entryIndex: entry.entryIndex,
      path: entry.relativePath,
      role: classification.role,
      sha256: entry.sha256,
      size: entry.size,
    }));
    metadataRecords.push(Object.freeze({
      attestation: entry.attestation,
      entryIndex: entry.entryIndex,
      identity: entry.identity,
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      size: entry.size,
    }));
    contentRecords.push(Object.freeze({ entryIndex: entry.entryIndex, relativePath: entry.relativePath, rawEntryDigest }));
  }
  const policy = deriveSourcePolicyV2();
  const pathSet = deriveExact15PathSet();
  const capturedRawDigest = fieldV3Digest([
    ['domain', Buffer.from('captured-raw-v3', 'ascii')],
    ['rootIdentity', Buffer.from(session.rootIdentity, 'ascii')],
    ['snapshotId', Buffer.from(session.snapshotId, 'ascii')],
    ['sessionId', Buffer.from(session.sessionId, 'ascii')],
    ['entryCount', Buffer.from(String(count), 'ascii')],
    ['rawEntryDigests', Buffer.from(canonicalJsonV4(rawEntryDigests), 'utf8')],
  ]);
  const metadataDigest = fieldV3Digest([
    ['domain', Buffer.from('metadata-v3', 'ascii')],
    ['records', Buffer.from(canonicalJsonV4(metadataRecords), 'utf8')],
  ]);
  const contentDigest = fieldV3Digest([
    ['domain', Buffer.from('content-v3', 'ascii')],
    ['records', Buffer.from(canonicalJsonV4(contentRecords), 'utf8')],
  ]);
  const core = Object.freeze({ entries: projectionEntries, policyDefinitionDigest: policy.policyDefinitionDigest });
  const finalProjectionCoreDigest = fieldV3Digest([
    ['domain', Buffer.from('final-projection-core-v3', 'ascii')],
    ['capturedRawDigest', Buffer.from(capturedRawDigest, 'ascii')],
    ['contentDigest', Buffer.from(contentDigest, 'ascii')],
    ['metadataDigest', Buffer.from(metadataDigest, 'ascii')],
    ['policyDefinitionDigest', Buffer.from(policy.policyDefinitionDigest, 'ascii')],
    ['pathSetDigest', Buffer.from(pathSet.digest, 'ascii')],
    ['core', Buffer.from(canonicalJsonV4(core), 'utf8')],
  ]);
  const sourcePolicyDigest = fieldV3Digest([
    ['domain', Buffer.from('source-policy-v3', 'ascii')],
    ['policyDefinitionDigest', Buffer.from(policy.policyDefinitionDigest, 'ascii')],
    ['pathSetDigest', Buffer.from(pathSet.digest, 'ascii')],
    ['finalProjectionCoreDigest', Buffer.from(finalProjectionCoreDigest, 'ascii')],
  ]);
  return Object.freeze({
    capturedRawDigest,
    contentDigest,
    core,
    finalProjectionCoreDigest,
    metadataDigest,
    pathSetDigest: pathSet.digest,
    sourcePolicyDigest,
  });
}

module.exports = Object.freeze({
  SOURCE_POLICY_VERSION,
  SOURCE_POLICY_DEFINITION,
  SOURCE_POLICY_DIGEST,
  SOURCE_POLICY_V2_VERSION,
  canonicalJson,
  canonicalJsonV4,
  fieldV3,
  fieldV3Digest,
  normalizeRepositoryPath,
  normalizeSourcePolicyV2Path,
  isSourceDirectoryExcluded,
  classifySourcePath,
  classifySourcePolicyV2Path,
  deriveSourcePolicyV2,
  deriveExact15PathSet,
  validateExact15NMinusOneWitness,
  projectCapturedSourcePolicyV2,
  matchesV2FilenameGlob,
  assertNoWindowsCaseCollisions,
  listSourcePolicyFiles,
  buildSourceManifest,
});
