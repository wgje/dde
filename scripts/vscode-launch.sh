#!/bin/bash
# VS Code 启动包装脚本 - 为 MCP 和浏览器工具注入环境

# 设置 Playwright Chromium 环境变量
export CHROME_PATH="/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
export CHROMIUM_PATH="$CHROME_PATH"
export BROWSER="$CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export GOOGLE_CHROME_BIN="$CHROME_PATH"

# 对于某些 npm 包可能期望的路径
export CHROME_EXECUTABLE="$CHROME_PATH"

# Node.js 内存配置
export NODE_V8_MAX_OLD_SPACE_SIZE=4096

# 启动 VS Code（如果提供了参数）
if [ -n "$@" ]; then
  exec "$@"
else
  # 否则启动 VS Code 服务器模式（用于 DevContainer）
  exec code-server "$@"
fi
