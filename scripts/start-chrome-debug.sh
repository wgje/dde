#!/bin/bash
# 启动 Chrome 用于远程调试和性能分析

# 检查 Chrome 是否已经运行
if curl -s http://127.0.0.1:9223/json/version > /dev/null 2>&1; then
    echo "✅ Chrome 已经在端口 9223 运行"
    curl -s http://127.0.0.1:9223/json/version | jq .
    exit 0
fi

echo "🚀 启动 Chrome 远程调试..."

# 清理旧的用户数据
rm -rf /tmp/chrome-debug

# 启动 Chrome（支持 headless 模式）
if command -v google-chrome &> /dev/null; then
    google-chrome \
        --remote-debugging-port=9223 \
        --user-data-dir=/tmp/chrome-debug \
        --no-first-run \
        --no-default-browser-check \
        --disable-gpu \
        --disable-dev-shm-usage \
        --disable-software-rasterizer \
        --no-sandbox \
        &
elif command -v chromium &> /dev/null; then
    chromium \
        --remote-debugging-port=9223 \
        --user-data-dir=/tmp/chrome-debug \
        --no-first-run \
        --no-default-browser-check \
        --disable-gpu \
        --disable-dev-shm-usage \
        --disable-software-rasterizer \
        --no-sandbox \
        &
else
    echo "❌ 未找到 Chrome 或 Chromium"
    echo "请在宿主机上运行："
    echo "  google-chrome --remote-debugging-port=9223 --user-data-dir=/tmp/chrome-debug"
    exit 1
fi

# 等待 Chrome 启动
echo "⏳ 等待 Chrome 启动..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:9223/json/version > /dev/null 2>&1; then
        echo "✅ Chrome 已就绪！"
        curl -s http://127.0.0.1:9223/json/version | jq -r '"Browser: " + .Browser'
        exit 0
    fi
    sleep 1
done

echo "❌ Chrome 启动超时"
exit 1
