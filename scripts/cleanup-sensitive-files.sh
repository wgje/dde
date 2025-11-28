#!/bin/bash
# 此脚本用于从 Git 历史中移除敏感的环境配置文件
# 警告：此操作会重写 Git 历史，请谨慎使用！

echo "⚠️  警告：此脚本将从 Git 历史中移除敏感文件"
echo "   这将重写 Git 历史，需要强制推送到远程仓库"
echo ""
read -p "确定要继续吗？(y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消操作"
    exit 1
fi

# 从 Git 缓存中移除文件（保留本地文件）
echo "正在从 Git 追踪中移除敏感文件..."
git rm --cached src/environments/environment.ts 2>/dev/null || true
git rm --cached src/environments/environment.development.ts 2>/dev/null || true

# 确认 .gitignore 包含这些文件
if ! grep -q "src/environments/environment.ts" .gitignore 2>/dev/null; then
    echo "src/environments/environment.ts" >> .gitignore
fi
if ! grep -q "src/environments/environment.development.ts" .gitignore 2>/dev/null; then
    echo "src/environments/environment.development.ts" >> .gitignore
fi

echo ""
echo "✅ 文件已从 Git 追踪中移除"
echo ""
echo "下一步操作："
echo "1. 运行: git commit -m 'chore: remove sensitive env files from tracking'"
echo "2. 运行: git push"
echo ""
echo "⚠️  重要提醒："
echo "   - 已泄露的 Supabase 密钥应该在 Supabase 控制台中轮换/重置"
echo "   - 更新 .env.local 中的新密钥后运行 npm run config"
