#!/bin/bash
# 启动 headless Chrome 用于 MCP 性能分析

echo "🚀 启动 headless Chrome on port 9223..."

# 清理旧实例
pkill -f "chrome.*9223" 2>/dev/null
rm -rf /tmp/chrome-debug 2>/dev/null

# 启动 headless Chrome
nohup google-chrome \
  --headless=new \
  --remote-debugging-port=9223 \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --user-data-dir=/tmp/chrome-debug \
  --no-first-run \
  --disable-background-networking \
  --disable-default-apps \
  --disable-extensions \
  --disable-sync \
  --metrics-recording-only \
  --mute-audio \
  > /tmp/chrome.log 2>&1 &

# 等待启动
for i in {1..10}; do
    sleep 1
    if curl -s http://127.0.0.1:9223/json/version > /dev/null 2>&1; then
        echo "✅ Chrome 已就绪！"
        echo ""
        curl -s http://127.0.0.1:9223/json/version | jq -r '"Browser: " + .Browser'
        echo "WebSocket Debugger: $(curl -s http://127.0.0.1:9223/json/version | jq -r '."WebKit-Version"')"
        echo ""
        echo "现在可以使用 MCP Chrome 工具进行性能分析"
        exit 0
    fi
    echo "  等待中... ($i/10)"
done

echo "❌ Chrome 启动失败，检查日志:"
tail -20 /tmp/chrome.log
exit 1
