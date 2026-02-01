#!/bin/bash
# ============================================================
# Bundle 分析脚本
# 使用 source-map-explorer 分析 JavaScript 包组成
# 
# 用法: npm run analyze:bundle
# ============================================================

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔍 NanoFlow Bundle 分析工具${NC}"
echo "=============================================="

# 确保安装了 source-map-explorer
if ! npx source-map-explorer --version &> /dev/null; then
    echo -e "${YELLOW}⚠️ 正在安装 source-map-explorer...${NC}"
    npm install --save-dev source-map-explorer
fi

# 构建带 source map 的生产版本
echo -e "${BLUE}🏗️ 构建生产版本（含 source maps）...${NC}"
ng build --source-map

# 确保输出目录存在
mkdir -p dist/analysis

# 分析主包
echo -e "${BLUE}📊 分析 main bundle...${NC}"
MAIN_BUNDLE=$(find dist/browser -name "main-*.js" -type f | head -1)

if [ -z "$MAIN_BUNDLE" ]; then
    echo -e "${YELLOW}⚠️ 未找到 main bundle，尝试查找其他 JS 文件...${NC}"
    MAIN_BUNDLE=$(find dist/browser -name "*.js" -type f | head -1)
fi

if [ -n "$MAIN_BUNDLE" ]; then
    echo "  分析文件: $MAIN_BUNDLE"
    npx source-map-explorer "$MAIN_BUNDLE" --html dist/analysis/main-bundle-report.html 2>/dev/null || true
    npx source-map-explorer "$MAIN_BUNDLE" --json dist/analysis/main-bundle-report.json 2>/dev/null || true
fi

# 分析所有包
echo -e "${BLUE}📊 分析所有 bundles...${NC}"
npx source-map-explorer 'dist/browser/*.js' --html dist/analysis/full-bundle-report.html 2>/dev/null || true
npx source-map-explorer 'dist/browser/*.js' --json dist/analysis/full-bundle-report.json 2>/dev/null || true

# 生成汇总报告
echo -e "${BLUE}📝 生成汇总报告...${NC}"
node scripts/extract-bundle-metrics.cjs

echo ""
echo -e "${GREEN}✅ Bundle 分析完成！${NC}"
echo ""
echo "📄 报告文件:"
echo "  - dist/analysis/main-bundle-report.html  (主包可视化)"
echo "  - dist/analysis/full-bundle-report.html  (全部包可视化)"
echo "  - dist/analysis/bundle-metrics.json       (指标汇总)"
echo ""
echo "💡 提示: 在浏览器中打开 HTML 文件查看交互式报告"
