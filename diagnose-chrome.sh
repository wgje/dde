#!/bin/bash
# Chrome MCP 诊断脚本

echo "🔍 Chrome MCP 诊断报告"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. 检查 Chrome 是否安装
echo "1️⃣ 检查 Chrome 安装"
if command -v google-chrome &> /dev/null; then
    echo "   ✅ google-chrome: $(google-chrome --version)"
elif command -v chromium &> /dev/null; then
    echo "   ✅ chromium: $(chromium --version)"
else
    echo "   ❌ 未找到 Chrome/Chromium"
fi
echo ""

# 2. 检查端口占用
echo "2️⃣ 检查端口 9223"
if lsof -i :9223 &> /dev/null; then
    echo "   ⚠️  端口 9223 已被占用："
    lsof -i :9223
else
    echo "   ✅ 端口 9223 空闲"
fi
echo ""

# 3. 检查 Chrome 进程
echo "3️⃣ 检查 Chrome 进程"
CHROME_PROCS=$(ps aux | grep -i chrome | grep -v grep | wc -l)
if [ "$CHROME_PROCS" -gt 0 ]; then
    echo "   ℹ️  发现 $CHROME_PROCS 个 Chrome 进程"
    ps aux | grep -i chrome | grep -v grep | head -3
else
    echo "   ℹ️  无运行中的 Chrome 进程"
fi
echo ""

# 4. 测试远程调试端口
echo "4️⃣ 测试远程调试接口"
if curl -s http://127.0.0.1:9223/json/version &> /dev/null; then
    echo "   ✅ Chrome 远程调试可用"
    curl -s http://127.0.0.1:9223/json/version | jq '.'
else
    echo "   ❌ Chrome 远程调试不可用"
fi
echo ""

# 5. 环境信息
echo "5️⃣ 环境信息"
echo "   DISPLAY: ${DISPLAY:-未设置}"
echo "   User: $(whoami)"
echo "   工作目录: $(pwd)"
echo ""

# 6. MCP 配置
echo "6️⃣ MCP 配置"
if [ -f ".vscode/mcp.json" ]; then
    echo "   ✅ .vscode/mcp.json 存在"
    cat .vscode/mcp.json | jq '.servers."io.github.ChromeDevTools/chrome-devtools-mcp"'
else
    echo "   ❌ .vscode/mcp.json 不存在"
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 建议
if ! curl -s http://127.0.0.1:9223/json/version &> /dev/null; then
    echo "💡 解决方案："
    echo ""
    echo "方案 1: 使用启动脚本"
    echo "  chmod +x start-chrome.sh"
    echo "  ./start-chrome.sh"
    echo ""
    echo "方案 2: 手动启动 headless Chrome"
    echo "  google-chrome --headless=new --remote-debugging-port=9223 \\"
    echo "    --no-sandbox --disable-gpu --user-data-dir=/tmp/chrome-debug &"
    echo ""
    echo "方案 3: 使用 MCP 自动启动（修改 .vscode/mcp.json 后重启 VS Code）"
fi
