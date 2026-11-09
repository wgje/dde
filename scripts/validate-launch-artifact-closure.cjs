const fs = require('fs');
const path = require('path');

const DEFAULT_DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const LOCAL_URL_BASE = 'https://nanoflow.invalid/';

function contractError(reason, requestPath = '') {
  return new Error(requestPath ? `${reason}:${requestPath}` : reason);
}

function parseLocalAssetReference(raw) {
  if (!URL.canParse(raw, LOCAL_URL_BASE)) throw contractError('launch-artifact-path-invalid');
  const parsed = new URL(raw, LOCAL_URL_BASE);
  const rawPathname = raw.split(/[?#]/, 1)[0];
  if (parsed.protocol === 'file:' || /^\/?[A-Za-z]:/.test(rawPathname) || rawPathname.includes('\\')) {
    throw contractError('launch-artifact-path-invalid');
  }
  if (/^[A-Za-z][A-Za-z\d+.-]+:/.test(rawPathname) || rawPathname.startsWith('//')) {
    return null;
  }
  if (parsed.origin !== LOCAL_URL_BASE.slice(0, -1) || rawPathname.includes('%')) {
    throw contractError('launch-artifact-path-invalid');
  }
  const relativeRaw = rawPathname.startsWith('/') ? rawPathname.slice(1) : rawPathname;
  const segments = relativeRaw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw contractError('launch-artifact-path-invalid');
  }
  return /\.(?:js|css)$/.test(parsed.pathname) ? parsed.pathname : null;
}

function extractLocalAssetsFromLaunchHtml(html) {
  const assets = new Set();
  const assetPattern = /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = assetPattern.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const asset = parseLocalAssetReference(raw);
    if (asset) assets.add(asset);
  }
  return [...assets];
}

function requireRegularArtifact(distDir, requestPath) {
  const root = path.resolve(distDir);
  const segments = requestPath.slice(1).split('/');
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw contractError('launch-artifact-path-invalid');
  }
  let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw contractError('launch-artifact-file-unavailable', requestPath);
    }
    const isFinal = index === segments.length - 1;
    if (stat.isSymbolicLink() || (isFinal ? !stat.isFile() : !stat.isDirectory())) {
      throw contractError('launch-artifact-file-not-regular', requestPath);
    }
  }
}

function validateLaunchArtifactClosure(options = {}) {
  const distDir = options.distDir || DEFAULT_DIST_DIR;
  const launchHtmlPath = path.join(distDir, 'launch.html');
  const ngswPath = path.join(distDir, 'ngsw.json');
  if (!fs.existsSync(launchHtmlPath)) {
    throw new Error(`launch.html 不存在: ${launchHtmlPath}`);
  }
  if (!fs.existsSync(ngswPath)) {
    throw new Error(`ngsw.json 不存在: ${ngswPath}`);
  }
  const launchHtml = fs.readFileSync(launchHtmlPath, 'utf8');
  const assets = extractLocalAssetsFromLaunchHtml(launchHtml);
  const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
  const urls = new Set(
    (ngsw.assetGroups || [])
      .flatMap((group) => Array.isArray(group.urls) ? group.urls : [])
  );
  const hashTable = new Set(Object.keys(ngsw.hashTable || {}));
  const missing = assets.filter((asset) => !urls.has(asset) || !hashTable.has(asset));
  return {
    assets,
    missing,
  };
}

function main() {
  try {
    const result = validateLaunchArtifactClosure();
    if (result.missing.length > 0) {
      console.error(`[validate-launch-artifact-closure] 缺失资源: ${result.missing.join(', ')}`);
      process.exit(1);
    }
    console.log(`[validate-launch-artifact-closure] ✅ launch.html ${result.assets.length} 个本地资源已在 ngsw.json 闭环`);
  } catch (error) {
    const message = error instanceof Error && /^launch-artifact-/.test(error.message)
      ? error.message
      : 'launch-artifact-evidence-unavailable';
    console.error(`[validate-launch-artifact-closure] ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractLocalAssetsFromLaunchHtml,
  validateLaunchArtifactClosure,
};
