#!/bin/bash
# VS Code 工作空间初始化脚本
# 为 MCP 服务器和浏览器工具配置稳定的 Chromium 路径

echo "🔧 初始化 VS Code 工作空间环境..."

TARGET_CHROME_PATH="/tmp/chrome-link/chrome"

find_playwright_chrome() {
  local cache_dir
  local found_path

  for cache_dir in \
    "${PLAYWRIGHT_BROWSERS_PATH:-}" \
    "$HOME/.cache/ms-playwright" \
    "/home/codespace/.cache/ms-playwright" \
    "/home/vscode/.cache/ms-playwright" \
    "/root/.cache/ms-playwright"
  do
    [ -n "$cache_dir" ] || continue
    [ -d "$cache_dir" ] || continue

    found_path=$(find "$cache_dir" -path '*/chrome-linux64/chrome' -type f 2>/dev/null | head -1)
    if [ -n "$found_path" ]; then
      printf '%s\n' "$found_path"
      return 0
    fi
  done

  return 1
}

CHROME_PATH=$(find_playwright_chrome || true)

if [ -z "$CHROME_PATH" ]; then
  echo "📥 Playwright Chromium 未找到，正在安装..."
  cd /workspaces/dde || exit 1
  if ! npx playwright install chromium; then
    echo "⚠️ Playwright Chromium 安装失败，稍后可手动重试。"
  fi
  CHROME_PATH=$(find_playwright_chrome || true)
fi

if [ -z "$CHROME_PATH" ] || [ ! -f "$CHROME_PATH" ]; then
  echo "⚠️ 未找到 Playwright Chromium，跳过浏览器环境变量导出。"
  exit 0
fi

echo "✓ Playwright Chromium 已安装: $CHROME_PATH"

if [ -w /tmp ]; then
  mkdir -p /tmp/chrome-link
  ln -sf "$CHROME_PATH" "$TARGET_CHROME_PATH" 2>/dev/null || true
fi

if [ -x "$TARGET_CHROME_PATH" ]; then
  CHROME_PATH="$TARGET_CHROME_PATH"
  echo "✓ 稳定浏览器路径: $CHROME_PATH"
fi

export CHROME_PATH="$CHROME_PATH"
export CHROMIUM_PATH="$CHROME_PATH"
export BROWSER="$CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export GOOGLE_CHROME_BIN="$CHROME_PATH"

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
