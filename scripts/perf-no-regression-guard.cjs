/**
 * 性能无回归门禁（V5）
 *
 * 对比基线快照与当前结果：
 * - 默认要求关键路径 P95 不允许回归超过 5%
 * - 以“越小越好”的指标为主（耗时/请求量/错误数）
 *
 * 输入：
 * - 基线：perf-baseline/no-regression-baseline.json
 * - 当前：test-results/perf/current-metrics.json（由弱网 E2E 生成）
 * - 构建补充：dist/stats.json（自动补充 build.* 指标）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'perf-baseline', 'no-regression-baseline.json');
const CURRENT_PATH = process.env.PERF_CURRENT_METRICS_PATH
  ? path.resolve(process.env.PERF_CURRENT_METRICS_PATH)
  : path.join(ROOT, 'test-results', 'perf', 'current-metrics.json');
const STATS_PATH = path.join(ROOT, 'dist', 'stats.json');
const REGRESSION_BUDGET_RATIO = Number(process.env.PERF_REGRESSION_BUDGET_RATIO || 0.05);
const NON_ZERO_REQUIRED_METRICS = new Set([
  'resume.interaction_ready_ms',
  'resume.background_refresh_ms',
]);

function fail(message) {
  console.error(`[perf-no-regression-guard] FAIL: ${message}`);
  process.exit(1);
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`missing ${label}: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`invalid ${label} JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function toKB(bytes) {
  return Number(bytes || 0) / 1024;
}

function collectStaticClosure(outputs, entryKeys) {
  const visited = new Set();
  const queue = [...entryKeys];

  while (queue.length > 0) {
    const key = queue.shift();
    if (!key || visited.has(key) || !outputs[key]) continue;
    visited.add(key);
    const output = outputs[key];
    const imports = Array.isArray(output.imports) ? output.imports : [];
    for (const item of imports) {
      if (!item || item.kind !== 'import-statement' || typeof item.path !== 'string') continue;
      if (!outputs[item.path]) continue;
      queue.push(item.path);
    }
  }

  return visited;
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

function collectBuildMetrics() {
  if (!fs.existsSync(STATS_PATH)) {
    return {};
  }

  const stats = readJson(STATS_PATH, 'stats');
  const outputs = stats.outputs || {};
  const mainKey = Object.keys(outputs).find((key) => /^main-.*\.js$/.test(key));
  const polyfillsKey = Object.keys(outputs).find((key) => /^polyfills-.*\.js$/.test(key));
  if (!mainKey || !polyfillsKey) {
    return {};
  }

  const mainOutput = outputs[mainKey];
  const mainImports = Array.isArray(mainOutput.imports) ? mainOutput.imports : [];
  const mainStaticImportCount = mainImports.filter((item) => item?.kind === 'import-statement').length;

  const staticClosure = collectStaticClosure(outputs, [mainKey, polyfillsKey]);
  const initialStaticBytes = [...staticClosure].reduce(
    (sum, key) => sum + Number(outputs[key]?.bytes || 0),
    0
  );
  const workspaceChunk = detectWorkspaceChunk(outputs, mainKey, polyfillsKey);
  const workspaceChunkKB = toKB(workspaceChunk?.bytes || 0);

  return {
    'build.initial_static_kb': Number(toKB(initialStaticBytes).toFixed(2)),
    'build.workspace_chunk_kb': Number(workspaceChunkKB.toFixed(2)),
    'build.main_static_imports': Number(mainStaticImportCount),
  };
}

const baseline = readJson(BASELINE_PATH, 'baseline');
const current = readJson(CURRENT_PATH, 'current');

const baselineMetrics = baseline?.metrics || {};
const runtimeMetrics = current?.metrics || {};
const currentMetrics = {
  ...runtimeMetrics,
  ...collectBuildMetrics(),
};

if (Object.keys(baselineMetrics).length === 0) {
  fail('baseline metrics is empty');
}

const violations = [];
for (const [metricName, baselineValueRaw] of Object.entries(baselineMetrics)) {
  const baselineValue = Number(baselineValueRaw);
  if (!Number.isFinite(baselineValue) || baselineValue < 0) {
    violations.push(`${metricName}: invalid baseline value ${String(baselineValueRaw)}`);
    continue;
  }

  const currentValueRaw = currentMetrics[metricName];
  const currentValue = Number(currentValueRaw);
  if (!Number.isFinite(currentValue)) {
    violations.push(`${metricName}: missing current metric`);
    continue;
  }
  if (NON_ZERO_REQUIRED_METRICS.has(metricName) && currentValue <= 0) {
    violations.push(`${metricName}: expected > 0 but got ${currentValue.toFixed(2)}`);
    continue;
  }

  const allowed = baselineValue === 0
    ? 0
    : baselineValue * (1 + REGRESSION_BUDGET_RATIO);
  if (currentValue > allowed) {
    violations.push(
      `${metricName}: regression ${currentValue.toFixed(2)} > allowed ${allowed.toFixed(2)} (baseline ${baselineValue.toFixed(2)})`
    );
  }
}

if (violations.length > 0) {
  console.error('[perf-no-regression-guard] regressions detected:');
  for (const issue of violations) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log('[perf-no-regression-guard] OK');
for (const [key, value] of Object.entries(currentMetrics)) {
  if (baselineMetrics[key] !== undefined) {
    console.log(`  ${key}: ${Number(value).toFixed(2)} (baseline ${Number(baselineMetrics[key]).toFixed(2)})`);
  }
}
