#!/bin/bash
# ============================================================
# 性能基准测试脚本
# 使用 Lighthouse 测量关键性能指标
# 
# 用法: npm run perf:benchmark
# ============================================================

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 NanoFlow 性能基准测试${NC}"
echo "=============================================="

# 确保安装了必要的工具
if ! command -v npx &> /dev/null; then
    echo -e "${RED}❌ 需要 npx 命令${NC}"
    exit 1
fi

# 确保有 lighthouse
if ! npx lighthouse --version &> /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️ 正在安装 lighthouse...${NC}"
    npm install --save-dev lighthouse
fi

# 确保有 http-server
if ! npx http-server --version &> /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️ 正在安装 http-server...${NC}"
    npm install --save-dev http-server
fi

# 构建生产版本
echo -e "${BLUE}🏗️ 构建生产版本...${NC}"
npm run build

# 确保输出目录存在
mkdir -p dist/perf

# 启动本地服务器（后台运行）
echo -e "${BLUE}🌐 启动本地服务器...${NC}"
npx http-server dist/browser -p 4200 -s &
SERVER_PID=$!
sleep 3

# 检查服务器是否启动成功
if ! curl -s http://localhost:4200 > /dev/null; then
    echo -e "${RED}❌ 服务器启动失败${NC}"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

echo -e "${BLUE}📊 运行 Lighthouse 测试...${NC}"

# 运行 Lighthouse (3 次取平均)
for i in 1 2 3; do
    echo "  第 $i 次测试..."
    npx lighthouse http://localhost:4200 \
        --output=json \
        --output-path="./dist/perf/lighthouse-run-$i.json" \
        --chrome-flags="--headless --no-sandbox --disable-gpu" \
        --only-categories=performance \
        --quiet 2>/dev/null || true
done

# 停止服务器
kill $SERVER_PID 2>/dev/null || true

# 提取并汇总指标
echo -e "${BLUE}📈 提取性能指标...${NC}"
node scripts/extract-lighthouse-metrics.cjs

echo ""
echo -e "${GREEN}✅ 性能基准测试完成！${NC}"
echo ""
echo "📄 报告文件:"
echo "  - dist/perf/metrics-summary.json  (指标汇总)"
echo "  - dist/perf/lighthouse-run-*.json (原始报告)"
