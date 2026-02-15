/**
 * 构建门禁：main 包中不允许出现 @angular/compiler（JIT 运行时代码）
 */

const fs = require('fs');
const path = require('path');

const STATS_PATH = path.join(__dirname, '..', 'dist', 'stats.json');

function fail(message) {
  console.error(`[check-main-no-jit] ❌ ${message}`);
  process.exit(1);
}

if (!fs.existsSync(STATS_PATH)) {
  fail(`未找到 stats 文件: ${STATS_PATH}`);
}

const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
const outputs = stats.outputs || {};
const mainKey = Object.keys(outputs).find((key) => /^main-.*\.js$/.test(key));

if (!mainKey) {
  fail('未找到 main-*.js 输出');
}

const mainInputs = outputs[mainKey].inputs || {};
const hasCompilerInput = Object.keys(mainInputs).some((key) => key.includes('@angular/compiler'));

if (hasCompilerInput) {
  fail(`检测到 @angular/compiler 进入 ${mainKey}`);
}

console.log(`[check-main-no-jit] ✅ 通过：${mainKey} 未包含 @angular/compiler`);
