const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(PROJECT_ROOT, 'index.html');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'browser');
const DIST_INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');
const DIST_LAUNCH_HTML_PATH = path.join(DIST_DIR, 'launch.html');

const REQUIRED_MARKERS = [
  'LAUNCH_SHARED_HEAD',
  'LAUNCH_SHARED_STYLES',
  'LAUNCH_SHARED_SNAPSHOT_RENDERER',
  'LAUNCH_SHARED_BOOT_FLAGS',
  'LAUNCH_SHARED_LOADER_DISMISS',
];

function countOccurrences(source, pattern) {
  const matches = source.match(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  return matches ? matches.length : 0;
}

function validateSourceMarkers(indexHtml) {
  const violations = [];
  let lastEnd = -1;

  for (const marker of REQUIRED_MARKERS) {
    const startToken = `<!-- ${marker}_START -->`;
    const endToken = `<!-- ${marker}_END -->`;
    const startCount = countOccurrences(indexHtml, startToken);
    const endCount = countOccurrences(indexHtml, endToken);
    const startIndex = indexHtml.indexOf(startToken);
    const endIndex = indexHtml.indexOf(endToken);

    if (startCount !== 1 || endCount !== 1) {
      violations.push(`${marker} 标记数量异常: start=${startCount}, end=${endCount}`);
      continue;
    }

    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      violations.push(`${marker} 标记顺序异常`);
      continue;
    }

    if (startIndex < lastEnd) {
      violations.push(`${marker} 标记顺序回退`);
      continue;
    }

    lastEnd = endIndex;
  }

  return violations;
}

function validateDistShell(html, shellName) {
  const violations = [];
  const bootFlagsIndex = html.indexOf('__NANOFLOW_BOOT_FLAGS__');
  const loaderDismissIndex = html.indexOf('nanoflow:boot-stage');
  const mainScriptIndex = html.search(/<script\b[^>]*src=["'][^"']*main-[A-Z0-9]+\.js["'][^>]*>/i);
  const polyfillsScriptIndex = html.search(/<script\b[^>]*src=["'][^"']*polyfills-[A-Z0-9]+\.js["'][^>]*>/i);

  if (bootFlagsIndex === -1) {
    violations.push(`${shellName} 缺少 Boot Flags`);
  }
  if (loaderDismissIndex === -1) {
    violations.push(`${shellName} 缺少 loader dismiss 脚本`);
  }
  if (mainScriptIndex === -1 || polyfillsScriptIndex === -1) {
    violations.push(`${shellName} 缺少 main/polyfills 入口脚本`);
  }

  if (bootFlagsIndex !== -1 && mainScriptIndex !== -1 && bootFlagsIndex > mainScriptIndex) {
    violations.push(`${shellName} Boot Flags 必须在 main 入口之前`);
  }
  if (loaderDismissIndex !== -1 && mainScriptIndex !== -1 && loaderDismissIndex > mainScriptIndex) {
    violations.push(`${shellName} loader dismiss 必须在 main 入口之前`);
  }

  return violations;
}

function validateCompatLaunchShell(html, shellName) {
  const violations = [];

  if (!/name=["']nanoflow-launch-mode["'][^>]*content=["']bootstrap-alias["']/i.test(html)) {
    violations.push(`${shellName} 缺少启动别名标记`);
  }

  if (!/history\.replaceState\(/i.test(html)) {
    violations.push(`${shellName} 缺少原地路径归一化脚本`);
  }

  violations.push(...validateDistShell(html, shellName));

  if (!/<app-root><\/app-root>/i.test(html)) {
    violations.push(`${shellName} 缺少 app-root 启动宿主`);
  }

  return violations;
}

function validateLaunchSharedMarkers(options = {}) {
  const indexHtmlPath = options.indexHtmlPath || INDEX_HTML_PATH;
  const distIndexHtmlPath = options.distIndexHtmlPath || DIST_INDEX_HTML_PATH;
  const distLaunchHtmlPath = options.distLaunchHtmlPath || DIST_LAUNCH_HTML_PATH;
  const violations = [];

  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`index.html 不存在: ${indexHtmlPath}`);
  }

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  violations.push(...validateSourceMarkers(indexHtml));

  if (fs.existsSync(distIndexHtmlPath)) {
    violations.push(...validateDistShell(fs.readFileSync(distIndexHtmlPath, 'utf8'), 'dist/index.html'));
  }

  if (fs.existsSync(distLaunchHtmlPath)) {
    violations.push(...validateCompatLaunchShell(fs.readFileSync(distLaunchHtmlPath, 'utf8'), 'dist/launch.html'));
  }

  return { violations };
}

function main() {
  const result = validateLaunchSharedMarkers();
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`[validate-launch-shared-markers] ❌ ${violation}`);
    }
    process.exit(1);
  }

  console.log('[validate-launch-shared-markers] ✅ index marker 与生成产物顺序校验通过');
}

if (require.main === module) {
  main();
}

module.exports = {
  validateLaunchSharedMarkers,
};
