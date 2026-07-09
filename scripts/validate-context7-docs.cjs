#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const errors = [];
let workspacePathIndex = null;

const sourcePathScanExcludedDirs = new Set([
  '.angular',
  '.cache',
  '.codegraph',
  '.codex',
  '.git',
  '.idea',
  '.tmp',
  '.vercel',
  '.vscode',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp',
]);

const requiredFiles = [
  'context7.json',
  'llms.txt',
  'docs/context7/index.md',
  'docs/context7/README.md',
  'docs/context7/overview.md',
  'docs/context7/architecture.md',
  'docs/context7/data-model.md',
  'docs/context7/sync-offline.md',
  'docs/context7/feature-workflows.md',
  'docs/context7/api-edge-functions.md',
  'docs/context7/development.md',
  'docs/context7/operations-security.md',
  'docs/context7/agent-rules.md',
  'docs/context7/context7-maintenance.md',
  'docs/context7/source-map.md',
  'docs/context7/reference/configuration-reference.md',
  'docs/context7/reference/service-catalog.md',
  'docs/context7/reference/model-field-reference.md',
  'docs/context7/reference/supabase-schema-reference.md',
  'docs/context7/contracts/sync-contract.md',
  'docs/context7/contracts/security-contract.md',
  'docs/context7/contracts/ui-lifecycle-contract.md',
  'docs/context7/runbooks/sync-debugging.md',
  'docs/context7/runbooks/data-recovery.md',
  'docs/context7/runbooks/context7-publishing.md',
  'docs/context7/adr/0001-context7-canonical-corpus.md',
  'docs/context7/adr/0002-offline-first-lww-sync.md',
  'docs/context7/catalog.json',
  'docs/context7/glossary.md',
  'docs/context7/compatibility-matrix.md',
  'docs/context7/migration-playbook.md',
  'docs/context7/documentation-contribution.md',
  'docs/context7/01-getting-started/index.md',
  'docs/context7/01-getting-started/01-installation.md',
  'docs/context7/01-getting-started/02-project-structure.md',
  'docs/context7/01-getting-started/03-core-concepts.md',
  'docs/context7/01-getting-started/04-verification.md',
  'docs/context7/02-guides/index.md',
  'docs/context7/02-guides/ai-agents.md',
  'docs/context7/02-guides/sync-workflow.md',
  'docs/context7/02-guides/focus-parking-workflow.md',
  'docs/context7/02-guides/supabase-operations.md',
  'docs/context7/03-api-reference/index.md',
  'docs/context7/03-api-reference/stores.md',
  'docs/context7/03-api-reference/sync-services.md',
  'docs/context7/03-api-reference/models.md',
  'docs/context7/03-api-reference/edge-functions.md',
  'docs/context7/03-api-reference/configuration.md',
  'docs/context7/04-architecture/index.md',
  'docs/context7/04-architecture/runtime-architecture.md',
  'docs/context7/04-architecture/sync-architecture.md',
  'docs/context7/04-architecture/security-architecture.md',
  'docs/context7/04-architecture/ui-lifecycle.md',
  'docs/context7/05-file-conventions/index.md',
  'docs/context7/05-file-conventions/angular-files.md',
  'docs/context7/05-file-conventions/service-files.md',
  'docs/context7/05-file-conventions/supabase-files.md',
  'docs/context7/05-file-conventions/documentation-files.md',
  'docs/context7/06-errors/index.md',
  'docs/context7/06-errors/sync-errors.md',
  'docs/context7/06-errors/auth-security-errors.md',
  'docs/context7/06-errors/ui-runtime-errors.md',
  'docs/context7/07-examples/index.md',
  'docs/context7/07-examples/add-task-field.md',
  'docs/context7/07-examples/add-edge-function.md',
  'docs/context7/07-examples/add-context7-doc-page.md',
  'docs/context7/08-migration/index.md',
  'docs/context7/08-migration/versioning.md',
  'docs/context7/08-migration/schema-migrations.md',
  'docs/context7/08-migration/docs-migrations.md',
  'docs/context7/schemas/context7-doc-page.schema.json',
  'docs/context7/schemas/nanoflow-domain.schema.json',
  'docs/context7/quality/documentation-quality-gate.md',
  'docs/context7/quality/nextjs-parity-checklist.md',
  'scripts/validate-context7-docs.cjs',
  'scripts/contracts/check-context7-coupled-changes.cjs',
  '.github/workflows/context7-refresh.yml',
];

