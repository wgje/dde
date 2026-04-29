#!/usr/bin/env node
/**
 * scripts/generate-artifact-manifest.cjs (§16.4 / 阶段 1)
 *
 * 生成 dist/browser/artifact-manifest.json：deploy 前的最终内容指纹，覆盖
 * hashed JS/CSS/worker、`index.html`、`launch.html`、`ngsw.json`、`_headers`、
 * `version.json` 与公开静态资源的 SHA256 + 文件大小 + 期望 content-type +
 * cache policy。
 *
 * 必须在所有 post-build 操作完成后执行（generate-launch-html /
 * inject-modulepreload / patch-ngsw-html-hashes / generate-version-json /
 * 任何 sentry sourcemap inject 与 post-inject rename 之后）。该 manifest
 * 用于：
 *   - Vercel 回滚后备 vs Cloudflare production 的 artifact 一致性比对
 *   - PR preview 与 production 的 deterministic build 验收
 *   - Sentry release 上传命中确认（间接）
 *
 * 不写入任何 secret，可以作为 CI artifact 公开。
 *
 * 兼容 §16.24 version.json：本 manifest 不取代 version.json，二者并存。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'browser');
const OUT = path.join(DIST, 'artifact-manifest.json');

if (!fs.existsSync(DIST)) {
  console.error('✗ dist/browser missing — run `npm run build` first');
  process.exit(1);
}

/** 递归列出所有文件（相对于 DIST），跳过 .map */
function listFiles(dir, base = dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, base, results);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      // 跳过本 manifest 自身（避免自引用）以及 .map 文件
      if (rel === 'artifact-manifest.json') continue;
      if (rel.endsWith('.map')) continue;
      results.push(rel);
    }
  }
  return results;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 简化的 content-type 推断：仅覆盖部署关心的扩展。
 * 不依赖 mime 包以避免新增依赖。
 */
function inferContentType(rel) {
  const ext = path.extname(rel).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.webmanifest': return 'application/manifest+json';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/**
 * 与 public/_headers 的策略保持一致；不依赖解析 _headers 文件，而是按
 * §4.4 / §16.6 / §16.17 的契约推导。CI 端 check-deploy-artifacts.cjs 已
 * 单独验证 _headers 文件本身的规则正确性。
 */
function inferCachePolicy(rel) {
  // freshness 关键路径：no-store
  const noStore = new Set([
    'index.html',
    'index.csr.html',
    'launch.html',
    'ngsw.json',
    'ngsw-worker.js',
    'sw-composed.js',
    'safety-worker.js',
    'worker-basic.min.js',
    'version.json',
    'artifact-manifest.json',
  ]);
  if (noStore.has(rel)) return 'no-store';
  // manifest / assetlinks：短 revalidate
  if (rel === 'manifest.webmanifest' || rel === '.well-known/assetlinks.json') {
    return 'short-revalidate';
  }
  // 入口 hashed bundles：long-immutable
  const base = path.basename(rel);
  if (
    /^main-[A-Z0-9]+\.js$/i.test(base)
    || /^polyfills-[A-Z0-9]+\.js$/i.test(base)
    || /^chunk-[A-Z0-9]+\.js$/i.test(base)
    || /^styles-[A-Z0-9]+\.css$/i.test(base)
    || /^runtime-[A-Z0-9]+\.js$/i.test(base)
    || (/^worker-[A-Z0-9]+\.js$/i.test(base) && base !== 'worker-basic.min.js')
  ) {
    return 'long-immutable';
  }
  // 公共非 hash 静态资源：1d revalidate
  if (
    rel.startsWith('fonts/')
    || rel.startsWith('icons/')
    || rel.startsWith('widgets/')
    || rel.startsWith('assets/')
  ) {
    return 'day-revalidate';
  }
  return 'default';
}

const startedAt = Date.now();
const files = listFiles(DIST).sort((a, b) => a.localeCompare(b));

const entries = [];
let totalBytes = 0;

for (const rel of files) {
  const full = path.join(DIST, rel);
  const buf = fs.readFileSync(full);
  totalBytes += buf.length;
  entries.push({
    path: rel,
    sha256: sha256(buf),
    size: buf.length,
    contentType: inferContentType(rel),
    cachePolicy: inferCachePolicy(rel),
  });
}

// 顶层指纹：把所有 entry 序列化后再哈希，便于跨 build 一键比对
const aggregateHash = sha256(Buffer.from(
  entries.map((e) => `${e.path}\t${e.sha256}\t${e.size}\t${e.cachePolicy}\n`).join(''),
  'utf-8'
));

const gitSha = process.env.GITHUB_SHA
  || process.env.VERCEL_GIT_COMMIT_SHA
  || (() => {
    try { return require('node:child_process').execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim(); }
    catch { return 'unknown'; }
  })();

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  gitSha,
  totalFiles: entries.length,
  totalBytes,
  aggregateHash,
  entries,
};

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
const ms = Date.now() - startedAt;
console.log(`✓ Wrote ${path.relative(REPO_ROOT, OUT)} in ${ms}ms`);
console.log(`  files=${entries.length} bytes=${totalBytes} aggregate=${aggregateHash.slice(0, 16)}...`);
