## 🚀 快速修复 Chrome DevTools MCP 问题

> **问题：** `Could not find Google Chrome executable for channel 'stable' at: /opt/google/chrome/chrome`

### 一句话解决方案

**重启 VS Code 或 DevContainer**。所有环境变量已自动配置。

### 更详细的修复步骤（如果重启无效）

```bash
# 1. 激活环境变量
source ~/.bashrc

# 2. 验证 Chromium 已安装
echo $CHROME_PATH

# 3. 如果为空，手动设置
export CHROME_PATH="/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
export CHROMIUM_PATH="$CHROME_PATH"
export BROWSER="$CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
export GOOGLE_CHROME_BIN="$CHROME_PATH"

# 4. 重启 VS Code
pkill -f "code-server"
code-server   # 或在 VS Code 中打开
```

### 配置清单

- [x] Playwright Chromium 已下载
- [x] `.env.local` 已配置
- [x] `~/.bashrc` 已配置
- [x] `.devcontainer.json` 已配置
- [x] `.vscode/settings.json` 已配置
- [ ] **VS Code 已重启**（你需要做这个）

### 如果问题依旧

参考完整指南: [docs/chrome-devtools-mcp-setup.md](../docs/chrome-devtools-mcp-setup.md)

命令：
```bash
# 强制重新初始化
bash scripts/init-vscode-env.sh

# 验证浏览器
ls -lh /home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome

# 查看所有已安装的浏览器
find /home/codespace/.cache/ms-playwright -name "chrome" -type f
```
