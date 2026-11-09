#!/usr/bin/env node
/**
 * scripts/ci/check-deploy-artifacts.cjs
 *
 * Cloudflare Pages 部署前 artifact 综合校验 (§5.3 / §16.8 / §16.9 / §16.13 / §16.17)
 *
 * 检查项：
 * 1. dist/browser 必须存在且包含必备文件
 * 2. dist/browser/_worker.js 不存在（防止误启用 Pages Functions）
 * 3. dist/browser/functions/ 目录不存在
 * 4. 仓库根目录 functions/ 目录不存在
 * 5. dist/browser 中无 .map 文件（sourcemap 默认禁用）
 * 6. _headers 规则数 ≤ 90，且 / 明确 no-store、/* 关闭 Link
 * 7. 文件总数 ≤ 18000
 * 8. 根目录 .js 必须匹配已知模式（main/polyfills/chunk/worker/runtime/
 *    sw-composed/ngsw-worker/safety-worker/worker-basic.min）
 * 9. _headers 不允许 /worker*.js 或 /worker-*.js 宽泛 immutable 规则
 * 10. ngsw-config.json 不允许 /worker*.js 或 /worker-*.js 宽泛 glob
 * 11. dist/browser/ngsw.json 应用 assetGroups 不应包含 worker-basic.min.js / safety-worker.js
 * 12. /fonts/, /icons/, /assets/ 等非 hash 资源在 _headers 中不能 immutable
 * 13. 应用 Web Worker chunk（worker-<hash>.js, 排除 worker-basic.min.js）
 *     必须有精确文件名 immutable 规则
 * 14. dist/browser/manifest.webmanifest 不含 vercel.app，manifest.webmanifest id/scope/start_url 不绑定旧 origin
 * 15. dist/browser/.well-known/assetlinks.json 与 ANDROID_TWA_PACKAGE_NAME /
 *     ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS 匹配
 * 16. dist/browser/version.json 存在且 JSON 合法
 * 17. dist/browser/artifact-manifest.json 存在且覆盖关键文件、modulepreload 和 cachePolicy
 * 18. dist/browser/index.html 存在
 *
 * 退出码：失败抛出 1。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  parseNgsw, projectStats, requiredCacheableBrowserOutputs, validateNgswPost, sameArtifactIdentity,
  readBrowserFiles, canonicalDigest,
} = require('../lib/artifact-stats-evidence.cjs');
const { readCandidateCensus, sharedIdentityBytes } = require('../generate-artifact-manifest.cjs');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST = path.resolve(process.env.ARTIFACT_DIST_DIR || path.join(REPO_ROOT, 'dist', 'browser'));
const STATS = path.resolve(process.env.ARTIFACT_STATS_PATH || path.join(REPO_ROOT, 'dist', 'stats.json'));
const DEFAULT_TWA_PACKAGE_NAME = 'app.nanoflow.twa';

let failures = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => console.log('  ✓ ' + msg);

function existsFile(p) { return fs.existsSync(p) && fs.statSync(p).isFile(); }
function existsDir(p) { return fs.existsSync(p) && fs.statSync(p).isDirectory(); }
function splitEnvList(value) {
  return String(value || '')
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readHeaderRule(text, pattern) {
  const headers = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (/^\S/.test(rawLine) && rawLine.startsWith('/')) {
      current = rawLine.trim();
      continue;
    }
    if (current !== pattern) continue;
    const line = rawLine.trim();
    if (line.startsWith('! ')) {
      headers[line.slice(2).trim().toLowerCase()] = '!';
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return headers;
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[:\-\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(compact)) return null;
  return compact.match(/.{2}/g).join(':');
}

function parseFingerprintList(value) {
  const entries = splitEnvList(value);
  if (entries.length === 0) return null;
  const fingerprints = entries.map(normalizeFingerprint);
  if (fingerprints.some(fingerprint => fingerprint === null)) return null;
  return [...new Set(fingerprints)];
}

function isRelativeOrRootUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value === '.';
}

function findFiles(dir, predicate, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, predicate, results);
    else if (predicate(full, entry)) results.push(full);
  }
  return results;
}

function normalizeStatsOutputPath(outputPath, dist) {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') return null;
  let normalized = outputPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedDist = path.resolve(dist).replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.toLowerCase().startsWith(`${normalizedDist.toLowerCase()}/`)) {
    normalized = normalized.slice(normalizedDist.length + 1);
  }
  for (const prefix of ['dist/browser/', 'browser/']) {
    if (normalized.toLowerCase().startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  return normalized.replace(/^\/+/, '');
}

function statsReferencedRootCss(dist, statsJson, rootCss) {
  const references = new Set();
  const outputs = statsJson?.outputs && typeof statsJson.outputs === 'object'
    ? statsJson.outputs
    : {};
  const rootCssSet = new Set(rootCss);

  for (const [outputPath, metadata] of Object.entries(outputs)) {
    const runtimeOutput = normalizeStatsOutputPath(outputPath, dist);
    if (!runtimeOutput || !/\.m?js$/i.test(runtimeOutput)) continue;
    if (typeof metadata?.entryPoint !== 'string' || metadata.entryPoint.trim() === '') continue;
    const cssBundle = normalizeStatsOutputPath(metadata.cssBundle, dist);
    if (cssBundle && rootCssSet.has(cssBundle)) references.add(cssBundle);
  }

  return references;
}

function findCssArtifactIssues(dist, ngswJson, statsJson = null) {
  const rootCss = fs.readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => entry.name)
    .sort();
  const cssByContent = new Map();

  for (const file of rootCss) {
    const contentKey = fs.readFileSync(path.join(dist, file)).toString('base64');
    const matches = cssByContent.get(contentKey) || [];
    matches.push(file);
    cssByContent.set(contentKey, matches);
  }

  const duplicateCssGroups = [...cssByContent.values()]
    .filter((files) => files.length > 1)
    .map((files) => files.sort());
  const runtimeSources = findFiles(dist, (file) => /\.(?:html|m?js)$/.test(file))
    .map((file) => fs.readFileSync(file, 'utf-8'));
  const assetGroups = Array.isArray(ngswJson?.assetGroups) ? ngswJson.assetGroups : [];
  const cachedRootCss = new Set(
    assetGroups
      .flatMap((group) => Array.isArray(group?.urls) ? group.urls : [])
      .filter((url) => /^\/[^/]+\.css$/.test(url)),
  );
  const statsReferences = statsReferencedRootCss(dist, statsJson, rootCss);
  const orphanCachedCss = rootCss
    .filter((file) => cachedRootCss.has(`/${file}`))
    .filter((file) => runtimeSources.every((source) => !source.includes(file)))
    .filter((file) => !statsReferences.has(file));

  return { duplicateCssGroups, orphanCachedCss };
}

function main() {
// 1. dist/browser 存在
if (!existsDir(DIST)) {
  console.error('✗ dist/browser missing — run `npm run build` first');
  process.exit(1);
}
ok('dist/browser exists');
let browserEvidence = new Map();
try { browserEvidence = readBrowserFiles(fs, DIST); }
catch (error) { fail(String(error?.code || 'artifact-evidence-ngsw')); }

const diskFiles = new Map([...new Set([...findFiles(DIST, () => true), path.join(DIST, 'artifact-manifest.json')])]
  .map((file) => [`/${path.relative(DIST, file).replace(/\\/g, '/').replace(/^\/+/, '')}`, { file }])
  .sort(([left], [right]) => Number(left > right) - Number(left < right)));
for (const [requestPath, snapshot] of diskFiles) {
  try { snapshot.stat = fs.lstatSync(snapshot.file); } catch {}
  const reason = requestPath === '/artifact-manifest.json' ? 'artifact-manifest-root' : 'artifact-manifest-disk-entry';
  if (!snapshot.stat?.isFile()) fail(`${reason}-${snapshot.stat ? 'not-regular' : 'unavailable'}:${requestPath}`);
}
if (failures.length === 0) {
  for (const [requestPath, snapshot] of diskFiles) {
    let reason = 'artifact-manifest-disk-entry-unavailable';
    try {
      const fd = fs.openSync(snapshot.file, 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !sameArtifactIdentity(stat, snapshot.stat)) {
          throw new Error(reason = 'artifact-manifest-disk-entry-identity-changed');
        }
        snapshot.content = fs.readFileSync(fd);
        if (snapshot.content.length !== stat.size) throw new Error(reason = 'artifact-manifest-disk-entry-identity-changed');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      fail(`${reason}:${requestPath}`);
      break;
    }
  }
}
if (failures.length > 0) {
  console.error('✗ check-deploy-artifacts FAILED:');
  for (const failure of failures) console.error('  • ' + failure);
  process.exit(1);
}
const artifactText = (requestPath) => diskFiles.get(requestPath)?.content.toString('utf8') ?? null;

// 2-4. Pages Functions 误启用检查
if (existsDir(path.join(REPO_ROOT, 'functions'))) fail('repo root `functions/` exists — would auto-enable Pages Functions');
else ok('repo root `functions/` absent');
if (existsDir(path.join(DIST, 'functions'))) fail('dist/browser/functions/ exists — Pages Functions would be enabled');
else ok('dist/browser/functions/ absent');
if (diskFiles.has('/_worker.js')) fail('dist/browser/_worker.js exists — Pages Functions would be enabled');
else ok('dist/browser/_worker.js absent');

// 5. .map 文件
const mapFiles = [...diskFiles.keys()].filter((requestPath) => requestPath.endsWith('.map'));
if (mapFiles.length > 0) {
  fail(`Found ${mapFiles.length} .map files in dist/browser — sourcemap should be disabled or stripped:\n    ${mapFiles.slice(0, 5).map((file) => file.slice(1)).join('\n    ')}`);
} else {
  ok('no .map files in dist/browser');
}

// 6. _headers 规则数
const headersText = artifactText('/_headers') ?? '';
if (!diskFiles.has('/_headers')) {
  fail('dist/browser/_headers missing — public/_headers must be copied at build');
} else {
  const ruleCount = headersText.split('\n').filter((l) => /^\/(?:$|[^\s])/.test(l)).length;
  if (ruleCount > 90) fail(`_headers rule count ${ruleCount} > 90 (Cloudflare limit 100, keeping 10 buffer)`);
  else ok(`_headers rule count = ${ruleCount} (≤ 90)`);

  const rootHeaders = readHeaderRule(headersText, '/');
  if (!/no-store/i.test(rootHeaders['cache-control'] || '')) {
    fail('_headers missing explicit "/" Cache-Control no-store rule; Cloudflare Pages serves the app shell at /');
  } else {
    ok('_headers has explicit "/" no-store rule');
  }

  const wildcardHeaders = readHeaderRule(headersText, '/*');
  if (wildcardHeaders.link !== '!') {
    fail('_headers wildcard rule must contain `! Link`; this suppresses automatic Link/modulepreload headers');
  } else {
    ok('_headers wildcard rule removes Link header');
  }
}

// 7. 总文件数
if (diskFiles.size > 18000) fail(`dist/browser file count ${diskFiles.size} > 18000`);
else ok(`dist/browser file count = ${diskFiles.size} (≤ 18000)`);

// 8. 根目录 .js 必须匹配已知模式
const rootJs = [...diskFiles.keys()].filter((requestPath) => /^\/[^/]+\.js$/.test(requestPath)).map((requestPath) => requestPath.slice(1));
const allowedRootJsRe = /^(main|polyfills|chunk|worker|runtime)-|^(sw-composed|ngsw-worker|safety-worker|worker-basic\.min)\.js$/;
const unmatched = rootJs.filter((n) => !allowedRootJsRe.test(n));
if (unmatched.length > 0) fail(`Unexpected JS files at dist/browser root: ${unmatched.join(', ')}`);
else ok(`all root JS (${rootJs.length}) match expected patterns`);

// 9. _headers 不允许宽泛 worker 规则
if (headersText) {
  if (/^\/worker\*\.js\b|^\/worker-\*\.js\b/m.test(headersText)) {
    fail('_headers contains broad /worker*.js or /worker-*.js immutable rule (would catch worker-basic.min.js)');
  } else {
    ok('_headers has no broad /worker*.js rule');
  }
}

// 10. ngsw-config.json 不允许宽泛 worker glob
const ngswConfigPath = path.join(REPO_ROOT, 'ngsw-config.json');
if (existsFile(ngswConfigPath)) {
  const ngswConfig = fs.readFileSync(ngswConfigPath, 'utf-8');
  if (/"\/worker\*\.js"|"\/worker-\*\.js"/.test(ngswConfig)) {
    fail('ngsw-config.json uses broad /worker*.js or /worker-*.js (would cache Angular safety workers)');
  } else {
    ok('ngsw-config.json has no broad worker glob');
  }
} else {
  fail('ngsw-config.json missing');
}

// 11. dist/browser/ngsw.json 应用 assetGroups 不应包含 safety workers
let buildStats = null;
let requiredCacheableOutputs;
if (!existsFile(STATS)) {
  fail('dist/stats.json missing — strict deployment builds must emit stats metadata');
} else {
  try {
    buildStats = JSON.parse(fs.readFileSync(STATS, 'utf-8'));
    const statsFiles = new Map([...browserEvidence].map(([requestPath, snapshot]) => [
      requestPath, { size: snapshot.size },
    ]));
    const statsOutputs = projectStats({ stats: buildStats, files: statsFiles });
    requiredCacheableOutputs = requiredCacheableBrowserOutputs(statsOutputs, statsFiles);
    ok('dist/stats.json available for CSS runtime relationship validation');
  } catch (e) {
    fail(`dist/stats.json parse failed: ${e.message}`);
  }
}

let ngswJson = null;
if (diskFiles.has('/ngsw.json')) {
  try {
    ngswJson = parseNgsw(diskFiles.get('/ngsw.json').content);
    const postFiles = browserEvidence;
    validateNgswPost(ngswJson, postFiles, undefined, requiredCacheableOutputs);
  } catch {
    fail('artifact-evidence-ngsw');
  }
  const assetGroups = Array.isArray(ngswJson.assetGroups) ? ngswJson.assetGroups : [];
  let safetyInAssets = false;
  for (const group of assetGroups) {
    const urls = Array.isArray(group?.urls) ? group.urls : [];
    if (urls.some((u) => /\/(worker-basic\.min|safety-worker)\.js$/.test(u))) safetyInAssets = true;
  }
  if (safetyInAssets) fail('Generated ngsw.json includes worker-basic.min.js or safety-worker.js in assetGroups');
  else ok('Generated ngsw.json does not list safety workers in assetGroups');
} else {
  fail('dist/browser/ngsw.json missing');
}

const findCssArtifactIssues = () => {
  const rootCss = [...diskFiles.keys()]
    .filter((requestPath) => /^\/[^/]+\.css$/.test(requestPath))
    .map((requestPath) => requestPath.slice(1));
  const cssByContent = new Map();
  for (const file of rootCss) {
    const contentKey = diskFiles.get(`/${file}`).content.toString('base64');
    const matches = cssByContent.get(contentKey) || [];
    matches.push(file);
    cssByContent.set(contentKey, matches);
  }
  const duplicateCssGroups = [...cssByContent.values()].filter((files) => files.length > 1);
  const runtimeSources = [...diskFiles.entries()]
    .filter(([requestPath]) => /\.(?:html|m?js)$/.test(requestPath))
    .map(([, snapshot]) => snapshot.content.toString('utf8'));
  const assetGroups = Array.isArray(ngswJson?.assetGroups) ? ngswJson.assetGroups : [];
  const cachedRootCss = new Set(assetGroups
    .flatMap((group) => Array.isArray(group?.urls) ? group.urls : [])
    .filter((url) => /^\/[^/]+\.css$/.test(url)));
  const statsReferences = statsReferencedRootCss(DIST, buildStats, rootCss);
  const orphanCachedCss = rootCss
    .filter((file) => cachedRootCss.has(`/${file}`))
    .filter((file) => runtimeSources.every((source) => !source.includes(file)))
    .filter((file) => !statsReferences.has(file));
  return { duplicateCssGroups, orphanCachedCss };
};

if (ngswJson) {
  const { duplicateCssGroups, orphanCachedCss } = findCssArtifactIssues(DIST, ngswJson, buildStats);
  for (const group of duplicateCssGroups) {
    fail(`Byte-identical root CSS artifacts: ${group.join(', ')}`);
  }
  if (orphanCachedCss.length > 0) {
    fail(`Generated ngsw.json caches root CSS with no HTML/JS or stats cssBundle runtime reference: ${orphanCachedCss.join(', ')}`);
  }
  if (duplicateCssGroups.length === 0 && orphanCachedCss.length === 0) {
    ok('root CSS artifacts are unique and runtime-referenced when cached by ngsw.json');
  }
}

// 12. 非 hash 公共资源不应 immutable
if (headersText) {
  const lines = headersText.split('\n');
  let pubRule = null;
  for (const line of lines) {
    const m = line.match(/^\/(assets|icons|fonts|widgets)\//);
    if (m) { pubRule = m[0]; continue; }
    if (/^\/[^\s]/.test(line)) { pubRule = null; continue; }
    if (pubRule && /(immutable|max-age=31536000)/i.test(line)) {
      fail(`Non-hash public path ${pubRule} uses immutable: "${line.trim()}"`);
      pubRule = null;
    }
  }
  ok('non-hash public paths (fonts/icons/assets/widgets) do not use immutable');
}

// 13. 应用 Web Worker chunk 必须有精确 immutable 规则
const workerChunks = rootJs.filter((n) => /^worker-/.test(n) && n !== 'worker-basic.min.js');
for (const chunk of workerChunks) {
  if (!new RegExp(`^/${chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(headersText)) {
    fail(`Application worker chunk /${chunk} missing exact immutable rule in _headers`);
  }
}
if (workerChunks.length > 0) ok(`${workerChunks.length} application worker chunk(s) have exact rules`);

// 14. manifest.webmanifest 不含 vercel.app，manifest.webmanifest id/scope/start_url 不绑定旧 origin
const manifestText = artifactText('/manifest.webmanifest');
if (manifestText !== null) {
  if (/vercel\.app/i.test(manifestText)) fail('dist/browser/manifest.webmanifest contains "vercel.app" — id/scope/start_url must be relative or canonical');
  else ok('manifest.webmanifest contains no vercel.app reference');
  try {
    const manifest = JSON.parse(manifestText);
    for (const field of ['id', 'scope', 'start_url']) {
      if (!isRelativeOrRootUrl(manifest[field])) {
        fail(`manifest.webmanifest ${field} must be relative/root-scoped, got ${JSON.stringify(manifest[field])}`);
      }
    }
    ok('manifest.webmanifest id/scope/start_url are origin-neutral');
  } catch (e) {
    fail(`manifest.webmanifest parse failed: ${e.message}`);
  }
} else {
  fail('dist/browser/manifest.webmanifest missing');
}

// 15. TWA assetlinks.json 与 package / fingerprint 集合匹配
if (!diskFiles.has('/.well-known/assetlinks.json')) {
  fail('dist/browser/.well-known/assetlinks.json missing');
} else {
  try {
    const assetlinks = JSON.parse(artifactText('/.well-known/assetlinks.json'));
    const expectedPackageName = process.env.ANDROID_TWA_PACKAGE_NAME || DEFAULT_TWA_PACKAGE_NAME;
    const expectedFingerprintEnv = process.env.ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS
      || process.env.ANDROID_TWA_SHA256_FINGERPRINTS;
    const expectedFingerprints = parseFingerprintList(expectedFingerprintEnv);
    if (!expectedFingerprints) {
      fail('assetlinks.json expected TWA fingerprint environment is missing or invalid');
    } else {
      const statements = Array.isArray(assetlinks) ? assetlinks : [];
      const androidStatement = statements.find((statement) =>
        statement?.target?.namespace === 'android_app'
        && statement.target.package_name === expectedPackageName
      );
      if (!androidStatement) {
        fail(`assetlinks.json missing android_app statement for ANDROID_TWA_PACKAGE_NAME=${expectedPackageName}`);
      } else {
        const actualFingerprints = Array.isArray(androidStatement.target.sha256_cert_fingerprints)
          ? androidStatement.target.sha256_cert_fingerprints
          : [];
        if (actualFingerprints.length === 0) {
          fail('assetlinks.json android_app statement has no sha256_cert_fingerprints');
        }
        for (const fingerprint of expectedFingerprints) {
          if (!actualFingerprints.includes(fingerprint)) {
            fail(`assetlinks.json missing ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS entry: ${fingerprint}`);
          }
        }
        ok(`assetlinks.json package=${expectedPackageName} fingerprints=${actualFingerprints.length}`);
      }
    }
  } catch (e) {
    fail(`assetlinks.json parse failed: ${e.message}`);
  }
}

// 16. version.json 存在且合法
if (!diskFiles.has('/version.json')) {
  fail('dist/browser/version.json missing — run `node scripts/generate-version-json.cjs`');
} else {
  try {
    const vj = JSON.parse(artifactText('/version.json'));
    const required = ['gitSha', 'buildTime', 'environment', 'appVersion', 'deploymentTarget', 'supabaseProjectAlias', 'sentryRelease', 'ngswHash'];
    const missing = required.filter((k) => !(k in vj));
    if (missing.length > 0) {
      fail(`version.json missing fields: ${missing.join(', ')}`);
    } else if (typeof vj.gitSha !== 'string' || vj.gitSha.trim().length === 0) {
      fail('version.json gitSha must be a non-empty string');
    } else if (typeof vj.buildTime !== 'string' || Number.isNaN(Date.parse(vj.buildTime))) {
      fail('version.json buildTime must be a valid ISO timestamp');
    } else if (typeof vj.environment !== 'string' || vj.environment.trim().length === 0) {
      fail('version.json environment must be a non-empty string');
    } else if (typeof vj.appVersion !== 'string' || vj.appVersion.trim().length === 0) {
      fail('version.json appVersion must be a non-empty string');
    } else if (typeof vj.deploymentTarget !== 'string' || vj.deploymentTarget.trim().length === 0) {
      fail('version.json deploymentTarget must be a non-empty string');
    } else if (typeof vj.supabaseProjectAlias !== 'string' || vj.supabaseProjectAlias.trim().length === 0) {
      fail('version.json supabaseProjectAlias must be a non-empty string');
    } else if (typeof vj.sentryRelease !== 'string') {
      fail('version.json sentryRelease must be a string');
    } else if (diskFiles.has('/ngsw.json') && (typeof vj.ngswHash !== 'string' || vj.ngswHash.trim().length === 0)) {
      fail('version.json ngswHash must be a non-empty string when ngsw.json exists');
    } else {
      ok(`version.json valid (gitSha=${String(vj.gitSha).slice(0, 8)}, target=${vj.deploymentTarget})`);
    }
    // 不得包含敏感字段
    const forbidden = ['supabaseAnonKey', 'sentryDsn', 'cloudflareAccountId', 'cloudflareApiToken'];
    const leaks = forbidden.filter((k) => k in vj);
    if (leaks.length > 0) fail(`version.json leaks secrets: ${leaks.join(', ')}`);
  } catch (e) {
    fail(`version.json parse failed: ${e.message}`);
  }
}

// 17. artifact manifest 存在且合法
const manifestFailureBaseline = failures.length;
try {
  const artifactManifestText = artifactText('/artifact-manifest.json');
  const am = JSON.parse(artifactManifestText);
  const missingTopLevel = ['schemaVersion', 'metrics', 'files'].filter((key) => !(key in am));
  if (missingTopLevel.length > 0) fail(`artifact manifest missing fields: ${missingTopLevel.join(', ')}`);

  const files = am.files !== null && typeof am.files === 'object' && !Array.isArray(am.files) ? am.files : {};
  if (files !== am.files) fail('artifact-manifest-files-invalid');
  const manifestDiskFiles = new Map(diskFiles);
  manifestDiskFiles.delete('/artifact-manifest.json');
  const manifestPaths = Object.keys(files).sort((left, right) => Number(left > right) - Number(left < right));
  const pathsCanonical = manifestPaths.every((requestPath) => {
    if (!requestPath.startsWith('/') || requestPath.startsWith('//') || requestPath.includes('\\')) return false;
    return requestPath.slice(1).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  });
  if (!pathsCanonical) {
    fail('artifact-manifest-path-noncanonical');
  } else {
    for (const requestPath of manifestPaths) if (!manifestDiskFiles.has(requestPath)) fail(`artifact-manifest-file-missing-on-disk:${requestPath}`);
    for (const requestPath of manifestDiskFiles.keys()) if (!Object.hasOwn(files, requestPath)) fail(`artifact-manifest-unadvertised-disk-file:${requestPath}`);
    for (const requestPath of manifestPaths) {
      const entry = files[requestPath];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(`artifact manifest invalid file entry: ${requestPath}`);
        continue;
      }
      for (const key of ['sha256', 'size', 'contentType', 'cachePolicy']) if (!Object.hasOwn(entry, key)) fail(`artifact manifest ${requestPath} missing ${key}`);
      const disk = manifestDiskFiles.get(requestPath);
      if (!disk) continue;
      if (entry.size !== disk.stat.size) fail(`artifact-manifest-size-mismatch:${requestPath}`);
      if (entry.sha256 !== crypto.createHash('sha256').update(disk.content).digest('hex')) fail(`artifact-manifest-sha256-mismatch:${requestPath}`);
    }
  }

  for (const requestPath of ['/index.html', '/launch.html']) {
    if (files[requestPath] && !Array.isArray(files[requestPath].modulepreload)) fail(`artifact manifest ${requestPath} missing modulepreload list`);
  }
  const forbidden = ['supabaseAnonKey', 'sentryDsn', 'cloudflareAccountId', 'cloudflareApiToken'];
  const leaks = forbidden.filter((needle) => artifactManifestText.includes(needle));
  if (leaks.length > 0) fail(`artifact manifest leaks secret-like fields: ${leaks.join(', ')}`);
  const metricFileCount = Number(am.metrics?.fileCount);
  if (Number.isFinite(metricFileCount) && metricFileCount !== manifestDiskFiles.size) {
    fail(`artifact manifest fileCount ${metricFileCount} does not match dist/browser files excluding manifest (${manifestDiskFiles.size})`);
  }
  const metrics = am.metrics;
  const candidates = metrics?.candidates;
  const currentCandidates = readCandidateCensus(REPO_ROOT);
  const candidateKeys = 'bytes,encoding,finalLF,kind,maxLine,path,physicalLF,role,sha256';
  if (!Array.isArray(candidates) || metrics.candidateCount !== 17
    || metrics.candidateSetDigest !== canonicalDigest(candidates)
    || metrics.candidateSetDigest !== currentCandidates.candidateSetDigest
    || JSON.stringify(candidates) !== JSON.stringify(currentCandidates.candidates)
    || candidates.some(candidate => Object.keys(candidate).sort().join(',') !== candidateKeys)) {
    fail('artifact-manifest-candidate-set-drift');
  }
  const finalFiles = [...browserEvidence.entries()]
    .filter(([requestPath]) => requestPath !== '/artifact-manifest.json')
    .map(([requestPath, record]) => {
      const identityBytes = sharedIdentityBytes({ requestPath, bytes: record.bytes });
      return {
        path: requestPath,
        bytes: identityBytes.length,
        sha256: crypto.createHash('sha256').update(identityBytes).digest('hex'),
      };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const diskFinalFiles = [...manifestDiskFiles.entries()]
    .map(([requestPath, record]) => {
      const identityBytes = sharedIdentityBytes({ requestPath, bytes: record.content });
      return {
        path: requestPath,
        bytes: identityBytes.length,
        sha256: crypto.createHash('sha256').update(identityBytes).digest('hex'),
      };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const shared = metrics.sharedIdentity;
  const sharedKeys = 'candidateSetDigest,fileCount,filesDigest,readerReceiptId,stable';
  if (!shared || Object.keys(shared).sort().join(',') !== sharedKeys
    || shared.readerReceiptId !== 'SRC-B' || shared.stable !== true
    || shared.fileCount !== finalFiles.length
    || shared.filesDigest !== canonicalDigest(finalFiles)
    || JSON.stringify(finalFiles) !== JSON.stringify(diskFinalFiles)
    || shared.candidateSetDigest !== metrics.candidateSetDigest) {
    fail('artifact-manifest-shared-identity-drift');
  }
  const manifestWithoutDigest = structuredClone(am);
  delete manifestWithoutDigest.metrics.manifestDigest;
  if (!/^[a-f0-9]{64}$/.test(metrics.manifestDigest ?? '')
    || metrics.manifestDigest !== canonicalDigest(manifestWithoutDigest)) {
    fail('artifact-manifest-semantic-digest-mismatch');
  }
  if (failures.length === manifestFailureBaseline) ok(`artifact manifest valid (files=${metricFileCount || 'unknown'}, rules=${am.metrics?.headerRuleCount ?? 'unknown'})`);
} catch {
  fail('artifact-manifest-json-invalid:/artifact-manifest.json');
}

// 18. index.html 存在
if (!diskFiles.has('/index.html')) fail('dist/browser/index.html missing');
else ok('index.html present');

// 汇报
console.log('');
if (failures.length > 0) {
  console.error('✗ check-deploy-artifacts FAILED:');
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log(`✓ check-deploy-artifacts PASSED (${diskFiles.size} files)`);
}

if (require.main === module) {
  main();
}

module.exports = { findCssArtifactIssues };
