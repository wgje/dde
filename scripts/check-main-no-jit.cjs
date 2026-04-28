/**
 * 构建门禁：产物中不允许出现 Angular JIT 运行时代码或未 AOT 的组件装饰器。
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

const compilerOutputs = Object.entries(outputs)
  .filter(([, output]) => Object.keys(output.inputs || {}).some((key) => key.includes('@angular/compiler')))
  .map(([key]) => key);

if (compilerOutputs.length > 0) {
  fail(`检测到 @angular/compiler 进入构建产物: ${compilerOutputs.join(', ')}`);
}

const browserDir = path.join(__dirname, '..', 'dist', 'browser');
const runtimeDecoratorPattern = /\b[A-Za-z_$][\w$]*\(\{selector:/;
const decoratorOutputs = fs.readdirSync(browserDir)
  .filter((file) => file.endsWith('.js'))
  .filter((file) => runtimeDecoratorPattern.test(fs.readFileSync(path.join(browserDir, file), 'utf8')));

if (decoratorOutputs.length > 0) {
  fail(`检测到未 AOT 编译的 Angular component decorator: ${decoratorOutputs.join(', ')}`);
}

console.log(`[check-main-no-jit] ✅ 通过：${mainKey} 及 lazy chunks 未包含 JIT 运行时或未 AOT 组件装饰器`);
