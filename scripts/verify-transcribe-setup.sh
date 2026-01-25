#!/bin/bash
# 验证语音转写功能配置脚本

set -e

echo "🔍 开始验证语音转写功能配置..."
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 Supabase CLI
echo "1️⃣ 检查 Supabase CLI..."
if command -v supabase &> /dev/null; then
    echo -e "${GREEN}✓${NC} Supabase CLI 已安装"
else
    echo -e "${RED}✗${NC} Supabase CLI 未安装"
    echo "   安装命令: npm install -g supabase"
    exit 1
fi
echo ""

# 检查是否已链接项目
echo "2️⃣ 检查项目链接状态..."
if supabase status &> /dev/null; then
    echo -e "${GREEN}✓${NC} 已链接到 Supabase 项目"
else
    echo -e "${YELLOW}⚠${NC} 未链接到项目，请运行: supabase link --project-ref YOUR_PROJECT_ID"
    exit 1
fi
echo ""

# 检查 Edge Functions
echo "3️⃣ 检查 Edge Functions 部署..."
if supabase functions list 2>&1 | grep -q "transcribe"; then
    echo -e "${GREEN}✓${NC} Edge Function 'transcribe' 已部署"
else
    echo -e "${RED}✗${NC} Edge Function 'transcribe' 未部署"
    echo "   部署命令: supabase functions deploy transcribe"
    exit 1
fi
echo ""

# 检查 Secrets
echo "4️⃣ 检查 Secrets 配置..."
if supabase secrets list 2>&1 | grep -q "GROQ_API_KEY"; then
    echo -e "${GREEN}✓${NC} GROQ_API_KEY 已配置"
else
    echo -e "${RED}✗${NC} GROQ_API_KEY 未配置"
    echo "   设置命令: supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here"
    exit 1
fi
echo ""

# 检查数据库表
echo "5️⃣ 检查数据库表..."
TABLE_CHECK=$(supabase db remote execute "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transcription_usage');" 2>&1 || echo "false")

if echo "$TABLE_CHECK" | grep -q "t"; then
    echo -e "${GREEN}✓${NC} 表 'transcription_usage' 已创建"
else
    echo -e "${RED}✗${NC} 表 'transcription_usage' 不存在"
    echo "   创建表: 在 Supabase SQL Editor 中执行 scripts/init-supabase.sql"
    exit 1
fi
echo ""

# 检查 RLS 策略
echo "6️⃣ 检查 RLS 策略..."
RLS_CHECK=$(supabase db remote execute "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'transcription_usage';" 2>&1 || echo "0")

if echo "$RLS_CHECK" | grep -q "[1-9]"; then
    echo -e "${GREEN}✓${NC} RLS 策略已配置"
else
    echo -e "${YELLOW}⚠${NC} RLS 策略未找到"
    echo "   可能需要重新运行: scripts/init-supabase.sql"
fi
echo ""

# 获取项目信息
echo "7️⃣ 获取项目信息..."
PROJECT_REF=$(supabase status | grep "Project ID" | awk '{print $3}' || echo "unknown")
echo "   项目 ID: $PROJECT_REF"

# 构建 Edge Function URL
FUNCTION_URL="https://$PROJECT_REF.supabase.co/functions/v1/transcribe"
echo "   Edge Function URL: $FUNCTION_URL"
echo ""

# 总结
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ 所有检查通过！${NC}"
echo ""
echo "📝 下一步："
echo "   1. 打开应用 → 专注模式 → 黑匣子"
echo "   2. 按住 🎙️ 按钮录音"
echo "   3. 松开按钮，查看转写结果"
echo ""
echo "🔍 如果仍有问题，查看日志："
echo "   supabase functions logs transcribe --tail 50"
echo ""
echo "📚 详细故障排查: TRANSCRIBE-TROUBLESHOOTING.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
