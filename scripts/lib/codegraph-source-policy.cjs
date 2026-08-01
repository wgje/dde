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
  artifactSuffixes: ['.bak', '.log', '.map', '.swp', '.temp', '.tmp', '.tsbuildinfo'],
  packagedPatterns: ['*.min.js', '*.min.css'],
  sourceFamilies: [
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
  ],
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
    || lower.endsWith('.min.js')
    || lower.endsWith('.min.css');
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

module.exports = {
  SOURCE_POLICY_VERSION,
  SOURCE_POLICY_DEFINITION,
  SOURCE_POLICY_DIGEST,
  normalizeRepositoryPath,
  isSourceDirectoryExcluded,
  classifySourcePath,
  assertNoWindowsCaseCollisions,
  listSourcePolicyFiles,
  buildSourceManifest,
};
