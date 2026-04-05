#!/bin/bash
# VS Code 启动包装脚本 - 为 MCP 和浏览器工具注入环境

resolve_chrome_path() {
  local cache_dir
  local found_path

  if [ -x "/tmp/chrome-link/chrome" ]; then
    printf '%s\n' "/tmp/chrome-link/chrome"
    return 0
  fi

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

CHROME_PATH=$(resolve_chrome_path || true)

if [ -n "$CHROME_PATH" ]; then
  export CHROME_PATH="$CHROME_PATH"
  export CHROMIUM_PATH="$CHROME_PATH"
  export BROWSER="$CHROME_PATH"
  export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
  export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
  export GOOGLE_CHROME_BIN="$CHROME_PATH"
  export CHROME_EXECUTABLE="$CHROME_PATH"
else
  echo "⚠️ 未找到 Playwright Chromium，VS Code 将在无浏览器注入环境下启动。" >&2
fi

export NODE_V8_MAX_OLD_SPACE_SIZE=4096

if [ $# -gt 0 ]; then
  exec "$@"
else
  exec code-server "$@"
fi
