const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const DEFAULT_NGSW_PATH = path.join(DEFAULT_DIST_DIR, 'ngsw.json');
const DEFAULT_HTML_FILES = ['index.html', 'launch.html'];

function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function patchNgswHtmlHashes(options = {}) {
  const distDir = options.distDir || DEFAULT_DIST_DIR;
  const ngswPath = options.ngswPath || path.join(distDir, 'ngsw.json');
  const htmlFiles = options.htmlFiles || DEFAULT_HTML_FILES;

  if (!fs.existsSync(ngswPath)) {
    throw new Error(`ngsw.json 不存在: ${ngswPath}`);
  }

  const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
  if (!ngsw.hashTable || typeof ngsw.hashTable !== 'object') {
    ngsw.hashTable = {};
  }

  const updated = [];
  for (const htmlFile of htmlFiles) {
    const filepath = path.join(distDir, htmlFile);
    if (!fs.existsSync(filepath)) continue;
    const content = fs.readFileSync(filepath, 'utf8');
    ngsw.hashTable[`/${htmlFile}`] = sha1(content);
    updated.push(`/${htmlFile}`);
  }

  fs.writeFileSync(ngswPath, JSON.stringify(ngsw, null, 2));
  return updated;
}

function main() {
  const updated = patchNgswHtmlHashes();
  console.log(`[patch-ngsw-html-hashes] 已更新 ${updated.length} 个 HTML hash: ${updated.join(', ')}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_DIST_DIR,
  DEFAULT_HTML_FILES,
  DEFAULT_NGSW_PATH,
  main,
  patchNgswHtmlHashes,
  sha1,
};
