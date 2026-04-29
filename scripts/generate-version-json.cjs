#!/usr/bin/env node
/**
 * scripts/generate-version-json.cjs (§16.24)
 *
 * 生成 dist/browser/version.json，作为部署指纹。
 * 字段：gitSha / buildTime / environment / appVersion / deploymentTarget /
 *       supabaseProjectAlias / sentryRelease / ngswHash
 *
 * 必须在所有 post-build 操作完成后执行（包括 ngsw-config + patch-ngsw-html-hashes）。
 * version.json 必须被部署平台标记 no-store（已在 _headers 中规定）。
 *
 * 不写入任何 secret。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'browser');
const OUT = path.join(DIST, 'version.json');

if (!fs.existsSync(DIST)) {
  console.error('✗ dist/browser missing — run npm run build first');
  process.exit(1);
}

function gitSha() {
  return process.env.GITHUB_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || (() => {
      try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim(); }
      catch { return 'unknown'; }
    })();
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
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

function stableNgswHash() {
  const ngswPath = path.join(DIST, 'ngsw.json');
  if (!fs.existsSync(ngswPath)) return null;
  try {
    const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf-8'));
    delete ngsw.timestamp;
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(stableJson(ngsw)))
      .digest('hex');
  } catch {
    return crypto.createHash('sha256').update(fs.readFileSync(ngswPath)).digest('hex');
  }
}

const version = {
  gitSha: gitSha(),
  buildTime: new Date().toISOString(),
  environment: process.env.NG_APP_SENTRY_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  appVersion: readPackageVersion(),
  deploymentTarget: process.env.NG_APP_DEPLOYMENT_TARGET || process.env.DEPLOYMENT_TARGET || 'local',
  supabaseProjectAlias: process.env.NG_APP_SUPABASE_PROJECT_ALIAS || process.env.SUPABASE_PROJECT_ALIAS || 'local',
  sentryRelease: process.env.NG_APP_SENTRY_RELEASE || process.env.SENTRY_RELEASE || '',
  ngswHash: stableNgswHash(),
};

fs.writeFileSync(OUT, JSON.stringify(version, null, 2) + '\n');
console.log(`✓ Wrote ${path.relative(REPO_ROOT, OUT)}`);
console.log('  ' + JSON.stringify({
  gitSha: version.gitSha.slice(0, 8),
  environment: version.environment,
  deploymentTarget: version.deploymentTarget,
  ngswHash: version.ngswHash ? version.ngswHash.slice(0, 12) : null,
}));
