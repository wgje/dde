/**
 * 构建后处理脚本：注入 modulepreload 链接
 *
 * 【性能优化 2026-02-05】
 *
 * 目的：
 * - 在 index.html 中注入关键 JS 模块的 modulepreload 提示
 * - 让浏览器提前加载和解析关键模块，减少链式加载延迟
 *
 * 运行时机：
 * - 在 `npm run build` 之后自动运行
 *
 * 预期收益：
 * - 减少 JS 加载时间 200-500ms
 * - 改善关键路径延迟
 *
 * 【增强 2026-02-05】
 * - 智能选择：基于文件大小排序，预加载前 N 大模块
 * - 排除 Sentry：避免阻塞首屏渲染
 * - 优先级排序：main > polyfills > vendor chunks
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

// 预加载模块数量限制（避免过多 preload 适得其反）
const MAX_PRELOAD_MODULES = 6;

// 排除的模块模式（不应预加载的模块）
const EXCLUDED_PATTERNS = [
  /sentry/i,           // Sentry SDK - 懒加载
  /worker/i,           // Web Workers
  /\.map$/,            // Source maps
  /chunk-[A-Z0-9]+-gojs/i, // GoJS 流程图库 - 懒加载
  /^flow-/i,           // Flow 视图模块 - 懒加载
  /^text-/i,           // Text 视图模块 - 懒加载
  /^index-/i,          // 路由懒加载模块
  /project-shell/i,    // 项目 Shell - 懒加载
  /reset-password/i,   // 重置密码 - 懒加载
];

// 优先级模块模式（按优先级排序）
const PRIORITY_PATTERNS = [
  { pattern: /^main-[A-Z0-9]+\.js$/i, priority: 100 },
  { pattern: /^polyfills-[A-Z0-9]+\.js$/i, priority: 90 },
  { pattern: /angular/i, priority: 80 },
  { pattern: /vendor/i, priority: 70 },
  { pattern: /common/i, priority: 60 },
];

function findCriticalModules() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error('[inject-modulepreload] 构建目录不存在:', DIST_DIR);
    return [];
  }

  const files = fs.readdirSync(DIST_DIR);

  // 收集所有 JS 文件及其元数据
  const jsFiles = files
    .filter(f => f.endsWith('.js'))
    .filter(f => !EXCLUDED_PATTERNS.some(pattern => pattern.test(f)))
    .map(f => {
      const filePath = path.join(DIST_DIR, f);
      const stats = fs.statSync(filePath);

      // 计算优先级得分
      let priorityScore = 0;
      for (const { pattern, priority } of PRIORITY_PATTERNS) {
        if (pattern.test(f)) {
          priorityScore = priority;
          break;
        }
      }

      return {
        name: f,
        size: stats.size,
        priority: priorityScore,
        // 综合得分：优先级 * 1000 + 文件大小（大文件优先）
        score: priorityScore * 1000 + Math.min(stats.size / 1000, 500)
      };
    })
    // 按综合得分降序排序
    .sort((a, b) => b.score - a.score)
    // 取前 N 个
    .slice(0, MAX_PRELOAD_MODULES);

  console.log('[inject-modulepreload] 模块分析:');
  jsFiles.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.name} (${(f.size / 1024).toFixed(1)}KB, 优先级: ${f.priority})`);
  });

  return jsFiles.map(f => f.name);
}

function injectModulePreload(modules) {
  if (!fs.existsSync(INDEX_HTML)) {
    console.error('[inject-modulepreload] index.html 不存在:', INDEX_HTML);
    return false;
  }

  let html = fs.readFileSync(INDEX_HTML, 'utf-8');

  // 检查是否已经注入过
  if (html.includes('rel="modulepreload"')) {
    console.log('[inject-modulepreload] modulepreload 已存在，跳过注入');
    return true;
  }

  // 生成 modulepreload 链接
  const preloadLinks = modules.map(module =>
    `<link rel="modulepreload" href="/${module}">`
  ).join('\n  ');

  // 注入到 </head> 之前
  const injection = `
  <!-- 【性能优化】关键模块预加载 - 自动生成 -->
  ${preloadLinks}
`;

  html = html.replace('</head>', injection + '</head>');

  fs.writeFileSync(INDEX_HTML, html);
  return true;
}

function main() {
  console.log('[inject-modulepreload] 开始注入 modulepreload...');

  const modules = findCriticalModules();

  if (modules.length === 0) {
    console.warn('[inject-modulepreload] 未找到关键模块');
    return;
  }

  console.log('[inject-modulepreload] 找到关键模块:', modules);

  const success = injectModulePreload(modules);

  if (success) {
    console.log('[inject-modulepreload] 注入完成');
  } else {
    console.error('[inject-modulepreload] 注入失败');
    process.exit(1);
  }
}

main();
