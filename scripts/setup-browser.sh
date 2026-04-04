#!/bin/bash
# 修复 Chrome DevTools MCP 浏览器缺失问题

set -e

echo "🔧 正在配置 Playwright Chromium 浏览器..."

# 步骤 1: 安装 Playwright 浏览器
echo "📥 下载 Playwright Chromium..."
npx playwright install chromium

# 步骤 2: 找到浏览器路径
CHROME_PATH=$(find /home/codespace/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
if [ -z "$CHROME_PATH" ]; then
  CHROME_PATH=$(find /root/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
fi

if [ -z "$CHROME_PATH" ]; then
  echo "❌ 未找到 Chromium 浏览器"
  exit 1
fi

echo "✓ 浏览器位置: $CHROME_PATH"

# 步骤 3: 创建环境配置
echo "📝 配置环境变量..."
cat > /workspaces/dde/.env.local << EOF
# Playwright Chromium 配置 (自动生成)
BROWSER=$CHROME_PATH
CHROME_PATH=$CHROME_PATH
PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH
EOF

# 步骤 4: 在 VS Code 工作空间设置中添加浏览器路径
echo "⚙️  更新 VS Code 工作空间设置..."
mkdir -p /workspaces/dde/.vscode
cat > /workspaces/dde/.vscode/settings.json << 'EOF'
{
  "terminal.integrated.env.linux": {
    "BROWSER": "${workspaceFolder}/../.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
  },
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true
}
EOF

echo ""
echo "✅ 配置完成！"
echo ""
echo "现在你可以：" 
echo "1. 重启 VS Code 或 DevContainer"
echo "2. Copilot MCP 服务器应该可以访问 Chrome 了"
echo ""
echo "浏览器路径: $CHROME_PATH"
echo ""
