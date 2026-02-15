/**
 * 启动性能构建门禁
 * - main 包体 <= 260KB（raw）
 * - main 静态 import-statement 数量 <= 10
 * - main/polyfills 静态依赖闭包体积 <= 340KB（raw）
 * - workspace shell chunk <= 125KB（raw）
 * - modulepreload 数量 <= 0（strict）
 * - main 不包含 @angular/compiler
 * - strict 模式禁入项：
 *   - @supabase/auth-js 不得进入 initial static 闭包
 *   - src/config/flow-styles.ts 不得进入 initial static 闭包
 *   - 核心同步与离开守卫不得进入 initial static 闭包
 */

const fs = require('fs');
const path = require('path');

const STATS_PATH = path.join(__dirname, '..', 'dist', 'stats.json');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'dist', 'browser', 'index.html');
const PROJECT_ROOT = path.join(__dirname, '..');

const STARTUP_MAIN_MAX_KB = Number(process.env.STARTUP_MAIN_MAX_KB || 260);
const STARTUP_MODULEPRELOAD_MAX = Number(process.env.STARTUP_MODULEPRELOAD_MAX || 0);
const STARTUP_INITIAL_STATIC_JS_MAX_KB = Number(process.env.STARTUP_INITIAL_STATIC_JS_MAX_KB || 340);
const STARTUP_WORKSPACE_CHUNK_MAX_KB = Number(process.env.STARTUP_WORKSPACE_CHUNK_MAX_KB || 125);
const STARTUP_MAIN_STATIC_IMPORT_MAX = Number(process.env.STARTUP_MAIN_STATIC_IMPORT_MAX || 10);
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
    .sort((a, b) => b.bytes - a.bytes)
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
    .map(([path, bytes]) => ({ path, bytes: Number(bytes || 0) }))
    .sort((a, b) => b.bytes - a.bytes)
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
    .sort((a, b) => b.bytes - a.bytes);

  return candidates[0] || null;
}

function findHotpathConfigBarrelViolations() {
  const violations = [];
  const warnings = [];
  const barrelPattern = /from\s+['"](?:\.\.\/)+config(?:\/index)?['"]/;

  for (const filePath of HOTPATH_CONFIG_BARREL_BAN_FILES) {
    const absPath = path.join(PROJECT_ROOT, filePath);
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

if (!fs.existsSync(STATS_PATH)) {
  fail(`未找到 stats 文件: ${STATS_PATH}`);
}

if (!fs.existsSync(INDEX_HTML_PATH)) {
  fail(`未找到构建后的 index.html: ${INDEX_HTML_PATH}`);
}

const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
const outputs = stats.outputs || {};
const mainKey = Object.keys(outputs).find((key) => /^main-.*\.js$/.test(key));
const polyfillsKey = Object.keys(outputs).find((key) => /^polyfills-.*\.js$/.test(key));

if (!mainKey) {
  fail('未找到 main-*.js 输出');
}

if (!polyfillsKey) {
  fail('未找到 polyfills-*.js 输出');
}

const mainOutput = outputs[mainKey];
const mainBytes = Number(mainOutput.bytes || 0);
const mainKB = toKB(mainBytes);

const mainImports = Array.isArray(mainOutput.imports) ? mainOutput.imports : [];
const mainStaticImportCount = mainImports.filter((item) => item?.kind === 'import-statement').length;

const mainInputs = mainOutput.inputs || {};
const hasCompilerInput = Object.keys(mainInputs).some((key) => key.includes('@angular/compiler'));

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const modulepreloadCount = (indexHtml.match(/rel="modulepreload"/g) || []).length;
const strictModulepreloadMatch = indexHtml.match(/STRICT_MODULEPRELOAD_V2:\s*(true|false)/);
const strictModulepreload = strictModulepreloadMatch ? strictModulepreloadMatch[1] === 'true' : true;

const staticClosure = collectStaticClosure(outputs, [mainKey, polyfillsKey]);
const initialStaticBytes = [...staticClosure].reduce(
  (sum, key) => sum + Number(outputs[key]?.bytes || 0),
  0
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
  [...initialInputs.keys()].some((key) => key.includes(pattern))
);
const hotpathConfigBarrelCheck = HOTPATH_CONFIG_BARREL_BAN_ENABLED
  ? findHotpathConfigBarrelViolations()
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
    `initial static 闭包超限: ${formatKB(initialStaticKB)} > ${STARTUP_INITIAL_STATIC_JS_MAX_KB}KB`
  );
}
if (!workspaceChunk) {
  violations.push('未检测到 workspace shell chunk（无法执行 workspace chunk 门禁）');
} else if (workspaceChunkKB > STARTUP_WORKSPACE_CHUNK_MAX_KB) {
  violations.push(
    `workspace shell chunk 超限: ${formatKB(workspaceChunkKB)} > ${STARTUP_WORKSPACE_CHUNK_MAX_KB}KB (${workspaceChunk.key})`
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
for (const warning of hotpathConfigBarrelCheck.warnings) {
  console.warn(`[perf-startup-guard] ⚠️ ${warning}`);
}

if (violations.length > 0) {
  console.error('[perf-startup-guard] ❌ 门禁失败:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error('[perf-startup-guard] Top initial static chunks:');
  for (const chunk of topStaticChunks) {
    console.error(`  - ${chunk.key}: ${formatKB(toKB(chunk.bytes))}`);
  }
  console.error('[perf-startup-guard] Top initial inputs:');
  for (const input of topInitialInputs) {
    console.error(`  - ${input.path}: ${formatKB(toKB(input.bytes))}`);
  }
  process.exit(1);
}

console.log('[perf-startup-guard] Top initial static chunks:');
for (const chunk of topStaticChunks) {
  console.log(`  - ${chunk.key}: ${formatKB(toKB(chunk.bytes))}`);
}
console.log('[perf-startup-guard] Top initial inputs:');
for (const input of topInitialInputs) {
  console.log(`  - ${input.path}: ${formatKB(toKB(input.bytes))}`);
}
if (workspaceChunk) {
  console.log(`[perf-startup-guard] workspace chunk: ${workspaceChunk.key} (${formatKB(workspaceChunkKB)})`);
}

console.log(
  `[perf-startup-guard] ✅ 通过: main=${formatKB(mainKB)}, mainStaticImports=${mainStaticImportCount}, initialStatic=${formatKB(initialStaticKB)}, workspaceChunk=${workspaceChunk ? formatKB(workspaceChunkKB) : 'n/a'}, modulepreload=${modulepreloadCount}, strictModulepreload=${strictModulepreload}, no-jit=true`
);
