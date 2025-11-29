#!/bin/bash
# 此脚本用于从 Git 历史中移除敏感的环境配置文件
# 警告：此操作会重写 Git 历史，请谨慎使用！

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}⚠️  警告：此脚本将从 Git 历史中移除敏感文件${NC}"
echo "   这将重写 Git 历史，需要强制推送到远程仓库"
echo ""

# 检查是否在 Git 仓库中
if [ ! -d ".git" ]; then
    echo -e "${RED}错误：未找到 .git 目录，请在项目根目录运行此脚本${NC}"
    exit 1
fi

read -p "确定要继续吗？(y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消操作"
    exit 1
fi

# 定义需要清理的敏感文件
SENSITIVE_FILES=(
    "src/environments/environment.ts"
    "src/environments/environment.development.ts"
    ".env"
    ".env.local"
    ".env.development"
    ".env.production"
)

# 定义敏感密钥模式（用于内容检查）
SENSITIVE_PATTERNS=(
    "supabaseUrl.*http"
    "supabaseAnonKey.*eyJ"
    "service_role.*eyJ"
    "SUPABASE_URL"
    "SUPABASE_ANON_KEY"
    "SUPABASE_SERVICE_ROLE_KEY"
    "password.*="
    "secret.*="
    "apiKey.*="
)

echo ""
echo "正在检查并清理敏感文件..."

# 从 Git 缓存中移除文件（保留本地文件）
for file in "${SENSITIVE_FILES[@]}"; do
    if git ls-files --error-unmatch "$file" &>/dev/null; then
        echo -e "  ${YELLOW}移除 Git 追踪：${NC} $file"
        git rm --cached "$file" 2>/dev/null || true
    fi
done

# 检查文件内容是否包含敏感信息
echo ""
echo "检查文件内容是否包含敏感信息..."
FOUND_SENSITIVE=false

for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    # 检查环境文件
    for file in "src/environments/environment.ts" "src/environments/environment.development.ts"; do
        if [ -f "$file" ]; then
            if grep -qiE "$pattern" "$file" 2>/dev/null; then
                # 排除模板文件中的占位符
                if ! grep -qE "YOUR_|PLACEHOLDER|example\.com" "$file" 2>/dev/null; then
                    echo -e "  ${RED}警告：${NC} $file 可能包含敏感信息（匹配模式: $pattern）"
                    FOUND_SENSITIVE=true
                fi
            fi
        fi
    done
done

if [ "$FOUND_SENSITIVE" = true ]; then
    echo ""
    echo -e "${RED}⚠️  发现可能的敏感信息！${NC}"
    echo "   请检查上述文件，确保没有硬编码真实的 API 密钥。"
    echo "   建议使用环境变量或 .env.local 文件（已被 .gitignore 忽略）。"
fi

# 确认 .gitignore 包含这些文件
echo ""
echo "检查 .gitignore 配置..."

# 需要确保在 .gitignore 中的模式
GITIGNORE_PATTERNS=(
    "# Environment files - SENSITIVE"
    "src/environments/environment.ts"
    "src/environments/environment.development.ts"
    ".env"
    ".env.*"
    "*.local"
    ""
    "# Supabase local config"
    ".supabase/"
)

# 检查并添加缺失的模式
for pattern in "${GITIGNORE_PATTERNS[@]}"; do
    if [ -n "$pattern" ] && ! grep -qF "$pattern" .gitignore 2>/dev/null; then
        echo "$pattern" >> .gitignore
        echo -e "  ${GREEN}添加到 .gitignore：${NC} $pattern"
    fi
done

# 检查是否有已暂存的更改
if git diff --cached --quiet; then
    echo ""
    echo -e "${GREEN}✅ 没有发现需要清理的已追踪敏感文件${NC}"
else
    echo ""
    echo -e "${GREEN}✅ 文件已从 Git 追踪中移除${NC}"
    echo ""
    echo "下一步操作："
    echo "  1. 检查更改: git status"
    echo "  2. 提交更改: git commit -m 'chore: remove sensitive env files from tracking'"
    echo "  3. 推送更改: git push"
fi

echo ""
echo -e "${YELLOW}⚠️  重要安全提醒：${NC}"
echo "   • 如果敏感密钥已被提交到公开仓库，应立即轮换/重置这些密钥"
echo "   • Supabase 密钥可在 Supabase 控制台 → Settings → API 中重置"
echo "   • 更新 .env.local 中的新密钥后运行: npm run config"
echo ""
echo "环境配置说明："
echo "   • 本地开发：创建 .env.local 文件并添加您的密钥"
echo "   • CI/CD：在 GitHub Actions 或部署平台中配置环境变量"
echo "   • 生产环境：在 Vercel/Netlify 等平台的项目设置中配置"
