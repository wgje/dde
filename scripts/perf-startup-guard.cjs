/**
 * 启动性能构建门禁
 * - main 包体 <= 260KB（raw）
 * - main 静态 import-statement 数量 <= 10
 * - main/polyfills 静态依赖闭包体积 <= 340KB（raw）
 * - workspace shell chunk <= 125KB（raw）
 * - modulepreload 数量 <= 10
 * - 首屏 modulepreload 不允许包含 route component chunk
 * - main 不包含 @angular/compiler
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(PROJECT_ROOT, 'dist', 'browser', 'index.html');
const LAUNCH_HTML_PATH = path.join(PROJECT_ROOT, 'dist', 'browser', 'launch.html');
const STATS_CANDIDATES = [
  path.join(PROJECT_ROOT, 'dist', 'stats.json'),
  path.join(PROJECT_ROOT, 'dist', 'browser', 'stats.json'),
];

const STARTUP_MAIN_MAX_KB = Number(process.env.STARTUP_MAIN_MAX_KB || 260);
const STARTUP_MODULEPRELOAD_MAX = Number(process.env.STARTUP_MODULEPRELOAD_MAX || 8);
const STARTUP_INITIAL_STATIC_JS_MAX_KB = Number(process.env.STARTUP_INITIAL_STATIC_JS_MAX_KB || 340);
const STARTUP_WORKSPACE_CHUNK_MAX_KB = Number(process.env.STARTUP_WORKSPACE_CHUNK_MAX_KB || 125);
const STARTUP_MAIN_STATIC_IMPORT_MAX = Number(process.env.STARTUP_MAIN_STATIC_IMPORT_MAX || 10);
const STARTUP_LAUNCH_DISCOVERY_MAX_BYTES = Number(process.env.STARTUP_LAUNCH_DISCOVERY_MAX_BYTES || 16384);
const HOTPATH_CONFIG_BARREL_BAN_ENABLED = String(
  process.env.HOTPATH_CONFIG_BARREL_BAN_ENABLED ?? 'true'
).toLowerCase() !== 'false';

const FORBIDDEN_INITIAL_INPUTS = [
  'src/app/core/services/simple-sync.service.ts',
  'src/app/core/services/sync/retry-queue.service.ts',
  'src/services/user-session.service.ts',
  'src/services/guards/unsaved-changes.guard.ts',
];
const HOTPATH_CONFIG_BARREL_BAN_FILES = [
  'src/services/global-error-handler.service.ts',
  'src/services/toast.service.ts',
  'src/services/pwa-install-prompt.service.ts',
  'src/services/remote-change-handler.service.ts',
  'src/app/core/services/app-auth-coordinator.service.ts',
  'src/app/shared/components/sync-status.component.ts',
];
const FORBIDDEN_MODULEPRELOAD_PATTERNS = [
  /text-view/i,
  /flow-view/i,
  /workspace-shell/i,
  /project-shell/i,
];
const FORBIDDEN_MODULEPRELOAD_MARKERS = [
  'TextViewComponent',
  'FlowViewComponent',
  'WorkspaceShellComponent',
  'ProjectShellComponent',
];

function fail(message) {
  console.error(`[perf-startup-guard] ❌ ${message}`);
  process.exit(1);
}

function toKB(bytes) {
  return Number(bytes || 0) / 1024;
}

function formatKB(kb) {
  return `${kb.toFixed(1)}KB`;
}

function findStatsPath(projectRoot = PROJECT_ROOT) {
  const candidates = STATS_CANDIDATES.map((candidate) =>
    path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate),
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function collectStaticClosure(outputs, entryKeys) {
  const visited = new Set();
  const queue = [...entryKeys];

  while (queue.length > 0) {
    const key = queue.shift();
    if (!key || visited.has(key) || !outputs[key]) {
      continue;
    }

    visited.add(key);
    const output = outputs[key];
    const imports = Array.isArray(output.imports) ? output.imports : [];
    for (const item of imports) {
      if (!item || item.kind !== 'import-statement' || typeof item.path !== 'string') {
        continue;
      }
      if (!outputs[item.path]) {
        continue;
      }
      queue.push(item.path);
    }
  }

  return visited;
}

function getTopChunks(outputs, keys, limit = 12) {
  return [...keys]
    .map((key) => ({
      key,
      bytes: Number(outputs[key]?.bytes || 0),
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);
}

function collectInitialInputs(outputs, keys) {
  const inputs = new Map();
  for (const key of keys) {
    const outputInputs = outputs[key]?.inputs || {};
    for (const [inputPath, meta] of Object.entries(outputInputs)) {
      const maybeBytes = Number(meta?.bytesInOutput || meta?.bytes || 0);
      inputs.set(inputPath, (inputs.get(inputPath) || 0) + (Number.isFinite(maybeBytes) ? maybeBytes : 0));
    }
  }
  return inputs;
}

function getTopInputs(inputMap, limit = 12) {
  return [...inputMap.entries()]
    .map(([inputPath, bytes]) => ({ path: inputPath, bytes: Number(bytes || 0) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);
}

function detectWorkspaceChunk(outputs, mainKey, polyfillsKey) {
  const candidates = Object.entries(outputs)
    .filter(([key, output]) => {
      if (!/\.js$/.test(key)) return false;
      if (key === mainKey || key === polyfillsKey) return false;
      if (key.includes('workspace-shell')) return true;

      const inputs = Object.keys(output?.inputs || {});
      return inputs.some((input) => input.includes('workspace-shell.component.ts'));
    })
    .map(([key, output]) => ({
      key,
      bytes: Number(output?.bytes || 0),
    }))
    .sort((left, right) => right.bytes - left.bytes);

  return candidates[0] || null;
}

function findHotpathConfigBarrelViolations(projectRoot = PROJECT_ROOT) {
  const violations = [];
  const warnings = [];
  const barrelPattern = /from\s+['"](?:\.\.\/)+config(?:\/index)?['"]/;

  for (const filePath of HOTPATH_CONFIG_BARREL_BAN_FILES) {
    const absPath = path.join(projectRoot, filePath);
    if (!fs.existsSync(absPath)) {
      warnings.push(`hotpath 文件不存在，已跳过: ${filePath}`);
      continue;
    }

    const source = fs.readFileSync(absPath, 'utf8');
    if (barrelPattern.test(source)) {
      violations.push(filePath);
    }
  }

  return { violations, warnings };
}

function extractModulepreloadHrefs(indexHtml) {
  const hrefs = [];
  const pattern = /<link\b[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = pattern.exec(indexHtml)) !== null) {
    hrefs.push(match[1].replace(/^\//, ''));
  }

  return hrefs;
}

function findForbiddenModulepreloadFiles(options) {
  const {
    indexHtml,
    distDir,
    patterns = FORBIDDEN_MODULEPRELOAD_PATTERNS,
    markers = FORBIDDEN_MODULEPRELOAD_MARKERS,
    ignoreFiles = [],
  } = options;

  const matches = [];
  for (const href of extractModulepreloadHrefs(indexHtml)) {
    if (ignoreFiles.includes(href)) {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(href))) {
      matches.push(href);
      continue;
    }

    const chunkPath = path.join(distDir, href);
    if (!fs.existsSync(chunkPath)) {
      continue;
    }

    const head = fs.readFileSync(chunkPath, 'utf8').slice(0, 65536);
    if (markers.some((marker) => head.toLowerCase().includes(marker.toLowerCase()))) {
      matches.push(href);
    }
  }

  return [...new Set(matches)];
}

function findEntryDiscoveryByteOffset(html, entryFile) {
  if (!entryFile) return -1;
  return html.indexOf(entryFile);
}

function evaluateShellPreloads(options) {
  const {
    shellName,
    html,
    distDir,
    mainKey,
    polyfillsKey,
    launchDiscoveryMaxBytes = STARTUP_LAUNCH_DISCOVERY_MAX_BYTES,
    checkDiscovery = false,
  } = options;
  const violations = [];
  const hrefs = extractModulepreloadHrefs(html);

  if (mainKey && !hrefs.includes(mainKey)) {
    violations.push(`${shellName} 缺少 main 入口 modulepreload`);
  }
  if (polyfillsKey && !hrefs.includes(polyfillsKey)) {
    violations.push(`${shellName} 缺少 polyfills 入口 modulepreload`);
  }

  const ignoredEntries = [mainKey, polyfillsKey].filter(Boolean);
  const forbiddenModulepreloads = findForbiddenModulepreloadFiles({
    indexHtml: html,
    distDir,
    ignoreFiles: ignoredEntries,
  });
  if (forbiddenModulepreloads.length > 0) {
    violations.push(`${shellName} 含路由组件 chunk: ${forbiddenModulepreloads.join(', ')}`);
  }

  if (checkDiscovery && mainKey) {
    const discoveryOffset = findEntryDiscoveryByteOffset(html, mainKey);
    if (discoveryOffset === -1) {
      violations.push(`${shellName} 未发现 main 入口脚本引用`);
    } else if (discoveryOffset > launchDiscoveryMaxBytes) {
      violations.push(`${shellName} main 发现位置超限: ${discoveryOffset}B > ${launchDiscoveryMaxBytes}B`);
    }
  }

  return violations;
}

function evaluateStartupGuard(options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const statsPath = options.statsPath || findStatsPath(projectRoot);
  const indexHtmlPath = options.indexHtmlPath || INDEX_HTML_PATH;
  const launchHtmlPath = options.launchHtmlPath || LAUNCH_HTML_PATH;
  const launchHtmlMaxDiscoveryBytes = Number(options.launchHtmlMaxDiscoveryBytes || STARTUP_LAUNCH_DISCOVERY_MAX_BYTES);
  const distDir = options.distDir || path.dirname(indexHtmlPath);

  if (!fs.existsSync(statsPath)) {
    return { error: `未找到 stats 文件: ${statsPath}` };
  }

  if (!fs.existsSync(indexHtmlPath)) {
    return { error: `未找到构建后的 index.html: ${indexHtmlPath}` };
  }

  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  const outputs = stats.outputs || {};
  const mainKey = Object.keys(outputs).find((key) => /^main-.*\.js$/.test(key));
  const polyfillsKey = Object.keys(outputs).find((key) => /^polyfills-.*\.js$/.test(key));

  if (!mainKey) {
    return { error: '未找到 main-*.js 输出' };
  }

  const mainOutput = outputs[mainKey];
  const mainBytes = Number(mainOutput.bytes || 0);
  const mainKB = toKB(mainBytes);
  const mainImports = Array.isArray(mainOutput.imports) ? mainOutput.imports : [];
  const mainStaticImportCount = mainImports.filter((item) => item?.kind === 'import-statement').length;
  const mainInputs = mainOutput.inputs || {};
  const hasCompilerInput = Object.keys(mainInputs).some((key) => key.includes('@angular/compiler'));

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const modulepreloadCount = extractModulepreloadHrefs(indexHtml).length;
  const strictModulepreloadMatch = indexHtml.match(/STRICT_MODULEPRELOAD_V2:\s*(true|false)/);
  const strictModulepreload = strictModulepreloadMatch ? strictModulepreloadMatch[1] === 'true' : true;
  const launchHtml = fs.existsSync(launchHtmlPath) ? fs.readFileSync(launchHtmlPath, 'utf8') : null;

  const staticClosure = collectStaticClosure(outputs, [mainKey, polyfillsKey].filter(Boolean));
  const initialStaticBytes = [...staticClosure].reduce(
    (sum, key) => sum + Number(outputs[key]?.bytes || 0),
    0,
  );
  const initialStaticKB = toKB(initialStaticBytes);
  const workspaceChunk = detectWorkspaceChunk(outputs, mainKey, polyfillsKey);
  const workspaceChunkKB = toKB(workspaceChunk?.bytes || 0);
  const topStaticChunks = getTopChunks(outputs, staticClosure, 12);
  const initialInputs = collectInitialInputs(outputs, staticClosure);
  const topInitialInputs = getTopInputs(initialInputs, 12);
  const hasSupabaseAuthJs = [...initialInputs.keys()].some((key) => key.includes('@supabase/auth-js'));
  const hasFlowStylesInput = [...initialInputs.keys()].some((key) => key.includes('src/config/flow-styles.ts'));
  const forbiddenInitialHits = FORBIDDEN_INITIAL_INPUTS.filter((pattern) =>
    [...initialInputs.keys()].some((key) => key.includes(pattern)),
  );
  const hotpathConfigBarrelCheck = HOTPATH_CONFIG_BARREL_BAN_ENABLED
    ? findHotpathConfigBarrelViolations(projectRoot)
    : { violations: [], warnings: [] };

  const violations = [];
  if (mainKB > STARTUP_MAIN_MAX_KB) {
    violations.push(`main 包体超限: ${formatKB(mainKB)} > ${STARTUP_MAIN_MAX_KB}KB`);
  }
  if (mainStaticImportCount > STARTUP_MAIN_STATIC_IMPORT_MAX) {
    violations.push(`main 静态 import 数量超限: ${mainStaticImportCount} > ${STARTUP_MAIN_STATIC_IMPORT_MAX}`);
  }
  if (initialStaticKB > STARTUP_INITIAL_STATIC_JS_MAX_KB) {
    violations.push(
      `initial static 闭包超限: ${formatKB(initialStaticKB)} > ${STARTUP_INITIAL_STATIC_JS_MAX_KB}KB`,
    );
  }
  if (!workspaceChunk) {
    violations.push('未检测到 workspace shell chunk（无法执行 workspace chunk 门禁）');
  } else if (workspaceChunkKB > STARTUP_WORKSPACE_CHUNK_MAX_KB) {
    violations.push(
      `workspace shell chunk 超限: ${formatKB(workspaceChunkKB)} > ${STARTUP_WORKSPACE_CHUNK_MAX_KB}KB (${workspaceChunk.key})`,
    );
  }
  if (modulepreloadCount > STARTUP_MODULEPRELOAD_MAX) {
    violations.push(`modulepreload 数量超限: ${modulepreloadCount} > ${STARTUP_MODULEPRELOAD_MAX}`);
  }
  if (hasCompilerInput) {
    violations.push(`检测到 @angular/compiler 进入 ${mainKey}`);
  }
  if (strictModulepreload && hasSupabaseAuthJs) {
    violations.push('strict 模式禁入：@supabase/auth-js 进入 initial static 闭包');
  }
  if (strictModulepreload && hasFlowStylesInput) {
    violations.push('strict 模式禁入：src/config/flow-styles.ts 进入 initial static 闭包');
  }
  for (const hit of forbiddenInitialHits) {
    violations.push(`strict 模式禁入：${hit} 进入 initial static 闭包`);
  }
  for (const hit of hotpathConfigBarrelCheck.violations) {
    violations.push(`hotpath 禁令：检测到 config barrel 导入 (${hit})`);
  }

  violations.push(
    ...evaluateShellPreloads({
      shellName: 'index.html',
      html: indexHtml,
      distDir,
      mainKey,
      polyfillsKey,
    }),
  );

  if (launchHtml) {
    violations.push(
      ...evaluateShellPreloads({
        shellName: 'launch.html',
        html: launchHtml,
        distDir,
        mainKey,
        polyfillsKey,
        launchDiscoveryMaxBytes: launchHtmlMaxDiscoveryBytes,
        checkDiscovery: true,
      }),
    );
  } else {
    violations.push(`未找到构建后的 launch.html: ${launchHtmlPath}`);
  }

  return {
    violations,
    warnings: hotpathConfigBarrelCheck.warnings,
    topStaticChunks,
    topInitialInputs,
    mainKB,
    mainStaticImportCount,
    initialStaticKB,
    workspaceChunk,
    workspaceChunkKB,
    modulepreloadCount,
    strictModulepreload,
    launchHtmlPath,
  };
}

function main() {
  const result = evaluateStartupGuard();
  if (result.error) {
    fail(result.error);
  }

  for (const warning of result.warnings) {
    console.warn(`[perf-startup-guard] ⚠️ ${warning}`);
  }

  if (result.violations.length > 0) {
    console.error('[perf-startup-guard] ❌ 门禁失败:');
    for (const violation of result.violations) {
      console.error(`  - ${violation}`);
    }
    console.error('[perf-startup-guard] Top initial static chunks:');
    for (const chunk of result.topStaticChunks) {
      console.error(`  - ${chunk.key}: ${formatKB(toKB(chunk.bytes))}`);
    }
    console.error('[perf-startup-guard] Top initial inputs:');
    for (const input of result.topInitialInputs) {
      console.error(`  - ${input.path}: ${formatKB(toKB(input.bytes))}`);
    }
    process.exit(1);
  }

  console.log('[perf-startup-guard] Top initial static chunks:');
  for (const chunk of result.topStaticChunks) {
    console.log(`  - ${chunk.key}: ${formatKB(toKB(chunk.bytes))}`);
  }
  console.log('[perf-startup-guard] Top initial inputs:');
  for (const input of result.topInitialInputs) {
    console.log(`  - ${input.path}: ${formatKB(toKB(input.bytes))}`);
  }
  if (result.workspaceChunk) {
    console.log(
      `[perf-startup-guard] workspace chunk: ${result.workspaceChunk.key} (${formatKB(result.workspaceChunkKB)})`,
    );
  }

  console.log(
    `[perf-startup-guard] ✅ 通过: main=${formatKB(result.mainKB)}, mainStaticImports=${result.mainStaticImportCount}, initialStatic=${formatKB(result.initialStaticKB)}, workspaceChunk=${result.workspaceChunk ? formatKB(result.workspaceChunkKB) : 'n/a'}, modulepreload=${result.modulepreloadCount}, strictModulepreload=${result.strictModulepreload}, no-jit=true`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  FORBIDDEN_MODULEPRELOAD_MARKERS,
  FORBIDDEN_MODULEPRELOAD_PATTERNS,
  evaluateStartupGuard,
  extractModulepreloadHrefs,
  findEntryDiscoveryByteOffset,
  findForbiddenModulepreloadFiles,
  findStatsPath,
  main,
};
