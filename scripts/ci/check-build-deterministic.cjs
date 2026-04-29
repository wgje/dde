#!/usr/bin/env node
/**
 * scripts/ci/check-build-deterministic.cjs
 *
 * §16.25 Angular 构建确定性门禁。
 * 两次 clean build 比对 hashed JS/CSS、modulepreload、ngsw.json 稳定内容、
 * version.json 稳定字段和 artifact-manifest.json。
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    );
  }
  return value;
}

function normalizeNgswManifest(ngsw) {
  const normalized = structuredClone(ngsw);
  delete normalized.timestamp;
  return stableJson(normalized);
}

function stableVersionJson(version) {
  const normalized = { ...version };
  delete normalized.buildTime;
  return stableJson(normalized);
}

function stableObjectHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJson(value)))
    .digest('hex');
}

function normalizeArtifactManifest(manifest, dir) {
  const normalized = structuredClone(manifest);
  const files = normalized.files && typeof normalized.files === 'object'
    ? normalized.files
    : {};

  if (files['/ngsw.json'] && fs.existsSync(path.join(dir, 'ngsw.json'))) {
    files['/ngsw.json'].sha256 = stableObjectHash(normalizeNgswManifest(readJson(path.join(dir, 'ngsw.json'))));
  }

  if (files['/version.json'] && fs.existsSync(path.join(dir, 'version.json'))) {
    files['/version.json'].sha256 = stableObjectHash(stableVersionJson(readJson(path.join(dir, 'version.json'))));
  }

  if (normalized.ngswHash && fs.existsSync(path.join(dir, 'ngsw.json'))) {
    normalized.ngswHash = stableObjectHash(normalizeNgswManifest(readJson(path.join(dir, 'ngsw.json'))));
  }

  return stableJson(normalized);
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

// 比对 ngsw.json。Angular 会写入构建时 timestamp；迁移门禁比较其余稳定 SW 内容。
const ngswA = path.join(A, 'ngsw.json');
const ngswB = path.join(B, 'ngsw.json');
if (fs.existsSync(ngswA) && fs.existsSync(ngswB)) {
  const stableA = JSON.stringify(normalizeNgswManifest(readJson(ngswA)), null, 2);
  const stableB = JSON.stringify(normalizeNgswManifest(readJson(ngswB)), null, 2);
  if (stableA !== stableB) {
    fs.writeFileSync(path.join(TMP, 'deterministic-ngsw.diff'), `--- A ---\n${stableA}\n\n--- B ---\n${stableB}\n`);
    console.error('✗ ngsw.json stable content differs between builds');
    failed = true;
  } else {
    console.log('✓ ngsw.json stable content identical (timestamp ignored)');
  }
}

function compareModulepreload(fileName) {
  const fileA = path.join(A, fileName);
  const fileB = path.join(B, fileName);
  if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return;
  const mpA = extractModulepreload(fs.readFileSync(fileA, 'utf-8'));
  const mpB = extractModulepreload(fs.readFileSync(fileB, 'utf-8'));
  if (JSON.stringify(mpA) !== JSON.stringify(mpB)) {
    console.error(`✗ ${fileName} modulepreload list differs`);
    console.error('  A: ' + JSON.stringify(mpA));
    console.error('  B: ' + JSON.stringify(mpB));
    failed = true;
  } else {
    console.log(`✓ ${fileName} modulepreload list identical (${mpA.length} entries)`);
  }
}

compareModulepreload('index.html');
// launch.html modulepreload is part of the static deploy artifact contract.
compareModulepreload('launch.html');

const versionA = path.join(A, 'version.json');
const versionB = path.join(B, 'version.json');
if (fs.existsSync(versionA) && fs.existsSync(versionB)) {
  const stableA = JSON.stringify(stableVersionJson(readJson(versionA)), null, 2);
  const stableB = JSON.stringify(stableVersionJson(readJson(versionB)), null, 2);
  if (stableA !== stableB) {
    console.error('✗ version.json stable fields differ between builds');
    console.error('  A: ' + stableA);
    console.error('  B: ' + stableB);
    failed = true;
  } else {
    console.log('✓ version.json stable fields identical (buildTime ignored)');
  }
}

const artifactA = path.join(A, 'artifact-manifest.json');
const artifactB = path.join(B, 'artifact-manifest.json');
if (fs.existsSync(artifactA) && fs.existsSync(artifactB)) {
  const stableA = JSON.stringify(normalizeArtifactManifest(readJson(artifactA), A), null, 2);
  const stableB = JSON.stringify(normalizeArtifactManifest(readJson(artifactB), B), null, 2);
  if (stableA !== stableB) {
    fs.writeFileSync(path.join(TMP, 'deterministic-artifact-manifest.diff'), `--- A ---\n${stableA}\n\n--- B ---\n${stableB}\n`);
    console.error('✗ artifact-manifest.json stable content differs between builds');
    failed = true;
  } else {
    console.log('✓ artifact-manifest.json stable content identical');
  }
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
