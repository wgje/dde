#!/bin/bash
# 诊断语音转写 401 错误的脚本
# 用法：./scripts/diagnose-transcribe-401.sh

set -e

echo "============================================"
echo "🔍 语音转写 401 错误诊断工具"
echo "============================================"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 Supabase CLI
echo "📋 Step 1: 检查 Supabase CLI..."
if ! command -v supabase &> /dev/null; then
    echo -e "${RED}❌ Supabase CLI 未安装${NC}"
    echo "   安装命令: npm install -g supabase"
    echo "   或访问: https://supabase.com/docs/guides/cli"
    exit 1
fi
echo -e "${GREEN}✅ Supabase CLI 已安装${NC}"
echo ""

# 检查是否已链接项目
echo "📋 Step 2: 检查项目链接状态..."
if [ ! -f "supabase/.temp/project-ref" ]; then
    echo -e "${YELLOW}⚠️  项目未链接${NC}"
    echo "   运行: supabase link --project-ref fkhihclpghmmtbbywvoj"
else
    PROJECT_REF=$(cat supabase/.temp/project-ref)
    echo -e "${GREEN}✅ 已链接到项目: $PROJECT_REF${NC}"
fi
echo ""

# 检查 Edge Functions 状态
echo "📋 Step 3: 检查 Edge Functions 部署状态..."
echo "   运行: supabase functions list"
supabase functions list 2>&1 || echo -e "${YELLOW}⚠️  无法获取函数列表，可能需要登录${NC}"
echo ""

# 检查 Secrets
echo "📋 Step 4: 检查 Secrets 配置..."
echo "   运行: supabase secrets list"
supabase secrets list 2>&1 || echo -e "${YELLOW}⚠️  无法获取 secrets 列表${NC}"
echo ""

# 检查 Edge Function 日志
echo "📋 Step 5: 获取 transcribe 函数最近日志..."
echo "   运行: supabase functions logs transcribe --tail 20"
supabase functions logs transcribe --tail 20 2>&1 || echo -e "${YELLOW}⚠️  无法获取日志${NC}"
echo ""

echo "============================================"
echo "🛠️  解决方案建议"
echo "============================================"
echo ""
echo "如果看到 'Invalid JWT' 错误，执行以下步骤："
echo ""
echo "1️⃣  重新部署 Edge Function（更新 JWT secret）:"
echo "    supabase functions deploy transcribe"
echo ""
echo "2️⃣  确保 GROQ_API_KEY 已设置:"
echo "    supabase secrets set GROQ_API_KEY=gsk_你的实际密钥"
echo ""
echo "3️⃣  验证部署成功:"
echo "    supabase functions list"
echo ""
echo "4️⃣  检查 transcription_usage 表是否存在:"
echo "    在 Supabase Dashboard SQL Editor 中执行检查"
echo ""
