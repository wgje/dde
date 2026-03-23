/**
 * 构建后处理脚本：规范化 modulepreload 策略
 *
 * 策略：
 * - STRICT_MODULEPRELOAD_V2=true：移除所有静态 modulepreload
 * - STRICT_MODULEPRELOAD_V2=false（新默认）：
 *   1. 移除 Angular 自动生成的 initial chunk modulepreload
 *   2. 追踪从 main → 默认路由 (/projects) 的关键 chunk 链
 *   3. 注入关键路径 modulepreload（最多 MAX_CRITICAL_PRELOADS 条）
 *   这样浏览器可以并行下载整条链路，消除 10 级串行瀑布
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
/**
 * 关键路径 modulepreload 数量上限。
 * 过多会挤占带宽，过少则仍有瀑布；10 是经验值，覆盖 3-4 层 chunk 链。
 */
const MAX_CRITICAL_PRELOADS = 10;

/**
 * 排除的 chunk 模式：这些是非关键路径，不应出现在首屏 preload 中
 */
const EXCLUDED_PATTERNS = [
  /sentry/i,
  /gojs/i,
  /flow-view/i,
  /parking-dock/i,
  /settings-modal/i,
  /dashboard-modal/i,
  /focus-mode/i,
  /reset-password/i,
  /^ngsw-worker/i,
  /\.map$/i,
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

/**
 * 从 JS 文件中提取动态 import() 的 chunk 文件名
 */
function getChunkImports(filename) {
  const filepath = path.join(DIST_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, 'utf8');
  const re = /import\(["']\.\/([^"']+)["']\)/g;
  const imports = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/**
 * BFS 追踪从 main.js 开始的 chunk 依赖链。
 * 返回按发现顺序排列的 chunk 路径（排除 main/polyfills 自身）。
 * maxDepth 限制追踪深度，避免加载过多非关键 chunk。
 */
function traceCriticalChunks(mainFile, maxDepth) {
  const visited = new Set();
  const queue = [{ file: mainFile, depth: 0 }];
  const result = [];

  while (queue.length > 0) {
    const { file, depth } = queue.shift();
    if (visited.has(file) || depth > maxDepth) continue;
    visited.add(file);

    // 只收集非入口 chunk（main/polyfills 已经是 <script> 标签）
    if (depth > 0) {
      const isExcluded = EXCLUDED_PATTERNS.some((p) => p.test(file));
      if (!isExcluded) {
        const filepath = path.join(DIST_DIR, file);
        if (fs.existsSync(filepath)) {
          const size = fs.statSync(filepath).size;
          result.push({ file, depth, size });
        }
      }
    }

    const imports = getChunkImports(file);
    for (const imp of imports) {
      if (!visited.has(imp)) {
        queue.push({ file: imp, depth: depth + 1 });
      }
    }
  }
  return result;
}

/**
 * 对追踪到的 chunk 打分排序，选出最关键的 N 个。
 * 评分依据：深度越浅越关键（权重高），体积适中的优先（太大的可能是非关键特性 chunk）。
 */
function selectCriticalChunks(chunks, maxCount) {
  // 过滤掉超大 chunk（>200KB 通常是独立特性如 GoJS/parking）
  const candidates = chunks.filter((c) => c.size < 200 * 1024);

  // 按深度升序（浅的先）+ 同深度按体积降序（大的先，可能是共享依赖）
  candidates.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.size - a.size;
  });

  return candidates.slice(0, maxCount).map((c) => c.file);
}

function injectModulePreloads(html, modules) {
  if (modules.length === 0) return html;
  const links = modules
    .map((moduleName) => `<link rel="modulepreload" href="/${moduleName}">`)
    .join('\n  ');

  const snippet = `
  <!-- critical-path modulepreload (auto-generated, eliminates chunk waterfall) -->
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

  // 追踪关键路径 chunk（从 main 开始，最多 3 层深度）
  const files = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.js'));
  const mainFile = files.find((f) => /^main-/.test(f));
  if (!mainFile) {
    console.warn('[inject-modulepreload] 未找到 main-*.js，跳过关键路径追踪');
    fs.writeFileSync(INDEX_HTML, cleanedHtml);
    return;
  }

  const allChunks = traceCriticalChunks(mainFile, 3);
  const selected = selectCriticalChunks(allChunks, MAX_CRITICAL_PRELOADS);
  const nextHtml = injectModulePreloads(cleanedHtml, selected);
  fs.writeFileSync(INDEX_HTML, nextHtml);

  console.log(
    `[inject-modulepreload] 关键路径模式：移除 ${removedCount} 条原始 preload，注入 ${selected.length} 条关键路径 preload`
  );
  selected.forEach((f) => {
    const size = Math.round(fs.statSync(path.join(DIST_DIR, f)).size / 1024);
    console.log(`  - ${f} (${size}KB)`);
  });
}

main();
