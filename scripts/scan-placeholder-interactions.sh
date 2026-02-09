#!/usr/bin/env bash
# ============================================================
# 占位交互扫描器
# 
# 扫描代码中可能的占位交互模式：
# - TODO/FIXME/HACK 注释中涉及 UI 交互的
# - 空方法体（可能是未实现的事件处理器）
# - console.log 替代实际逻辑
# - alert() 替代 Toast/Modal
# - 注释掉的事件处理代码
#
# 用法：./scripts/scan-placeholder-interactions.sh [--strict]
# ============================================================

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color
BOLD='\033[1m'

STRICT="${1:-}"
EXIT_CODE=0
TOTAL_ISSUES=0

SRC_DIR="src"

echo -e "${BOLD}🔍 NanoFlow 占位交互扫描器${NC}"
echo "========================================"
echo ""

# 1. 扫描 TODO/FIXME/HACK 中涉及交互的注释
echo -e "${BOLD}[1/6] 扫描 TODO/FIXME/HACK 交互注释...${NC}"
count=$(grep -rn --include="*.ts" --include="*.html" \
  -E '(TODO|FIXME|HACK|XXX).*?(click|button|save|upload|submit|handler|placeholder|stub)' \
  "$SRC_DIR" 2>/dev/null | wc -l || echo 0)
if [ "$count" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠ 发现 $count 处包含交互关键词的 TODO/FIXME${NC}"
  grep -rn --include="*.ts" --include="*.html" \
    -E '(TODO|FIXME|HACK|XXX).*?(click|button|save|upload|submit|handler|placeholder|stub)' \
    "$SRC_DIR" 2>/dev/null | head -20
  TOTAL_ISSUES=$((TOTAL_ISSUES + count))
else
  echo -e "  ${GREEN}✓ 无交互相关 TODO/FIXME${NC}"
fi
echo ""

# 2. 扫描空方法体（可能是占位实现）
echo -e "${BOLD}[2/6] 扫描疑似空方法体...${NC}"
count=$(grep -rn --include="*.ts" \
  -E '(on[A-Z]\w+|handle[A-Z]\w+)\(.*\).*\{[[:space:]]*\}' \
  "$SRC_DIR" 2>/dev/null | wc -l || echo 0)
if [ "$count" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠ 发现 $count 处疑似空事件处理器${NC}"
  grep -rn --include="*.ts" \
    -E '(on[A-Z]\w+|handle[A-Z]\w+)\(.*\).*\{[[:space:]]*\}' \
    "$SRC_DIR" 2>/dev/null | head -20
  TOTAL_ISSUES=$((TOTAL_ISSUES + count))
else
  echo -e "  ${GREEN}✓ 无空事件处理器${NC}"
fi
echo ""

# 3. 扫描 console.log 替代逻辑
echo -e "${BOLD}[3/6] 扫描 console.log 占位...${NC}"
count=$(grep -rn --include="*.ts" \
  -E 'console\.(log|warn|error)\(' \
  "$SRC_DIR" 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v '\.spec\.ts' \
  | grep -v 'test-setup' \
  | grep -v 'logger.service.ts' \
  | wc -l || echo 0)
if [ "$count" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠ 发现 $count 处 console.log（应使用 LoggerService）${NC}"
  grep -rn --include="*.ts" \
    -E 'console\.(log|warn|error)\(' \
    "$SRC_DIR" 2>/dev/null \
    | grep -v 'node_modules' \
    | grep -v '\.spec\.ts' \
    | grep -v 'test-setup' \
    | grep -v 'logger.service.ts' \
    | head -15
  TOTAL_ISSUES=$((TOTAL_ISSUES + count))
else
  echo -e "  ${GREEN}✓ 无裸 console.log${NC}"
fi
echo ""

# 4. 扫描 alert() 调用
echo -e "${BOLD}[4/6] 扫描 alert() 调用...${NC}"
count=$(grep -rn --include="*.ts" --include="*.html" \
  -E '\balert\(' \
  "$SRC_DIR" 2>/dev/null \
  | grep -v '\.spec\.ts' \
  | grep -v 'sentry-alert' \
  | wc -l || echo 0)
if [ "$count" -gt 0 ]; then
  echo -e "  ${RED}✗ 发现 $count 处 alert() 调用（应使用 Toast/Modal）${NC}"
  grep -rn --include="*.ts" --include="*.html" \
    -E '\balert\(' \
    "$SRC_DIR" 2>/dev/null \
    | grep -v '\.spec\.ts' \
    | grep -v 'sentry-alert' \
    | head -10
  TOTAL_ISSUES=$((TOTAL_ISSUES + count))
  EXIT_CODE=1
else
  echo -e "  ${GREEN}✓ 无 alert() 调用${NC}"
fi
echo ""

# 5. 扫描注释掉的事件处理代码
echo -e "${BOLD}[5/6] 扫描注释掉的事件处理...${NC}"
count=$(grep -rn --include="*.ts" \
  -E '^\s*//\s*(this\.\w+\(|await\s|\.subscribe|\.emit)' \
  "$SRC_DIR" 2>/dev/null \
  | grep -v '\.spec\.ts' \
  | wc -l || echo 0)
if [ "$count" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠ 发现 $count 处注释掉的逻辑代码${NC}"
  grep -rn --include="*.ts" \
    -E '^\s*//\s*(this\.\w+\(|await\s|\.subscribe|\.emit)' \
    "$SRC_DIR" 2>/dev/null \
    | grep -v '\.spec\.ts' \
    | head -15
  TOTAL_ISSUES=$((TOTAL_ISSUES + count))
else
  echo -e "  ${GREEN}✓ 无注释掉的逻辑代码${NC}"
fi
echo ""

# 6. 扫描 "placeholder" / "not implemented" 字符串
echo -e "${BOLD}[6/6] 扫描占位字符串...${NC}"
count=$(grep -rni --include="*.ts" \
  -E '(placeholder|not.?implemented|coming.?soon|todo.?implement)' \
  "$SRC_DIR" 2>/dev/null \
  | grep -v '\.spec\.ts' \
  | grep -v 'node_modules' \
  | grep -v 'placeholder.*input\b' \
  | wc -l || echo 0)
if [ "$count" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠ 发现 $count 处占位字符串${NC}"
  grep -rni --include="*.ts" \
    -E '(placeholder|not.?implemented|coming.?soon|todo.?implement)' \
    "$SRC_DIR" 2>/dev/null \
    | grep -v '\.spec\.ts' \
    | grep -v 'node_modules' \
    | grep -v 'placeholder.*input\b' \
    | head -15
  TOTAL_ISSUES=$((TOTAL_ISSUES + count))
else
  echo -e "  ${GREEN}✓ 无占位字符串${NC}"
fi
echo ""

# 汇总
echo "========================================"
if [ "$TOTAL_ISSUES" -eq 0 ]; then
  echo -e "${GREEN}✅ 扫描完成：无占位交互问题${NC}"
else
  echo -e "${YELLOW}⚠ 扫描完成：共发现 $TOTAL_ISSUES 处潜在问题${NC}"
fi

# --strict 模式下有问题则返回非零退出码
if [ "$STRICT" = "--strict" ] && [ "$EXIT_CODE" -ne 0 ]; then
  exit "$EXIT_CODE"
fi

exit 0