function walkFiles(relativeDir, predicate, output = []) {
  const absoluteDir = toAbs(relativeDir);
  if (!fs.existsSync(absoluteDir)) return output;
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const childRelative = path.join(relativeDir, entry.name).replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      walkFiles(childRelative, predicate, output);
    } else if (predicate(childRelative)) {
      output.push(childRelative);
    }
  }
  return output;
}

function collectWorkspacePaths(relativeDir = '.', output = []) {
  const absoluteDir = toAbs(relativeDir);
  if (!fs.existsSync(absoluteDir)) return output;

  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory() && sourcePathScanExcludedDirs.has(entry.name)) {
      continue;
    }

    const childRelative = path.join(relativeDir, entry.name).replaceAll(path.sep, '/').replace(/^\.\//, '');
    if (entry.isDirectory()) {
      output.push(`${childRelative}/`);
      collectWorkspacePaths(childRelative, output);
    } else {
      output.push(childRelative);
    }
  }

  return output;
}

function getWorkspacePathIndex() {
  workspacePathIndex ??= collectWorkspacePaths();
  return workspacePathIndex;
}

const discoveredContext7Files = walkFiles(
  'docs/context7',
  (file) => file.endsWith('.md') || file.endsWith('.json'),
).sort();
const canonicalDocs = discoveredContext7Files.filter((file) => file.endsWith('.md'));
const canonicalJson = discoveredContext7Files.filter((file) => file.endsWith('.json'));
const numberedCategoryMap = {
  gettingStarted: 'docs/context7/01-getting-started/index.md',
  guidesNextStyle: 'docs/context7/02-guides/index.md',
  apiReference: 'docs/context7/03-api-reference/index.md',
  architectureNextStyle: 'docs/context7/04-architecture/index.md',
  fileConventions: 'docs/context7/05-file-conventions/index.md',
  errors: 'docs/context7/06-errors/index.md',
  examples: 'docs/context7/07-examples/index.md',
  migrationAndVersioning: 'docs/context7/08-migration/index.md',
};

function toAbs(relativePath) {
  return path.join(root, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(toAbs(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(toAbs(relativePath), 'utf8');
}

function record(condition, message) {
  if (!condition) errors.push(message);
}

function validateRequiredFiles() {
  for (const file of requiredFiles) {
    record(exists(file), `Missing required file: ${file}`);
  }
}

function validateContext7Json() {
  if (!exists('context7.json')) return;

  let config;
  try {
    config = JSON.parse(readText('context7.json'));
  } catch (error) {
    errors.push(`context7.json is not valid JSON: ${error.message}`);
    return;
  }

  record(config.$schema === 'https://context7.com/schema/context7.json', 'context7.json must use the Context7 schema URL');
  record(config.projectTitle === 'NanoFlow', 'context7.json projectTitle must be NanoFlow');
  record(
    typeof config.description === 'string' && config.description.includes('Offline-first'),
    'context7.json description must describe the offline-first project identity',
  );
  record(Array.isArray(config.folders), 'context7.json folders must be an array');
  record(
    Array.isArray(config.folders) && config.folders.length === 1 && config.folders[0] === 'docs/context7',
    'context7.json must include only docs/context7 for Context7 parsing',
  );

  const excluded = new Set(Array.isArray(config.excludeFolders) ? config.excludeFolders : []);
  const requiredExclusions = [
    'node_modules',
    'dist',
    'coverage',
    'docs/archive',
    'docs/superpowers',
    'src',
    'supabase',
    'e2e',
    'test-results',
    '.worktrees',
  ];
  for (const folder of requiredExclusions) {
    record(excluded.has(folder), `context7.json excludeFolders must include ${folder}`);
  }

  const rules = Array.isArray(config.rules) ? config.rules.join('\n') : '';
  const requiredRuleNeedles = [
    'docs/context7',
    'index.md',
    'metadata',
    'source-map',
    'contracts',
    'runbooks',
    'reference',
    '01-getting-started',
    '08-migration',
    'API reference',
    'file conventions',
    'error reference',
    'examples',
    'crypto.randomUUID()',
    'offline-first',
    'updatedAt',
    'content',
    'Angular Signals',
    'GoJS',
    'MAX_SUBTREE_DEPTH',
    'Secrets',
  ];
  for (const needle of requiredRuleNeedles) {
    record(rules.includes(needle), `context7.json rules must mention ${needle}`);
  }
}

function stripAnchorAndDecode(target) {
  const withoutAnchor = target.split('#')[0];
  try {
    return decodeURI(withoutAnchor);
  } catch {
    return withoutAnchor;
  }
}

function normalizeLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (!target || target.startsWith('#')) return null;
  if (/^(https?:|mailto:|tel:)/i.test(target)) return null;
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1);
  }
  target = target.split(/\s+/)[0];
  target = stripAnchorAndDecode(target);
  return target || null;
}

