#!/bin/bash
# MCP Chrome DevTools 浏览器代理启动脚本
# 解决 puppeteer-core 和其他 CDP 客户端的浏览器发现问题

set -e

# 找到 Playwright Chromium
PLAYWRIGHT_CHROME=$(find /home/codespace/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
PLAYWRIGHT_CHROME=${PLAYWRIGHT_CHROME:-/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome}

if [ ! -f "$PLAYWRIGHT_CHROME" ]; then
  echo "❌ 错误: 未找到 Playwright Chromium 在 $PLAYWRIGHT_CHROME" >&2
  exit 127
fi

# 设置环境变量供 puppeteer-core 和其他库使用
export CHROME_PATH="$PLAYWRIGHT_CHROME"
export CHROMIUM_PATH="$PLAYWRIGHT_CHROME"
export BROWSER="$PLAYWRIGHT_CHROME"
export PUPPETEER_EXECUTABLE_PATH="$PLAYWRIGHT_CHROME"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# 创建一个本地符号链接目录（如果有权限的话）
if [ -w /tmp ]; then
  mkdir -p /tmp/chrome-link
  ln -sf "$PLAYWRIGHT_CHROME" /tmp/chrome-link/chrome 2>/dev/null || true
  export CHROME_EXECUTABLE=/tmp/chrome-link/chrome
fi

echo "✓ Chrome 路径已设置: $PLAYWRIGHT_CHROME"
echo "✓ 环境变量已导出"

# 执行后续命令
if [ $# -gt 0 ]; then
  exec "$@"
fi
