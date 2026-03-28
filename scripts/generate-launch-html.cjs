const fs = require('fs');
const path = require('path');

const DEFAULT_DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const DEFAULT_INDEX_HTML = path.join(DEFAULT_DIST_DIR, 'index.html');
const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'launch.html');
const DEFAULT_OUTPUT_PATH = path.join(DEFAULT_DIST_DIR, 'launch.html');

function readFileStrict(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`文件不存在: ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

function extractMarkedBlock(html, name, options = {}) {
  const start = `<!-- ${name}_START -->`;
  const end = `<!-- ${name}_END -->`;
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    if (options.optional) {
      return '';
    }
    throw new Error(`缺少标记块: ${name}`);
  }

  return html.slice(startIndex + start.length, endIndex).trim();
}

function extractBodyOpenTag(html) {
  const match = html.match(/<body\b[^>]*>/i);
  if (!match) return '<body>';
  // 移除 Tailwind 工具类 — launch.html 不包含 Tailwind CSS 定义，保留无效 class 会产生样式不一致
  return match[0].replace(/\bclass="[^"]*"/, '');
}

function extractEntryScripts(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*src=["']([^"']+)["'][^>]*type=["']module["'][^>]*><\/script>|<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*><\/script>/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const src = match[1] || match[2];
    if (!src) continue;
    scripts.push(src);
  }

  return scripts
    .filter((src) => /^polyfills-.*\.js$/.test(src) || /^main-.*\.js$/.test(src))
    .map((src) => `<script src="${src}" type="module"></script>`);
}

function buildLaunchHtml(indexHtml, templateHtml = '') {
  if (!templateHtml.trim()) {
    throw new Error('launch.html 模板不能为空');
  }

  const headShared = extractMarkedBlock(indexHtml, 'LAUNCH_SHARED_HEAD');
  const stylesShared = extractMarkedBlock(indexHtml, 'LAUNCH_SHARED_STYLES', { optional: true });
  const bootFlags = extractMarkedBlock(indexHtml, 'LAUNCH_SHARED_BOOT_FLAGS');
  const shell = extractMarkedBlock(indexHtml, 'LAUNCH_SHARED_SHELL', { optional: true });
  const snapshotRenderer = extractMarkedBlock(indexHtml, 'LAUNCH_SHARED_SNAPSHOT_RENDERER', { optional: true });
  const loaderDismiss = extractMarkedBlock(indexHtml, 'LAUNCH_SHARED_LOADER_DISMISS');
  const bodyOpenTag = extractBodyOpenTag(indexHtml);
  const entryScripts = extractEntryScripts(indexHtml);

  if (entryScripts.length === 0) {
    throw new Error('未在 index.html 中找到 main/polyfills 入口脚本，launch.html 无法引导 Angular');
  }

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    headShared,
    stylesShared,
    '</head>',
    bodyOpenTag,
    '<div id="initial-loader">',
    shell,
    '</div>',
    bootFlags,
    snapshotRenderer,
    '<app-root></app-root>',
    loaderDismiss,
    ...entryScripts,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function generateLaunchHtml(options = {}) {
  const distDir = options.distDir || DEFAULT_DIST_DIR;
  const indexHtmlPath = options.indexHtmlPath || path.join(distDir, 'index.html');
  const outputPath = options.outputPath || path.join(distDir, 'launch.html');
  const templatePath = options.templatePath || DEFAULT_TEMPLATE_PATH;

  const indexHtml = readFileStrict(indexHtmlPath);
  const templateHtml = readFileStrict(templatePath);
  const launchHtml = buildLaunchHtml(indexHtml, templateHtml);
  fs.writeFileSync(outputPath, launchHtml);

  return {
    outputPath,
    bytes: Buffer.byteLength(launchHtml),
  };
}

function main() {
  const result = generateLaunchHtml();
  console.log(`[generate-launch-html] 已生成 ${result.outputPath} (${result.bytes} bytes)`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_DIST_DIR,
  DEFAULT_INDEX_HTML,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_TEMPLATE_PATH,
  buildLaunchHtml,
  extractBodyOpenTag,
  extractEntryScripts,
  extractMarkedBlock,
  generateLaunchHtml,
  main,
};
