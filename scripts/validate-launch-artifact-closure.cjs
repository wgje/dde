const fs = require('fs');
const path = require('path');

const DEFAULT_DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');

function extractLocalAssetsFromLaunchHtml(html) {
  const assets = new Set();
  const assetPattern = /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = assetPattern.exec(html)) !== null) {
    const raw = match[1];
    if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith('data:')) {
      continue;
    }

    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    if (/\.(?:js|css)$/.test(normalized)) {
      assets.add(normalized);
    }
  }

  return [...assets];
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
  const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
  const assets = extractLocalAssetsFromLaunchHtml(launchHtml);
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
  const result = validateLaunchArtifactClosure();
  if (result.missing.length > 0) {
    console.error(`[validate-launch-artifact-closure] 缺失资源: ${result.missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`[validate-launch-artifact-closure] ✅ launch.html ${result.assets.length} 个本地资源已在 ngsw.json 闭环`);
}

if (require.main === module) {
  main();
}

module.exports = {
  extractLocalAssetsFromLaunchHtml,
  validateLaunchArtifactClosure,
};
