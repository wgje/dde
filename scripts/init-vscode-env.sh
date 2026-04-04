#!/bin/bash
# VS Code 工作空间初始化脚本
# 为 MCP 服务器和浏览器工具配置环境

echo "🔧 初始化 VS Code 工作空间环境..."

# 确保 Playwright Chromium 已安装
CHROME_PATH="/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

if [ ! -f "$CHROME_PATH" ]; then
  echo "📥 Playwright Chromium 未找到，正在安装..."
  cd /workspaces/dde
  npx playwright install chromium --with-deps 2>&1 | grep -v "GPG error" || true
else
  echo "✓ Playwright Chromium 已安装: $CHROME_PATH"
fi

# 导出环境变量给 VS Code 扩展
export CHROME_PATH="$CHROME_PATH"
export CHROMIUM_PATH="$CHROME_PATH"
export BROWSER="$CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export GOOGLE_CHROME_BIN="$CHROME_PATH"

# 创建一个本地符号链接（如果有权限）
if [ -w /tmp ]; then
  mkdir -p /tmp/chrome-link
  ln -sf "$CHROME_PATH" /tmp/chrome-link/chrome 2>/dev/null || true
  echo "✓ 本地符号链接: /tmp/chrome-link/chrome"
fi

# 保存环境到文件供其他进程使用
cat > /tmp/vscode-env.sh << EOF
export CHROME_PATH="$CHROME_PATH"
export CHROMIUM_PATH="$CHROME_PATH"
export BROWSER="$CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export GOOGLE_CHROME_BIN="$CHROME_PATH"
EOF

echo "✓ 环境变量已导出到: /tmp/vscode-env.sh"
echo ""
echo "✅ 初始化完成！"
echo "💡 MCP 服务器现在应该能找到浏览器了"
