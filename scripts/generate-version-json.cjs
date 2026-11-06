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
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GIT_SHA_PATTERN = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/;

function artifactEvidence() {
  return require('./lib/artifact-stats-evidence.cjs');
}

function artifactPublisher() {
  return require('./lib/artifact-output-publication.cjs');
}

function evidence(reason, cliMessage) {
  const error = new Error(reason);
  error.versionEvidenceReason = reason;
  if (cliMessage) error.versionEvidenceCliMessage = cliMessage;
  return error;
}

function validateGitSha(value, source) {
  if (!GIT_SHA_PATTERN.test(value)) {
    throw evidence(`version-evidence-git-sha-invalid:${source}`);
  }
  return value.toLowerCase();
}

function gitSha(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const execute = options.execute ?? execSync;

  if (Object.hasOwn(env, 'GITHUB_SHA')) {
    return validateGitSha(env.GITHUB_SHA, 'github');
  }
  if (Object.hasOwn(env, 'VERCEL_GIT_COMMIT_SHA')) {
    return validateGitSha(env.VERCEL_GIT_COMMIT_SHA, 'vercel');
  }

  let output;
  try {
    output = execute('git rev-parse HEAD', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch {
    throw evidence('version-evidence-git-sha-unavailable');
  }
  const value = output.endsWith('\r\n')
    ? output.slice(0, -2)
    : output.endsWith('\n') ? output.slice(0, -1) : output;
  return validateGitSha(value, 'git');
}

function readPackageVersion(packagePath = path.join(REPO_ROOT, 'package.json')) {
  let serialized;
  try {
    serialized = fs.readFileSync(packagePath, 'utf8');
  } catch {
    throw evidence('version-evidence-package-json-unavailable');
  }

  let packageJson;
  try {
    packageJson = JSON.parse(serialized);
  } catch {
    throw evidence('version-evidence-package-json-invalid');
  }

  if (!packageJson
    || typeof packageJson !== 'object'
    || Array.isArray(packageJson)
    || !Object.hasOwn(packageJson, 'version')) {
    throw evidence('version-evidence-package-version-missing');
  }
  if (typeof packageJson.version !== 'string') {
    throw evidence('version-evidence-package-version-not-string');
  }
  if (packageJson.version.trim().length === 0) {
    throw evidence('version-evidence-package-version-empty');
  }
  return packageJson.version;
}

function stableNgswHash(distDir) {
  const ngswPath = path.join(distDir, 'ngsw.json');
  if (!fs.existsSync(ngswPath)) return null;

  const { readNgswPost, canonicalNgswHash } = artifactEvidence();
  let ngsw;
  try {
    ngsw = readNgswPost(fs, distDir);
  } catch (error) {
    if (!String(error?.code).startsWith('artifact-evidence-')) {
      throw evidence('version-evidence-ngsw-unavailable');
    }
    throw error;
  }
  return canonicalNgswHash(ngsw);
}

function serializeVersion(version) {
  try {
    return `${JSON.stringify(version, null, 2)}\n`;
  } catch {
    throw evidence('version-evidence-serialization-failed');
  }
}

function generateVersionJson(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const distDir = options.distDir ?? path.join(repoRoot, 'dist', 'browser');
  const outputPath = options.outputPath ?? path.join(distDir, 'version.json');
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  if (!fs.existsSync(distDir)) {
    throw evidence(
      'version-evidence-dist-missing',
      '✗ dist/browser missing — run npm run build first',
    );
  }

  const appVersion = readPackageVersion(path.join(repoRoot, 'package.json'));
  const resolvedGitSha = gitSha({ repoRoot, env, execute: options.executeGit });
  const ngswHash = stableNgswHash(distDir);
  let buildTime;
  try {
    buildTime = now().toISOString();
  } catch {
    throw evidence('version-evidence-serialization-failed');
  }

  const version = {
    gitSha: resolvedGitSha,
    buildTime,
    environment: env.NG_APP_SENTRY_ENVIRONMENT
      || (env.NODE_ENV === 'production' ? 'production' : 'development'),
    appVersion,
    deploymentTarget: env.NG_APP_DEPLOYMENT_TARGET || env.DEPLOYMENT_TARGET || 'local',
    supabaseProjectAlias: env.NG_APP_SUPABASE_PROJECT_ALIAS || env.SUPABASE_PROJECT_ALIAS || 'local',
    sentryRelease: env.NG_APP_SENTRY_RELEASE || env.SENTRY_RELEASE || '',
    ngswHash,
  };
  const serialized = serializeVersion(version);

  try {
    const { publishOutput, validateOutput } = artifactPublisher();
    const rootStat = fs.lstatSync(distDir);
    const rootReal = fs.realpathSync.native(distDir);
    const current = validateOutput(fs, outputPath, rootReal);
    publishOutput(fs, outputPath, serialized, rootReal, current, distDir, rootStat);
  } catch (error) {
    if (String(error?.code).startsWith('artifact-evidence-')) {
      throw evidence('version-evidence-output-write-failed');
    }
    throw evidence('version-evidence-output-write-failed');
  }

  return {
    outputPath,
    relativeOutputPath: path.relative(repoRoot, outputPath),
    version,
  };
}

function main() {
  try {
    const result = generateVersionJson();
    console.log(`✓ Wrote ${result.relativeOutputPath}`);
    console.log('  ' + JSON.stringify({
      gitSha: result.version.gitSha.slice(0, 8),
      environment: result.version.environment,
      deploymentTarget: result.version.deploymentTarget,
      ngswHash: result.version.ngswHash ? result.version.ngswHash.slice(0, 12) : null,
    }));
    return 0;
  } catch (error) {
    const cliMessage = error && error.versionEvidenceCliMessage;
    const reason = error && typeof error.versionEvidenceReason === 'string'
      ? error.versionEvidenceReason
      : 'version-evidence-unavailable';
    console.error(cliMessage || `[generate-version-json] ${reason}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  generateVersionJson,
  main,
  readPackageVersion,
};
