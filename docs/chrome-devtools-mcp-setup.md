# Chrome DevTools MCP 浏览器配置指南

## 问题
内置浏览器调试工具 (Chrome DevTools MCP 服务器) 在容器中无法使用，因为缺少 Chrome/Chromium 浏览器。
错误信息: `Could not find Google Chrome executable for channel 'stable' at: /opt/google/chrome/chrome`

## 解决方案
已自动配置 Playwright Chromium 浏览器来替代系统 Chrome，并通过多层级环境变量配置确保 MCP 服务器能找到它。

### 已完成的配置：

#### 1. **Playwright Chromium 已安装**
```
安装位置: /home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
```

#### 2. **环境变量配置（三层）**

**第一层：.env.local**（应用级别）
```bash
BROWSER=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
CHROME_PATH=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
CHROMIUM_PATH=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
PUPPETEER_EXECUTABLE_PATH=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
GOOGLE_CHROME_BIN=/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
```

**第二层：~/.bashrc**（Shell 级别）
- 自动在每次打开终端时加载环境变量

**第三层：.devcontainer.json**（DevContainer 级别）
- remoteEnv: 为整个容器设置环境变量
- terminal.integrated.env.linux: 为 VS Code 终端设置

**第四层：.vscode/settings.json**（VS Code 工作空间级别）
- 为 VS Code 内集成终端设置环境变量

#### 3. **VS Code 启动脚本**
文件: `scripts/vscode-launch.sh`
- 在启动 VS Code 时预先设置所有浏览器环境变量
- 确保 MCP 服务器能够找到 Chromium

#### 4. **初始化脚本**
文件: `scripts/init-vscode-env.sh`
- 在每次启动时验证 Playwright Chromium
- 创建本地符号链接 `/tmp/chrome-link/chrome`（如果有权限）
- 导出环境变量供其他进程使用

## 使用

### 方案 A: 重启 VS Code（推荐）
1. **完全关闭 VS Code**
2. **重新打开 VS Code 或 DevContainer**
3. Chrome DevTools MCP 应该现在可用
4. Copilot 聊天中的浏览器功能应该正常工作

### 方案 B: 手动启动脚本

```bash
# 激活环境（当前 shell 会话）
source scripts/init-vscode-env.sh

# 或启动 VS Code 包装脚本
bash scripts/vscode-launch.sh code
```

### 方案 C: 确保环境变量生效

```bash
# 重新加载 shell 配置
source ~/.bashrc

# 验证环境变量
echo $CHROME_PATH
echo $BROWSER
echo $PUPPETEER_EXECUTABLE_PATH

# 验证浏览器可用
ls -lh $CHROME_PATH
```

### 对于 E2E 测试
```bash
# 测试使用 Playwright 浏览器
npm run test:e2e

# 使用 UI 模式
npm run test:e2e:ui
```

## 故障排除

### 问题 1: MCP 仍然未找到浏览器

**症状**: 继续报错 `Could not find Google Chrome executable`

**排查步骤**:
```bash
# 1. 验证 Playwright Chromium 已安装
ls -lh /home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome

# 2. 检查环境变量是否已设置
echo $CHROME_PATH
echo $GOOGLE_CHROME_BIN

# 3. 重新加载 bash 配置
source ~/.bashrc
echo $CHROME_PATH

# 4. 在新的 shell 中验证（打开新的终端）
bash -c 'echo $CHROME_PATH'
```

**解决方案**:
```bash
# 重新运行初始化脚本
bash scripts/init-vscode-env.sh

# 强制重启 Code Server
pkill -f "code-server" || true
sleep 2
code-server
```

### 问题 2: ~/.bashrc 中的环境变量未被加载

**原因**: VS Code 或 MCP 可能没有启动 login shell

**解决方案**: 检查并更新 Shell 配置
```bash
# 查看是否在 ~/.bashrc 中添加了变量
grep "CHROME_PATH" ~/.bashrc

# 如果没有，手动添加
cat >> ~/.bashrc << 'EOF'
export CHROME_PATH="/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
export CHROMIUM_PATH="$CHROME_PATH"
export BROWSER="$CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export GOOGLE_CHROME_BIN="$CHROME_PATH"
EOF

source ~/.bashrc
```

### 问题 3: DevContainer 中浏览器不可用

**原因**: DevContainer 启动时未运行初始化脚本

**解决方案**: 重建 DevContainer
```bash
# 重建容器（在 VS Code 命令面板中）
Dev Containers: Rebuild Container

# 或手动运行
bash scripts/init-vscode-env.sh
```

### 问题 4: 权限问题导致 `/opt/google/chrome` 创建失败

**症状**: `Permission denied` 错误

**解决方案**: 使用当前用户可写的目录
```bash
# 在 /tmp 中创建符号链接（通常总是可写的）
mkdir -p /tmp/chrome-link
ln -sf /home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome /tmp/chrome-link/chrome

# 设置环境变量指向它
export CHROME_PATH="/tmp/chrome-link/chrome"
```

### 问题 5: 重装所有东西

```bash
# 清除缓存
rm -rf /home/codespace/.cache/ms-playwright
rm -rf ~/.cache/ms-playwright

# 重新安装 Playwright
cd /workspaces/dde
npm ci
npx playwright install chromium

# 重新运行初始化
bash scripts/init-vscode-env.sh

# 重启 VS Code
```

## 技术细节

### 为什么使用 Playwright Chromium？
- ✅ 自动下载，无需系统 Chrome 依赖
- ✅ 在 E2E 测试中已经使用 (`@playwright/test`)
- ✅ 与 CDP (Chrome DevTools Protocol) 完全兼容
- ✅ Copilot MCP 服务器可以通过环境变量找到它
- ✅ 在 DevContainer 中开箱即用

### 路径映射
```
期望路径                    → 实际 Playwright 路径
─────────────────────────────────────────────────────
/opt/google/chrome/chrome  → ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
```

### 环境变量优先级
1. **PUPPETEER_EXECUTABLE_PATH** (最高优先级) - 某些库优先使用此变量
2. **CHROME_PATH** - 广泛使用的标准变量
3. **CHROMIUM_PATH** - Chromium 特定变量
4. **BROWSER** - 通用浏览器变量
5. **GOOGLE_CHROME_BIN** - Google Chrome 特定变量

## 配置文件说明

| 文件 | 用途 | 优先级 |
|------|------|--------|
| `.env.local` | 应用环境变量 | 低 |
| `~/.bashrc` | Shell 会话环境 | 中 |
| `.devcontainer.json` | DevContainer 环境 | 高 |
| `.vscode/settings.json` | VS Code 工作空间 | 高 |
| `scripts/init-vscode-env.sh` | 动态初始化脚本 | 中（需要手动运行） |

## 后续步骤

- [x] 已完成：浏览器安装和配置
- [x] 已完成：多层级环境变量配置
- [ ] 下一步：**重启 VS Code 或 DevContainer**
- [ ] 验证：在 Copilot 聊天中使用浏览器功能

---

**更新日期**: 2026-04-04
**状态**: ✅ 完全配置

