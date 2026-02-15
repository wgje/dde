/**
 * 字体一致性契约门禁
 *
 * 目标：
 * - public/fonts/lxgw-wenkai-screen.css 必须声明 subset-117 / subset-118
 * - main.ts 不允许使用非 Screen 字体名 "LXGW WenKai"
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FONT_CSS_PATH = path.join(ROOT, 'public', 'fonts', 'lxgw-wenkai-screen.css');
const MAIN_TS_PATH = path.join(ROOT, 'main.ts');

function fail(message) {
  console.error(`[check-font-subset-contract] ❌ ${message}`);
  process.exit(1);
}

if (!fs.existsSync(FONT_CSS_PATH)) {
  fail(`未找到字体样式文件: ${FONT_CSS_PATH}`);
}

if (!fs.existsSync(MAIN_TS_PATH)) {
  fail(`未找到入口文件: ${MAIN_TS_PATH}`);
}

const fontCss = fs.readFileSync(FONT_CSS_PATH, 'utf8');
const mainTs = fs.readFileSync(MAIN_TS_PATH, 'utf8');

const missingSubsets = ['117', '118'].filter(
  (subset) => !fontCss.includes(`subset-${subset}.woff2`)
);

if (missingSubsets.length > 0) {
  fail(`字体契约缺失：未声明 subset-${missingSubsets.join('/subset-')}.woff2`);
}

const hasNonScreenFont = /(["'])LXGW WenKai\1/.test(mainTs) || /LXGW WenKai(?!\s+Screen)/.test(mainTs);
if (hasNonScreenFont) {
  fail('main.ts 检测到非统一字体名 "LXGW WenKai"，请改为 "LXGW WenKai Screen"');
}

console.log('[check-font-subset-contract] ✅ 通过：subset-117/118 声明完整，main.ts 字体命名统一');
