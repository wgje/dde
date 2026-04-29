#!/usr/bin/env node
/**
 * scripts/generate-artifact-manifest.cjs
 *
 * Generate dist/browser/artifact-manifest.json after all post-build and header
 * mutations. This is the stable deployment fingerprint used to compare the
 * exact Vercel/Cloudflare release-candidate artifact during the migration.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'browser');
const OUT = path.join(DIST, 'artifact-manifest.json');

if (!fs.existsSync(DIST) || !fs.statSync(DIST).isDirectory()) {
  console.error('✗ dist/browser missing — run npm run build first');
  process.exit(1);
}

function toPosix(relativePath) {
  return '/' + relativePath.split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === OUT) continue;
    if (entry.isDirectory()) {
      walk(full, result);
      continue;
    }
    if (entry.isFile()) result.push(full);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function parseHeaders(headersPath) {
  if (!fs.existsSync(headersPath)) return [];
  const rules = [];
  let current = null;
  for (const rawLine of fs.readFileSync(headersPath, 'utf-8').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (/^\S/.test(rawLine) && rawLine.startsWith('/')) {
      current = { pattern: rawLine.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    if (line.startsWith('! ')) {
      current.headers[line.slice(2).trim()] = '!';
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      current.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return rules;
}

function patternMatches(pattern, requestPath) {
  if (pattern === requestPath) return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(requestPath);
}

function headersForPath(rules, requestPath) {
  const headers = {};
  for (const rule of rules) {
    if (patternMatches(rule.pattern, requestPath)) {
      Object.assign(headers, rule.headers);
    }
  }
  return headers;
}

function contentTypeFor(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(name);
  if (name === 'manifest.webmanifest') return 'application/manifest+json; charset=utf-8';
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.pb': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

function extractModulepreload(html) {
  return [...html.matchAll(/<link[^>]+rel=["']?modulepreload["']?[^>]*href=["']?([^"'\s>]+)["']?/g)]
    .map((match) => match[1])
    .sort();
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

const rules = parseHeaders(path.join(DIST, '_headers'));
const files = {};
const allFiles = walk(DIST);
let totalBytes = 0;
let rootJsCount = 0;
let gojsFlowChunkBytes = 0;

function isGojsFlowChunk(file, relative) {
  if (path.dirname(relative) !== '.' || path.extname(relative) !== '.js') return false;
  const name = path.basename(relative);
  if (/^(main|polyfills|runtime)-/.test(name)) return false;
  const head = fs.readFileSync(file, 'utf-8').slice(0, 256 * 1024);
  return /gojs|GoJS|go\.Diagram|FlowViewComponent|FlowTemplate|flow-task|floating-tree|Diagram/i.test(head);
}

for (const file of allFiles) {
  const relative = path.relative(DIST, file);
  const requestPath = toPosix(relative);
  const stat = fs.statSync(file);
  const headers = headersForPath(rules, requestPath);
  totalBytes += stat.size;
  if (path.dirname(relative) === '.' && path.extname(relative) === '.js') rootJsCount += 1;
  if (isGojsFlowChunk(file, relative)) gojsFlowChunkBytes += stat.size;

  const entry = {
    sha256: sha256(file),
    size: stat.size,
    contentType: contentTypeFor(file),
    cachePolicy: headers['Cache-Control'] || null,
  };

  if (requestPath === '/index.html' || requestPath === '/launch.html') {
    entry.modulepreload = extractModulepreload(fs.readFileSync(file, 'utf-8'));
  }

  files[requestPath] = entry;
}

const ngsw = readJsonIfExists(path.join(DIST, 'ngsw.json'));
const version = readJsonIfExists(path.join(DIST, 'version.json'));
const headerRuleCount = rules.length;

const manifest = {
  schemaVersion: 1,
  gitSha: version?.gitSha || process.env.GITHUB_SHA || null,
  deploymentTarget: version?.deploymentTarget || process.env.DEPLOYMENT_TARGET || null,
  ngswHash: version?.ngswHash || null,
  metrics: {
    fileCount: allFiles.length,
    totalBytes,
    rootJsCount,
    headerRuleCount,
    ngswAssetCount: Array.isArray(ngsw?.assetGroups)
      ? ngsw.assetGroups.reduce((sum, group) => sum + (Array.isArray(group.urls) ? group.urls.length : 0), 0)
      : null,
    gojsFlowChunkBytes,
  },
  files,
};

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ Wrote ${path.relative(REPO_ROOT, OUT)}`);
console.log('  ' + JSON.stringify(manifest.metrics));