function validateMarkdownLinks(relativeFile, options = {}) {
  if (!exists(relativeFile)) return;
  const text = readText(relativeFile);
  const baseDir = path.dirname(toAbs(relativeFile));
  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const target = normalizeLinkTarget(match[1]);
    if (!target) continue;
    if (options.onlyTargetsContaining && !target.includes(options.onlyTargetsContaining)) continue;

    const resolved = path.resolve(baseDir, target);
    const relativeResolved = path.relative(root, resolved).replaceAll(path.sep, '/');
    record(
      fs.existsSync(resolved),
      `${relativeFile} links to missing target: ${target} (${relativeResolved})`,
    );
  }
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(globPattern) {
  const normalized = globPattern.replaceAll('\\', '/');
  let pattern = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        pattern += '.*';
        i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else {
      pattern += escapeRegex(char);
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}

function sourcePathExists(sourcePath) {
  if (!sourcePath.includes('*')) {
    return exists(sourcePath);
  }

  const pattern = globToRegex(sourcePath);
  return getWorkspacePathIndex().some(file => pattern.test(file));
}

function extractSourcePaths(metadata) {
  const lines = metadata.split('\n');
  const sourcePaths = [];
  const sourceIndex = lines.findIndex(line => line.trim() === 'source_paths:');
  if (sourceIndex < 0) {
    return sourcePaths;
  }

  for (let index = sourceIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z_]+:/.test(line)) {
      break;
    }

    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      sourcePaths.push(item[1].replace(/^['"]|['"]$/g, ''));
    }
  }

  return sourcePaths;
}

function validateMarkdownMetadata(relativeFile, text) {
  record(text.startsWith('---\n'), `${relativeFile} must start with metadata frontmatter`);
  const end = text.indexOf('\n---', 4);
  record(end > 0, `${relativeFile} must close metadata frontmatter`);
  if (end <= 0) return;

  const metadata = text.slice(4, end);
  const requiredFields = ['title:', 'status:', 'audience:', 'last_verified:', 'source_paths:'];
  for (const field of requiredFields) {
    record(metadata.includes(field), `${relativeFile} metadata must include ${field}`);
  }
  record(/last_verified:\s*20\d{2}-\d{2}-\d{2}/.test(metadata), `${relativeFile} must use YYYY-MM-DD last_verified`);
  record(/source_paths:\n\s+-\s+\S+/m.test(metadata), `${relativeFile} metadata must include at least one source path`);

  for (const sourcePath of extractSourcePaths(metadata)) {
    record(
      sourcePathExists(sourcePath),
      `${relativeFile} source_paths entry must resolve to an existing path or glob match: ${sourcePath}`,
    );
  }
}

function validateCanonicalDocs() {
  for (const file of canonicalDocs) {
    if (!exists(file)) continue;
    const text = readText(file);
    validateMarkdownMetadata(file, text);
    record(/^#\s+.+/m.test(text), `${file} must include an H1 heading`);
    record(!/\b(TODO|TBD|FIXME)\b/i.test(text), `${file} must not contain unresolved TODO/TBD/FIXME markers`);
    validateMarkdownLinks(file);
  }

  const index = exists('docs/context7/README.md') ? readText('docs/context7/README.md') : '';
  for (const file of discoveredContext7Files.filter((entry) => entry !== 'docs/context7/README.md')) {
    const linkTarget = path.relative('docs/context7', file).replaceAll(path.sep, '/');
    record(index.includes(linkTarget), `docs/context7/README.md must link or mention ${linkTarget}`);
  }
}

function validateCanonicalJson() {
  for (const file of canonicalJson) {
    try {
      JSON.parse(readText(file));
    } catch (error) {
      errors.push(`${file} is not valid JSON: ${error.message}`);
    }
  }
}

function validateRootIndex() {
  if (!exists('docs/context7/index.md')) return;
  const text = readText('docs/context7/index.md');
  const requiredNeedles = [
    'How To Use These Docs',
    'Core Retrieval Routes',
    'Machine-Readable Entry Points',
    'Retrieval Rules',
    '01-getting-started/index.md',
    '02-guides/index.md',
    '03-api-reference/index.md',
    '04-architecture/index.md',
    '05-file-conventions/index.md',
    '06-errors/index.md',
    '07-examples/index.md',
    '08-migration/index.md',
    'catalog.json',
    '../../llms.txt',
    '../../context7.json',
  ];
  for (const needle of requiredNeedles) {
    record(text.includes(needle), `docs/context7/index.md must mention ${needle}`);
  }
}

function collectCatalogFiles(node, output = new Set()) {
  if (typeof node === 'string') {
    if (node.startsWith('docs/context7/')) output.add(node);
    return output;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectCatalogFiles(item, output);
    return output;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectCatalogFiles(value, output);
  }
  return output;
}

function validateCatalog() {
  if (!exists('docs/context7/catalog.json')) return;
  let catalog;
  try {
    catalog = JSON.parse(readText('docs/context7/catalog.json'));
  } catch {
    return;
  }

  record(catalog.project === 'NanoFlow', 'catalog.json project must be NanoFlow');
  record(catalog.canonicalRoot === 'docs/context7', 'catalog.json canonicalRoot must be docs/context7');
  record(catalog.categories && typeof catalog.categories === 'object', 'catalog.json must define categories');
  record(Array.isArray(catalog.retrievalRoutes), 'catalog.json must define retrievalRoutes');

  const requiredCategories = [
    'root',
    'gettingStarted',
    'guidesNextStyle',
    'apiReference',
    'architectureNextStyle',
    'fileConventions',
    'errors',
    'examples',
    'migrationAndVersioning',
    'guides',
    'reference',
    'contracts',
    'runbooks',
    'decisions',
    'schemas',
    'quality',
    'governance',
  ];
  for (const category of requiredCategories) {
    record(Array.isArray(catalog.categories?.[category]), `catalog.json categories must include ${category}`);
  }

  for (const [category, indexFile] of Object.entries(numberedCategoryMap)) {
    record(
      Array.isArray(catalog.categories?.[category]) && catalog.categories[category].includes(indexFile),
      `catalog.json ${category} must include ${indexFile}`,
    );
  }

  record(
    Array.isArray(catalog.categories?.root) && catalog.categories.root.includes('docs/context7/index.md'),
    'catalog.json root category must include docs/context7/index.md',
  );

  const catalogFiles = collectCatalogFiles(catalog);
  for (const file of catalogFiles) {
    record(exists(file), `catalog.json references missing file: ${file}`);
  }

  for (const file of discoveredContext7Files) {
    if (file === 'docs/context7/README.md') continue;
    record(catalogFiles.has(file), `catalog.json must categorize or route ${file}`);
  }
}

function validateLlmsTxt() {
  if (!exists('llms.txt')) return;
  const text = readText('llms.txt');
  for (const file of requiredFiles) {
    if (file === 'llms.txt') continue;
    record(text.includes(file), `llms.txt must reference ${file}`);
  }
  for (const file of discoveredContext7Files) {
    record(text.includes(file), `llms.txt must reference ${file}`);
  }
  record(text.includes('Entity IDs are client-generated'), 'llms.txt must state the ID rule');
  record(text.includes('Context7 Indexing Intent'), 'llms.txt must explain Context7 indexing intent');
}

function validateReadmeContext7Links() {
  if (!exists('README.md')) return;
  const text = readText('README.md');
  const required = [
    'docs/context7/README.md',
    'context7.json',
    'llms.txt',
  ];
  for (const target of required) {
    record(text.includes(target), `README.md must reference ${target}`);
  }
  validateMarkdownLinks('README.md', { onlyTargetsContaining: 'context7' });
  validateMarkdownLinks('README.md', { onlyTargetsContaining: 'llms.txt' });
}

validateRequiredFiles();
validateContext7Json();
validateCanonicalDocs();
validateCanonicalJson();
validateRootIndex();
validateCatalog();
validateLlmsTxt();
validateReadmeContext7Links();

if (errors.length > 0) {
  console.error('Context7 documentation validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Context7 documentation validation passed (${requiredFiles.length} required files checked).`);
