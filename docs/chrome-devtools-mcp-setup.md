# Chrome DevTools MCP 浏览器配置指南

## 问题
内置浏览器调试工具 (Chrome DevTools MCP 服务器) 在容器中无法使用，因为缺少 Chrome/Chromium 浏览器。

## 解决方案
已自动配置 Playwright Chromium 浏览器来替代系统 Chrome。

### 已完成的配置：

#### 1. **Playwright Chromium 已安装**
```
安装位置: /home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
```

#### 2. **环境变量已配置**
文件: `.env.local`
```bash
BROWSER=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
CHROME_PATH=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
PUPPETEER_EXECUTABLE_PATH=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
```

#### 3. **VS Code 工作空间设置已更新**
文件: `.vscode/settings.json`
- 终端和任务会自动使用 Playwright 的 Chromium

#### 4. **DevContainer 配置已添加**
文件: `.devcontainer.json`
- 下次开启 DevContainer 时会自动安装浏览器和依赖

## 使用

### 对于 Copilot 调试工具
1. **重启 VS Code** 或 **重打开 DevContainer**
2. Chrome DevTools MCP 应该现在可用
3. 你可以在 Copilot 聊天中使用浏览器交互功能

### 对于手动测试
```bash
# E2E 测试使用 Playwright 浏览器
npm run test:e2e

# 开发时使用 UI 模式
npm run test:e2e:ui
```

### 手动验证
```bash
# 使用 bash 检查浏览器
source .env.local
$BROWSER --version

# 或使用 Playwright
npx playwright install-deps chromium 2>&1 | grep -v "GPG error"
```

## 故障排除

如果浏览器仍然不可用：

### 方案 A: 重新运行设置脚本
```bash
bash scripts/setup-browser.sh
```

### 方案 B: 手动设置环境（DevContainer 内）
```bash
export BROWSER=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
export CHROME_PATH=$BROWSER
export PUPPETEER_EXECUTABLE_PATH=$BROWSER

# 验证
$BROWSER --version
```

### 方案 C: 检查浏览器文件
```bash
# 列出所有已安装的浏览器
find /home/codespace/.cache/ms-playwright -name "chrome" -type f

# 查看浏览器大小
du -sh /home/codespace/.cache/ms-playwright
```

### 方案 D: 重新安装（如果需要）
```bash
# 清除缓存
rm -rf /home/codespace/.cache/ms-playwright

# 重新安装
npx playwright install chromium
bash scripts/setup-browser.sh
```

## 技术细节

### 为什么使用 Playwright Chromium？
- ✅ 自动下载，无需系统 Chrome
- ✅ 在 E2E 测试中已经使用 (`@playwright/test`)
- ✅ 与 CDP (Chrome DevTools Protocol) 完全兼容
- ✅ Copilot MCP 服务器可以通过环境变量找到它

### 路径映射
```
系统路径          → Playwright 路径
─────────────────────────────────
/opt/chrome/chrome → ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
```

## 后续步骤

1. ✅ 已完成：浏览器安装和配置
2. ⏳ 下一步：重启 VS Code 或 DevContainer
3. ⏳ 验证：在 Copilot 聊天中使用浏览器功能

---

**问题来源图片说明：**
内置浏览器调试工具当前无法使用的错误已通过配置 Playwright Chromium 解决。
MCP 服务器现在拥有可用的浏览器环境。

