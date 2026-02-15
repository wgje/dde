/**
 * 构建后处理脚本：规范化 modulepreload 策略
 *
 * 策略：
 * - STRICT_MODULEPRELOAD_V2=true（默认）：移除所有静态 modulepreload
 * - STRICT_MODULEPRELOAD_V2=false：仅注入少量 allowlist（最多 2 条）
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const RELAXED_MAX_PRELOAD_MODULES = 2;

const EXCLUDED_PATTERNS = [
  /sentry/i,
  /worker/i,
  /\.map$/i,
  /^main-[A-Z0-9]+\.js$/i,
  /^polyfills-[A-Z0-9]+\.js$/i,
  /gojs/i,
  /^flow-/i,
  /^text-/i,
  /^index-/i,
  /project-shell/i,
  /reset-password/i,
];

const PRIORITY_PATTERNS = [
  { pattern: /angular/i, priority: 100 },
  { pattern: /router/i, priority: 90 },
  { pattern: /core/i, priority: 80 },
  { pattern: /common/i, priority: 70 },
];

function readBuiltHtml() {
  if (!fs.existsSync(INDEX_HTML)) {
    throw new Error(`index.html 不存在: ${INDEX_HTML}`);
  }
  return fs.readFileSync(INDEX_HTML, 'utf-8');
}

function parseStrictMode(html) {
  const match = html.match(/STRICT_MODULEPRELOAD_V2:\s*(true|false)/);
  if (!match) return true;
  return match[1] === 'true';
}

function removeAllModulePreload(html) {
  const pattern = /<link\b[^>]*rel=["']modulepreload["'][^>]*>\s*/gi;
  const existing = html.match(pattern) || [];
  return {
    cleanedHtml: html.replace(pattern, ''),
    removedCount: existing.length,
  };
}

function computeRelaxedAllowlist() {
  if (!fs.existsSync(DIST_DIR)) return [];

  const files = fs.readdirSync(DIST_DIR);
  const candidates = files
    .filter((file) => file.endsWith('.js'))
    .filter((file) => !EXCLUDED_PATTERNS.some((pattern) => pattern.test(file)))
    .map((file) => {
      const size = fs.statSync(path.join(DIST_DIR, file)).size;
      let priority = 0;
      for (const item of PRIORITY_PATTERNS) {
        if (item.pattern.test(file)) {
          priority = item.priority;
          break;
        }
      }
      return {
        file,
        size,
        score: priority * 1000 + Math.min(size / 1024, 512),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, RELAXED_MAX_PRELOAD_MODULES);

  return candidates.map((item) => item.file);
}

function injectAllowlist(html, modules) {
  if (modules.length === 0) return html;
  const links = modules
    .map((moduleName) => `<link rel="modulepreload" href="/${moduleName}">`)
    .join('\n  ');

  const snippet = `
  <!-- modulepreload relaxed allowlist (auto-generated) -->
  ${links}
`;

  return html.replace('</head>', `${snippet}</head>`);
}

function main() {
  console.log('[inject-modulepreload] 开始规范化 modulepreload...');

  const html = readBuiltHtml();
  const strictMode = parseStrictMode(html);
  const { cleanedHtml, removedCount } = removeAllModulePreload(html);

  if (strictMode) {
    fs.writeFileSync(INDEX_HTML, cleanedHtml);
    console.log(`[inject-modulepreload] strict 模式：已移除 ${removedCount} 条 modulepreload`);
    return;
  }

  const allowlist = computeRelaxedAllowlist();
  const nextHtml = injectAllowlist(cleanedHtml, allowlist);
  fs.writeFileSync(INDEX_HTML, nextHtml);
  console.log(
    `[inject-modulepreload] relaxed 模式：移除 ${removedCount} 条，回填 ${allowlist.length} 条`,
    allowlist
  );
}

main();
