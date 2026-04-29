#!/usr/bin/env node
/**
 * scripts/ci/check-build-deterministic.cjs
 *
 * §16.25 Angular 构建确定性门禁。
 * 两次 clean build 比对 hashed JS/CSS、modulepreload、ngsw.json。
 *
 * 用法：
 *   node scripts/ci/check-build-deterministic.cjs
 *
 * 注意：此脚本会执行两次完整 build，耗时较长，建议仅在 dry-run / preview 中跑。
 * Production deploy 必须引用同一份已通过 deterministic guard 的 artifact。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(REPO_ROOT, '.tmp');
const A = path.join(TMP, 'build-a');
const B = path.join(TMP, 'build-b');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findHashedAssets(dir) {
  // 入口 + chunk + worker（排除 safety worker）+ styles
  const result = [];
  const re = /^(main|polyfills|chunk|runtime)-[A-Z0-9]+\.js$|^chunk-[A-Z0-9]+\.css$|^styles-[A-Z0-9]+\.css$|^worker-[A-Z0-9]+\.js$/;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && re.test(entry.name) && entry.name !== 'worker-basic.min.js') {
      result.push(entry.name);
    }
  }
  return result.sort();
}

function buildManifest(dir) {
  const files = findHashedAssets(dir);
  return files.map((name) => `${sha256(path.join(dir, name))}  ${name}`).join('\n');
}

function run(cmd) {
  console.log('$ ' + cmd);
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
}

function copyDist(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const src = path.join(REPO_ROOT, 'dist', 'browser');
  // 简单递归复制
  function rec(s, d) {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) rec(sp, dp);
      else fs.copyFileSync(sp, dp);
    }
  }
  rec(src, dest);
}

function extractModulepreload(html) {
  const matches = [...html.matchAll(/<link[^>]+rel=["']?modulepreload["']?[^>]*href=["']?([^"'\s>]+)["']?/g)];
  return matches.map((m) => m[1]).sort();
}

console.log('==== Build A ====');
fs.rmSync(path.join(REPO_ROOT, 'dist'), { recursive: true, force: true });
run('npm run build:stats');
copyDist(A);

console.log('==== Build B ====');
fs.rmSync(path.join(REPO_ROOT, 'dist'), { recursive: true, force: true });
run('npm run build:stats');
copyDist(B);

// 比对 hashed asset manifest
const manA = buildManifest(A);
const manB = buildManifest(B);
const manifestPath = path.join(TMP, 'deterministic-manifest.diff');
let failed = false;

if (manA !== manB) {
  fs.writeFileSync(manifestPath, `--- A ---\n${manA}\n\n--- B ---\n${manB}\n`);
  console.error('✗ Hashed asset manifest differs between two clean builds.');
  console.error('  See diff at: ' + manifestPath);
  failed = true;
} else {
  console.log('✓ Hashed asset manifest identical (' + manA.split('\n').length + ' files)');
}

// 比对 ngsw.json
const ngswA = path.join(A, 'ngsw.json');
const ngswB = path.join(B, 'ngsw.json');
if (fs.existsSync(ngswA) && fs.existsSync(ngswB)) {
  if (sha256(ngswA) !== sha256(ngswB)) {
    console.error('✗ ngsw.json differs between builds');
    failed = true;
  } else {
    console.log('✓ ngsw.json identical');
  }
}

// 比对 index.html modulepreload
const htmlA = fs.readFileSync(path.join(A, 'index.html'), 'utf-8');
const htmlB = fs.readFileSync(path.join(B, 'index.html'), 'utf-8');
const mpA = extractModulepreload(htmlA);
const mpB = extractModulepreload(htmlB);
if (JSON.stringify(mpA) !== JSON.stringify(mpB)) {
  console.error('✗ index.html modulepreload list differs');
  console.error('  A: ' + JSON.stringify(mpA));
  console.error('  B: ' + JSON.stringify(mpB));
  failed = true;
} else {
  console.log(`✓ modulepreload list identical (${mpA.length} entries)`);
}

if (failed) {
  console.error('');
  console.error('Two clean builds produced different output. Possible causes:');
  console.error('  - Non-deterministic input (env vars, timestamps, parallel order)');
  console.error('  - Node/npm/Wrangler version drift');
  console.error('  - scripts/set-env.cjs writing flags in unstable order');
  process.exit(1);
}
console.log('');
console.log('✓ check-build-deterministic PASSED');
