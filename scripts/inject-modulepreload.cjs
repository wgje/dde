/**
 * 构建后处理脚本：规范化 modulepreload 策略
 *
 * 策略：
 * - STRICT_MODULEPRELOAD_V2=true：移除所有静态 modulepreload
 * - STRICT_MODULEPRELOAD_V2=false（新默认）：
 *   1. 移除 Angular 自动生成的 initial chunk modulepreload
 *   2. 追踪从 main 开始的共享依赖链
 *   3. 仅为小型共享 chunk 注入 modulepreload
 *   4. 路由组件 chunk / 重型功能 chunk 一律不进入首屏 preload
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const DEFAULT_INDEX_HTML = path.join(DEFAULT_DIST_DIR, 'index.html');
const DEFAULT_MAX_CRITICAL_PRELOADS = Number(process.env.STARTUP_MODULEPRELOAD_MAX || 6);
const DEFAULT_MAX_TRACE_DEPTH = Number(process.env.STARTUP_MODULEPRELOAD_TRACE_DEPTH || 3);
const MAX_PRELOAD_CHUNK_BYTES = Number(process.env.STARTUP_MAX_PRELOAD_CHUNK_BYTES || 96 * 1024);

const EXCLUDED_PATTERNS = [
  /sentry/i,
  /supabase/i,
  /gojs/i,
  /flow-view/i,
  /text-view/i,
  /workspace-shell/i,
  /project-shell/i,
  /parking-dock/i,
  /settings-modal/i,
  /dashboard-modal/i,
  /focus-mode/i,
  /reset-password/i,
  /error-page/i,
  /not-found/i,
  /^ngsw-worker/i,
  /\.map$/i,
];

const EXCLUDED_CONTENT_MARKERS = [
  'FunctionsError',
  'supabase',
  'WorkspaceShellComponent',
  'ProjectShellComponent',
  'TextViewComponent',
  'FlowViewComponent',
  'ParkingDockComponent',
  'FocusModeComponent',
  'GoJS',
  'gojs',
];

function readBuiltHtml(indexHtmlPath = DEFAULT_INDEX_HTML) {
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`index.html 不存在: ${indexHtmlPath}`);
  }
  return fs.readFileSync(indexHtmlPath, 'utf-8');
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

function getChunkImports(filename, distDir = DEFAULT_DIST_DIR) {
  const filepath = path.join(distDir, filename);
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, 'utf8');
  const re = /import\(["']\.\/([^"']+)["']\)/g;
  const imports = [];
  let match;

  while ((match = re.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

function isExcludedChunk(file, distDir = DEFAULT_DIST_DIR, options = {}) {
  const {
    excludedPatterns = EXCLUDED_PATTERNS,
    excludedContentMarkers = EXCLUDED_CONTENT_MARKERS,
    quiet = false,
  } = options;

  if (excludedPatterns.some((pattern) => pattern.test(file))) {
    return true;
  }

  const filepath = path.join(distDir, file);
  if (!fs.existsSync(filepath)) {
    return true;
  }

  const head = fs.readFileSync(filepath, 'utf8').slice(0, 65536);
  const contentExcluded = excludedContentMarkers.some((marker) =>
    head.toLowerCase().includes(marker.toLowerCase()),
  );
  if (contentExcluded && !quiet) {
    const size = Math.round(fs.statSync(filepath).size / 1024);
    console.log(`  [skip] ${file} (${size}KB) — 内容特征匹配，非首屏依赖`);
  }

  return contentExcluded;
}

function traceCriticalChunks(mainFile, maxDepth, distDir = DEFAULT_DIST_DIR, options = {}) {
  const visited = new Set();
  const queue = [{ file: mainFile, depth: 0 }];
  const result = [];

  while (queue.length > 0) {
    const { file, depth } = queue.shift();
    if (!file || visited.has(file) || depth > maxDepth) continue;
    visited.add(file);

    if (depth > 0 && !isExcludedChunk(file, distDir, options)) {
      const filepath = path.join(distDir, file);
      result.push({
        file,
        depth,
        size: fs.statSync(filepath).size,
      });
    }

    const imports = getChunkImports(file, distDir);
    for (const importedFile of imports) {
      if (!visited.has(importedFile)) {
        queue.push({ file: importedFile, depth: depth + 1 });
      }
    }
  }

  return result;
}

function selectCriticalChunks(chunks, maxCount, maxChunkBytes = MAX_PRELOAD_CHUNK_BYTES) {
  const candidates = chunks.filter((chunk) => chunk.size <= maxChunkBytes);
  candidates.sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    return right.size - left.size;
  });

  return candidates.slice(0, maxCount).map((chunk) => chunk.file);
}

function injectModulePreloads(html, modules) {
  if (modules.length === 0) return html;

  const links = modules
    .map((moduleName) => `<link rel="modulepreload" href="/${moduleName}">`)
    .join('\n  ');

  const snippet = `
  <!-- critical-path modulepreload (auto-generated, shared startup deps only) -->
  ${links}
`;

  return html.replace('</head>', `${snippet}</head>`);
}

function findMainFile(distDir = DEFAULT_DIST_DIR) {
  return fs.readdirSync(distDir).find((file) => /^main-.*\.js$/.test(file)) || null;
}

function processModulePreload(options = {}) {
  const {
    distDir = DEFAULT_DIST_DIR,
    indexHtmlPath = path.join(distDir, 'index.html'),
    maxCriticalPreloads = DEFAULT_MAX_CRITICAL_PRELOADS,
    maxTraceDepth = DEFAULT_MAX_TRACE_DEPTH,
    maxChunkBytes = MAX_PRELOAD_CHUNK_BYTES,
    quiet = false,
  } = options;

  const html = readBuiltHtml(indexHtmlPath);
  const strictMode = parseStrictMode(html);
  const { cleanedHtml, removedCount } = removeAllModulePreload(html);

  if (strictMode) {
    fs.writeFileSync(indexHtmlPath, cleanedHtml);
    return { strictMode, removedCount, selected: [] };
  }

  const mainFile = findMainFile(distDir);
  if (!mainFile) {
    fs.writeFileSync(indexHtmlPath, cleanedHtml);
    return { strictMode, removedCount, selected: [] };
  }

  const allChunks = traceCriticalChunks(mainFile, maxTraceDepth, distDir, { quiet });
  const selected = selectCriticalChunks(allChunks, maxCriticalPreloads, maxChunkBytes);
  const nextHtml = injectModulePreloads(cleanedHtml, selected);
  fs.writeFileSync(indexHtmlPath, nextHtml);

  return { strictMode, removedCount, selected };
}

function main() {
  console.log('[inject-modulepreload] 开始规范化 modulepreload...');
  const result = processModulePreload();

  if (result.strictMode) {
    console.log(`[inject-modulepreload] strict 模式：已移除 ${result.removedCount} 条 modulepreload`);
    return;
  }

  console.log(
    `[inject-modulepreload] 关键路径模式：移除 ${result.removedCount} 条原始 preload，注入 ${result.selected.length} 条关键路径 preload`
  );
  result.selected.forEach((file) => {
    const size = Math.round(fs.statSync(path.join(DEFAULT_DIST_DIR, file)).size / 1024);
    console.log(`  - ${file} (${size}KB)`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_DIST_DIR,
  DEFAULT_INDEX_HTML,
  DEFAULT_MAX_CRITICAL_PRELOADS,
  EXCLUDED_PATTERNS,
  EXCLUDED_CONTENT_MARKERS,
  MAX_PRELOAD_CHUNK_BYTES,
  findMainFile,
  getChunkImports,
  injectModulePreloads,
  isExcludedChunk,
  main,
  parseStrictMode,
  processModulePreload,
  readBuiltHtml,
  removeAllModulePreload,
  selectCriticalChunks,
  traceCriticalChunks,
};
