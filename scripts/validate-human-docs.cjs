#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const errors = [];
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
let workspacePathIndex = null;

function toAbs(relativePath) {
  return path.join(root, relativePath);
}

function normalizePath(input) {
  return input.replaceAll('\\', '/').replace(/^\.\//, '');
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

function walkFiles(relativeDir, predicate, output = []) {
  const absoluteDir = toAbs(relativeDir);
  if (!fs.existsSync(absoluteDir)) return output;

  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const childRelative = normalizePath(path.join(relativeDir, entry.name));
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

    const childRelative = normalizePath(path.join(relativeDir, entry.name)).replace(/^\.\//, '');
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

function parseFrontMatter(relativePath, text) {
  if (!text.startsWith('---\n')) {
    errors.push(`${relativePath} must start with YAML front matter`);
    return {};
  }

  const end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    errors.push(`${relativePath} front matter must close with ---`);
    return {};
  }

  const raw = text.slice(4, end);
  const metadata = {};
  let currentListKey = null;

  for (const line of raw.split(/\r?\n/)) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentListKey) {
      metadata[currentListKey].push(listMatch[1].trim());
      continue;
    }

    const pairMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!pairMatch) continue;

    const [, key, value] = pairMatch;
    if (value === '') {
      metadata[key] = [];
      currentListKey = key;
    } else {
      metadata[key] = value.trim().replace(/^['"]|['"]$/g, '');
      currentListKey = null;
    }
  }

  return metadata;
}

function loadCatalog() {
  const catalogPath = 'docs/handbook/catalog.json';
  record(exists(catalogPath), `Missing required catalog: ${catalogPath}`);
  if (!exists(catalogPath)) return null;

  try {
    return JSON.parse(readText(catalogPath));
  } catch (error) {
    errors.push(`${catalogPath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function getCatalogPages(catalog) {
  if (!catalog) return [];

  const pages = [
    {
      title: catalog.title,
      path: catalog.root,
      kind: 'root',
      category: 'root',
    },
  ];

  for (const category of catalog.categories ?? []) {
    pages.push({
      title: category.title,
      path: category.landing,
      kind: 'landing',
      category: category.id,
    });

    for (const article of category.articles ?? []) {
      pages.push({
        title: article.title,
        path: article.path,
        kind: 'article',
        category: category.id,
      });
    }
  }

  return pages;
}

function validateCatalog(catalog) {
  if (!catalog) return;

  record(catalog.title === 'NanoFlow 使用手册', 'catalog title must be NanoFlow 使用手册');
  record(catalog.status === 'canonical', 'catalog status must be canonical');
  record(catalog.root === 'docs/handbook/index.md', 'catalog root must be docs/handbook/index.md');
  record(Array.isArray(catalog.categories) && catalog.categories.length >= 5, 'catalog must define at least five categories');

  const ids = new Set();
  for (const category of catalog.categories ?? []) {
    record(typeof category.id === 'string' && category.id.length > 0, 'each category must have an id');
    record(!ids.has(category.id), `duplicate category id: ${category.id}`);
    ids.add(category.id);
    record(typeof category.title === 'string' && category.title.length > 0, `category ${category.id} must have a title`);
    record(typeof category.description === 'string' && category.description.length > 20, `category ${category.id} must have a useful description`);
    record(typeof category.landing === 'string' && category.landing.endsWith('/index.md'), `category ${category.id} must use an index.md landing page`);
    record(Array.isArray(category.articles) && category.articles.length >= 4, `category ${category.id} must have at least four articles`);

    for (const article of category.articles ?? []) {
      record(typeof article.title === 'string' && article.title.length > 0, `article in ${category.id} must have a title`);
      record(typeof article.path === 'string' && article.path.endsWith('.md'), `article ${article.title} must have a Markdown path`);
      record(typeof article.purpose === 'string' && article.purpose.length > 20, `article ${article.title} must have a useful purpose`);
    }
  }
}

function validatePage(page) {
  record(exists(page.path), `Missing handbook page: ${page.path}`);
  if (!exists(page.path)) return;

  const text = readText(page.path);
  const metadata = parseFrontMatter(page.path, text);
  const isUserFacing = isUserFacingAudience(metadata.audience);
  const requiredMetadata = ['title', 'status', 'audience', 'last_verified', 'category', 'source_paths'];
  for (const key of requiredMetadata) {
    record(metadata[key] !== undefined, `${page.path} missing front matter key: ${key}`);
  }

  record(metadata.title === page.title, `${page.path} title must match catalog title "${page.title}"`);
  record(metadata.status === 'canonical', `${page.path} status must be canonical`);
  record(metadata.category === page.category, `${page.path} category must be ${page.category}`);
  record(/^20\d{2}-\d{2}-\d{2}$/.test(metadata.last_verified ?? ''), `${page.path} last_verified must use YYYY-MM-DD`);
  record(Array.isArray(metadata.source_paths) && metadata.source_paths.length > 0, `${page.path} must list source_paths`);

  if (Array.isArray(metadata.source_paths)) {
    for (const sourcePath of metadata.source_paths) {
      validateSourcePath(page.path, sourcePath);
    }
  }

  record(text.includes(`\n# ${page.title}\n`), `${page.path} must include an H1 matching the catalog title`);
  if (isUserFacing) {
    record(text.includes('## 本文内容'), `${page.path} user-facing page must include ## 本文内容`);
    record(text.includes('## 下一步'), `${page.path} user-facing page must include ## 下一步`);
    validateChineseUserFacingPage(page, text);
  } else {
    record(
      text.includes('## In This Article') || text.includes('## 本文内容'),
      `${page.path} must include ## In This Article or ## 本文内容`,
    );
    record(
      text.includes('## Next Steps') || text.includes('## 下一步'),
      `${page.path} must include ## Next Steps or ## 下一步`,
    );
  }
  record(!/\b(TODO|TBD|FIXME|填充|待补)\b/i.test(text), `${page.path} must not contain placeholder text`);

  if (page.kind === 'article') {
    const h2Count = (text.match(/^## /gm) ?? []).length;
    record(h2Count >= 5, `${page.path} must have at least five H2 sections`);
  }

  validateMarkdownLinks(page.path, text);
}

function isUserFacingAudience(audience) {
  return typeof audience === 'string' && /\b(user|operator)\b/.test(audience);
}

function stripCodeForLanguageCheck(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '')
    .replace(/^source_paths:\n(?:\s+-\s+.+\n)+/gm, '');
}

function validateChineseUserFacingPage(page, text) {
  const prose = stripCodeForLanguageCheck(text);
  const cjkCount = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (prose.match(/\b[A-Za-z][A-Za-z-]{3,}\b/g) ?? []).length;
  const minimumCjk = page.kind === 'article' ? 450 : 300;

  record(cjkCount >= minimumCjk, `${page.path} user-facing page must contain at least ${minimumCjk} Chinese characters`);
  record(
    cjkCount >= latinWords * 2,
    `${page.path} user-facing page must be primarily Chinese prose (Chinese chars: ${cjkCount}, Latin words: ${latinWords})`,
  );
  record(
    !/\b(Recommended Path|Articles|When To|What Works|Troubleshooting|Common Commands|Quality Gates)\b/.test(prose),
    `${page.path} user-facing page must not keep English section labels`,
  );
}

function validateSourcePath(pagePath, sourcePath) {
  const normalized = normalizePath(sourcePath);
  const index = getWorkspacePathIndex();

  if (normalized.endsWith('/')) {
    record(index.includes(normalized), `${pagePath} source_path directory does not exist: ${sourcePath}`);
    return;
  }

  if (normalized.includes('*')) {
    const regex = globToRegex(normalized);
    record(index.some((entry) => regex.test(entry)), `${pagePath} source_path glob matches no workspace path: ${sourcePath}`);
    return;
  }

  record(index.includes(normalized), `${pagePath} source_path does not exist: ${sourcePath}`);
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '::DOUBLE_STAR::')
    .replaceAll('*', '[^/]*')
    .replaceAll('::DOUBLE_STAR::', '.*');
  return new RegExp(`^${escaped}$`);
}

function validateMarkdownLinks(relativePath, text) {
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const href = match[1].trim();
    if (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('mailto:') ||
      href.startsWith('#') ||
      href.startsWith('task:')
    ) {
      continue;
    }

    const withoutAnchor = href.split('#')[0];
    if (!withoutAnchor || withoutAnchor.includes(':')) {
      continue;
    }

    const resolved = normalizePath(path.join(path.dirname(relativePath), withoutAnchor));
    record(exists(resolved), `${relativePath} has broken relative link: ${href} -> ${resolved}`);
  }
}

function validatePortal(catalogPages) {
  const portalPath = 'docs/README.md';
  record(exists(portalPath), 'Missing docs/README.md portal');
  if (!exists(portalPath)) return;

  const text = readText(portalPath);
  record(text.includes('[handbook/index.md](handbook/index.md)'), 'docs/README.md must link to handbook/index.md');
  record(text.includes('[context7/index.md](context7/index.md)'), 'docs/README.md must link to context7/index.md');
  record(text.includes('npm run docs:human:validate'), 'docs/README.md must document the human docs validation command');
  validateChineseUserFacingPage(
    { path: portalPath, kind: 'landing' },
    text,
  );

  for (const page of catalogPages.filter((entry) => entry.kind === 'landing')) {
    const relative = page.path.replace(/^docs\//, '');
    record(text.includes(relative) || readText('docs/handbook/index.md').includes(path.relative('docs/handbook', page.path).replaceAll('\\', '/')), `human docs root must route to ${page.path}`);
  }
}

function main() {
  const catalog = loadCatalog();
  validateCatalog(catalog);
  const catalogPages = getCatalogPages(catalog);

  const handbookMarkdownFiles = walkFiles('docs/handbook', (file) => file.endsWith('.md')).sort();
  const catalogPagePaths = new Set(catalogPages.map((page) => page.path));

  for (const file of handbookMarkdownFiles) {
    record(catalogPagePaths.has(file), `${file} is not listed in docs/handbook/catalog.json`);
  }

  for (const page of catalogPages) {
    validatePage(page);
  }

  validatePortal(catalogPages);

  if (errors.length > 0) {
    console.error('Human documentation validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Human documentation validation passed (${catalogPages.length} handbook pages checked).`);
}

main();
