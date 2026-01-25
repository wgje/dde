#!/bin/bash
# 性能分析脚本 - 分析 NanoFlow 项目页面

TARGET_URL="https://dde-eight.vercel.app/#/projects"
TRACE_FILE="tmp/performance-trace-$(date +%Y%m%d-%H%M%S).json.gz"

echo "🔍 开始性能分析"
echo "目标页面: $TARGET_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 检查 Chrome 是否运行
if ! curl -s http://127.0.0.1:9223/json/version > /dev/null 2>&1; then
    echo "❌ Chrome 未运行在端口 9223"
    echo "请先运行: ./scripts/start-chrome-debug.sh"
    exit 1
fi

echo "✅ Chrome 已连接"
echo ""

# 使用 MCP 工具的说明
cat << 'EOF'
📊 性能分析步骤（在 Copilot 中执行）：

1. 创建新页面并导航：
   mcp_io_github_chr_new_page({ url: "https://dde-eight.vercel.app/#/projects" })

2. 等待页面加载：
   mcp_io_github_chr_wait_for({ text: "项目" })

3. 开始性能追踪：
   mcp_io_github_chr_performance_start_trace({ 
     reload: true, 
     autoStop: false 
   })

4. 等待页面完全加载（约 5-10 秒）

5. 停止追踪并保存：
   mcp_io_github_chr_performance_stop_trace({ 
     filePath: "tmp/performance-trace.json.gz" 
   })

6. 分析性能洞察：
   查看返回的 Core Web Vitals 和性能建议

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

关键指标：
• LCP (Largest Contentful Paint): 最大内容绘制 - 目标 < 2.5s
• FID (First Input Delay): 首次输入延迟 - 目标 < 100ms
• CLS (Cumulative Layout Shift): 累积布局偏移 - 目标 < 0.1
• FCP (First Contentful Paint): 首次内容绘制 - 目标 < 1.8s
• TTI (Time to Interactive): 可交互时间 - 目标 < 3.8s

EOF
