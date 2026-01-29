# NanoFlow Project Tracker

一个高效的项目追踪应用，具有双视图（文本/流程图）、专注模式、Markdown 支持、离线优先、云端同步。

---

## 🚀 快速开始

| 方式 | 适用场景 | 时间 |
|------|----------|------|
| [**🎯 在线体验**](#在线-demo) | 快速了解产品功能 | 即刻开始 |
| [**🔒 一键部署**](#一键部署私有实例) | 长期使用、数据私有 | 5 分钟 |
| [**💻 本地开发**](#本地运行) | 二次开发、贡献代码 | 10 分钟 |

### 在线 Demo

无需注册，数据存储在浏览器本地，体验核心功能：

> 🎮 **[立即体验 Demo →](https://demo-sigma-kohl.vercel.app/#/projects)** （离线模式，无需登录）

### 一键部署私有实例

**5 分钟拥有自己的 NanoFlow，数据完全在你的掌控中！**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde&env=NG_APP_SUPABASE_URL,NG_APP_SUPABASE_ANON_KEY&envDescription=Supabase%20%E9%85%8D%E7%BD%AE%EF%BC%88%E4%BB%8E%20Supabase%20Dashboard%20%3E%20Settings%20%3E%20API%20%E8%8E%B7%E5%8F%96%EF%BC%89&envLink=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde%23supabase-%E9%83%A8%E7%BD%B2%E9%85%8D%E7%BD%AE&project-name=my-nanoflow&repository-name=my-nanoflow)

<details>
<summary>📋 部署前准备：创建 Supabase 数据库（点击展开）</summary>

1. **创建 Supabase 项目**（约 2 分钟）
   - 打开 [supabase.com](https://supabase.com)，用 GitHub 登录
   - 点击「New project」，填写项目名称，选择区域
   - 等待项目初始化完成

2. **创建 Storage 存储桶**（约 30 秒）
   - 左侧菜单 → Storage → New bucket
   - 名称填 `attachments`，**不要**勾选 Public bucket
   - 点击 Create bucket

3. **执行数据库初始化脚本**（约 1 分钟）
   - 左侧菜单 → SQL Editor → New query
   - 打开本仓库 [`scripts/init-supabase.sql`](scripts/init-supabase.sql)，复制全部内容
   - 粘贴到 SQL Editor，点击 Run
   - 看到 ✅ Success 即可

4. **部署语音转写 Edge Function**（专注模式语音功能）
   ```bash
   # 设置 Groq API Key（从 console.groq.com 获取）
   supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here
   # 部署转写函数
   supabase functions deploy transcribe
   
   # 🔍 验证部署是否成功
   supabase functions list  # 应该看到 'transcribe'
   
   # 🧪 测试转写功能（可选）
   # 方法 1: 使用验证脚本
   chmod +x scripts/verify-transcribe-setup.sh
   ./scripts/verify-transcribe-setup.sh
   
   # 方法 2: 使用诊断工具
   # 打开 docs/transcribe-diagnostic-tool.html 在浏览器中测试
   ```

5. **获取 API 密钥**
   - 左侧菜单 → Project Settings → API
   - 复制 **Project URL** 和 **anon public** key
   - ⚠️ 注意：只用 `anon public`，不要用 `service_role`！

</details>

<details>
<summary>🔧 更多部署选项</summary>

#### Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/dydyde/dde)

部署后在 Site Settings → Environment variables 添加：
- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`

#### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/github?repo=https://github.com/dydyde/dde)

部署后在 Variables 中添加：
- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`


</details>

> 📚 **详细教程**：[完整部署指南](docs/deploy-private-instance.md) | [故障排查](docs/deploy-private-instance.md#故障排查指南)

### ✅ Vercel 环境变量设置（新手不翻车版）

1. 打开 Vercel → 你的项目 → Settings → Environment Variables
2. 必填变量：
   - `NG_APP_SUPABASE_URL`
   - `NG_APP_SUPABASE_ANON_KEY`
3. 可选变量（Sentry）：
   - `NG_APP_SENTRY_DSN` **或** `SENTRY_DSN`（二选一即可，脚本已兼容）
4. 保存后回到 Deployments → 重新部署（Redeploy）

> ⚠️ 说明：构建时会执行 `npm run config`，它会读取这些变量并生成环境文件。

---

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.x | 前端框架（Signals + 独立组件） |
| Supabase | ^2.84.0 | BaaS（认证 + 数据库 + 存储 + Edge Functions） |
| GoJS | ^3.1.1 | 流程图渲染 |
| Groq | whisper-large-v3 | 语音转写（专注模式黑匣子） |
| Sentry | ^10.32.1 | 错误监控 |
| Vitest / Playwright | - | 单元测试 / E2E 测试 |

---

## ⌨️ 键盘快捷键

### 全局快捷键

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Ctrl/⌘ + Z` | 撤销 | 撤销上一步操作 |
| `Ctrl/⌘ + Shift + Z` | 重做 | 重做撤销的操作 |
| `Ctrl/⌘ + F` | 搜索 | 打开全局搜索 |
| `Ctrl/⌘ + B` | 黑匣子 | 打开/关闭黑匣子面板 |
| `Ctrl/⌘ + .` | 聚光灯 | 进入聚光灯专注模式 |

### 流程图视图快捷键

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Delete / Backspace` | 删除 | 删除选中的任务或连接 |
| `Alt + Z` | 解除父子关系 | 将选中任务从父任务中分离 |
| `Alt + X` | 删除跨树连接 | 删除选中的跨树连接线 |
| `Ctrl/⌘ + 拖拽` | 多选 | 框选多个节点 |
| `滚轮` | 缩放 | 放大/缩小画布 |
| `拖拽空白区域` | 平移 | 移动画布视图 |

### 专注模式 - 大门 (Gate)

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `1` | 已读 | 标记当前条目为已读 |
| `2` | 完成 | 标记当前条目为完成 |
| `3` | 稍后 | 跳过当前条目，稍后提醒 |

### 专注模式 - 聚光灯 (Spotlight)

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Enter` | 完成 | 完成当前任务 |
| `→` (右箭头) | 跳过 | 跳过当前任务 |
| `Escape` | 退出 | 退出聚光灯模式 |

### 黑匣子 (Black Box)

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Enter` | 提交 | 提交文本输入 |
| `1` / `2` / `3` | 操作 | 条目操作快捷键 |

---

## 🎯 专注模式 (Focus Mode)

专注模式是 NanoFlow 的核心特性，帮助你摆脱任务堆积的焦虑，建立持续的工作节奏。

### 四大模块

| 模块 | 图标 | 功能 |
|------|------|------|
| **大门 (Gate)** | 🚪 | 每日首次打开时，强制处理昨日遗留条目 |
| **聚光灯 (Spotlight)** | 🔦 | 屏幕正中央只显示一件事，极简单任务执行 |
| **地质层 (Strata)** | 🗻 | 已完成任务按日堆叠，历史即地基 |
| **黑匣子 (Black Box)** | 📦 | 语音转文字的紧急捕捉，随时记录灵感 |

### 工作流程

```
启动应用 → 🚪 大门（处理昨日遗留）→ 🔦 聚光灯（专注当前任务）→ 🗻 地质层（查看成就）
                                          ↑
                                    📦 黑匣子（随时记录）
```

### 黑匣子语音功能

- **按住说话**：类似对讲机的交互，按住录音按钮说话
- **极速转写**：使用 Groq whisper-large-v3，1-2 秒内完成转写
- **离线支持**：断网时自动保存，联网后自动转写
- **配额控制**：每用户每日 50 次转写（可自定义）

---

## 本地运行

**前置条件:** Node.js 18+

1. 安装依赖:
   ```bash
   npm install
   ```

2. 配置环境变量 (可选):
   
   复制模板文件并填入你的实际配置：
   ```bash
   cp .env.template .env.local
   ```
   
   编辑 `.env.local` 文件：
   ```bash
   # Supabase 配置（云端同步功能）
   NG_APP_SUPABASE_URL=your_supabase_url
   NG_APP_SUPABASE_ANON_KEY=your_supabase_anon_key
   
   # Sentry 错误监控（可选）
   # 推荐：NG_APP_SENTRY_DSN（本地/自建环境）
   NG_APP_SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
   # 如果你在 Vercel 里习惯用 SENTRY_DSN，也可以直接用它（脚本已支持）
   # SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
   
   # GoJS License（可选，移除水印）
   NG_APP_GOJS_LICENSE_KEY=your_license_key
   ```
   
   然后生成环境文件：
   ```bash
   npm run config
   ```
   
   > ⚠️ `.env.local` 已在 `.gitignore` 中，不会被提交到代码仓库

3. 运行应用:
   ```bash
   npm start
   ```

## 开发命令

```bash
npm start              # 开发服务器
npm run test           # Vitest watch 模式
npm run test:run       # 单次运行测试
npm run test:e2e       # Playwright E2E
npm run lint:fix       # ESLint 自动修复
npm run build          # 生产构建
npx knip               # 检测未使用代码
```

## 功能特性

- 📝 **双视图模式**: 文本视图与流程图视图无缝切换
- 🎯 **专注模式**: 大门强制结算 + 聚光灯单任务聚焦 + 地质层成就感 + 黑匣子语音记录
- 🔄 **云端同步**: 通过 Supabase 实现多设备数据同步（LWW 冲突解决）
- 📱 **离线优先**: 本地 IndexedDB 存储，断网可用，联网自动同步
- 🎙️ **语音转写**: Groq whisper-large-v3 极速语音转文字（1-2 秒响应）
- 🎨 **主题系统**: 5 种精心设计的主题风格
- 📦 **PWA 支持**: 可安装，响应式设计
- 📝 **Markdown 支持**: 任务内容支持 Markdown 格式渲染
- 🔒 **附件支持**: 支持文件附件上传与管理
- ⌨️ **键盘友好**: 全面的快捷键支持，高效操作

---

## 数据保护

### 数据存储位置

NanoFlow 采用**多层数据保护架构**，确保用户数据安全：

| 层级 | 存储位置 | 说明 |
|------|----------|------|
| **A 层 - 本地缓存** | 浏览器 IndexedDB | 离线可用，实时响应，浏览器数据隔离 |
| **B 层 - 本地备份** | 下载 JSON 文件 | 手动导出，可在任何地方恢复 |
| **C 层 - 坚果云/同步盘** | 本地目录 → 云同步 | 自动定时备份，配合坚果云/Dropbox/OneDrive 同步 |
| **D 层 - 回收站** | 软删除 + 30 天保留 | 误删可恢复，到期自动清理 |
| **E 层 - 云端同步** | Supabase PostgreSQL | 服务器级备份，多设备同步 |

### 数据备份方法

#### 1. 手动导出（推荐定期操作）

在**设置 → 数据管理 → 导出数据**中，将所有项目导出为 JSON 文件。

- 导出文件包含：项目信息、所有任务、连接关系、附件元数据
- 建议：每周手动导出一次，保存到云盘或移动硬盘

#### 2. 本地自动备份（桌面 Chrome 推荐）

在**设置 → 本地自动备份**中配置：

1. 点击"选择备份目录"，选择坚果云/Dropbox/OneDrive 的同步文件夹
2. 开启"自动定时备份"（默认每 30 分钟）
3. 备份文件会自动同步到云端，形成版本历史

**注意：**
- 仅支持桌面 Chrome 浏览器（使用 File System Access API）
- 浏览器重启后需重新授权目录访问
- 备份保留最近 30 个版本，旧文件自动清理

#### 3. 云端同步

登录 Supabase 账号后，数据自动同步到云端：

- 实时增量同步（防抖 3 秒）
- LWW（最后写入优先）冲突解决
- 服务器端数据库级备份

### 数据恢复方法

| 场景 | 恢复方法 |
|------|----------|
| **误删任务** | 设置 → 系统仪表盘 → 回收站，选择恢复 |
| **浏览器数据丢失** | 设置 → 数据管理 → 导入数据，选择之前导出的 JSON |
| **本地备份恢复** | 打开坚果云同步目录，选择任意 `nanoflow-backup-*.json` 导入 |
| **多设备同步** | 登录同一账号，数据自动同步 |
| **回滚到历史版本** | 使用坚果云/Dropbox 的版本历史功能 |

---

### 手机端与电脑端备份关系

NanoFlow 支持手机和电脑双平台使用，但由于浏览器 API 限制，备份能力有所不同：

| 功能 | 📱 手机端 (Android Chrome) | 💻 电脑端 (Chrome) |
|------|---------------------------|-------------------|
| **本地缓存 (A层)** | ✅ IndexedDB 自动存储 | ✅ IndexedDB 自动存储 |
| **手动导出 (B层)** | ✅ 设置 → 导出数据 → 下载 JSON | ✅ 设置 → 导出数据 → 下载 JSON |
| **自动备份 (C层)** | ❌ 不支持（无 File System Access API） | ✅ 设置 → 本地自动备份 |
| **回收站 (D层)** | ✅ 30 天软删除保护 | ✅ 30 天软删除保护 |
| **云端同步 (E层)** | ✅ 登录后自动同步 | ✅ 登录后自动同步 |

#### 数据流向说明

```
┌─────────────────────────────────────────────────────────────────┐
│                        Supabase 云端 (E层)                       │
│                    PostgreSQL 数据库 + 服务器备份                 │
└─────────────────────────────────────────────────────────────────┘
                    ↑ 实时同步 ↓              ↑ 实时同步 ↓
┌───────────────────────────┐     ┌───────────────────────────────┐
│      📱 手机端 (Android)  │     │       💻 电脑端 (Chrome)      │
├───────────────────────────┤     ├───────────────────────────────┤
│  IndexedDB (A层)          │     │  IndexedDB (A层)              |
│    ↓ 手动导出              │     │    ↓ 手动导出  ↓ 自动备份      │
│  下载 JSON (B层)           │     │  下载 JSON    本地目录 (C层)   │
│    ↓ 保存到                │     │    ↓ 保存到     ↓ 自动同步     │
│  手机存储/云盘 App         │     │  任意位置     坚果云/Dropbox    │
└───────────────────────────┘     └───────────────────────────────┘
```

#### 手机端备份策略

由于手机浏览器不支持 File System Access API，无法实现自动备份到本地目录。建议：

1. **优先使用云端同步**：登录账号后，数据自动同步到服务器，这是手机端最可靠的备份方式
2. **定期手动导出**：每周在手机上执行一次「设置 → 导出数据」
3. **导出文件保存**：
   - 保存到手机本地存储（下载目录）
   - 通过分享功能发送到坚果云 App / 微信文件传输助手 / 邮箱
   - 直接上传到任意云盘 App

#### 电脑端备份策略

电脑端拥有完整的备份能力：

1. **自动备份到坚果云**：设置好本地备份目录后，每 30 分钟自动保存，坚果云客户端自动同步到云端
2. **版本历史**：坚果云/Dropbox 会保留文件历史版本，可回滚到任意时间点
3. **手动导出**：重大变更前手动导出一份，保存到不同位置

---

### 数据恢复操作指南

根据你的设备和数据丢失场景，选择合适的恢复方式：

#### 场景 1：手机数据丢失，需要恢复

| 恢复源 | 操作步骤 |
|--------|----------|
| **从云端恢复**（推荐） | 1. 打开 NanoFlow<br>2. 登录同一账号<br>3. 数据自动同步恢复 |
| **从手机导出文件恢复** | 1. 找到之前下载的 `nanoflow-export-*.json`<br>2. 打开 NanoFlow → 设置 → 导入数据<br>3. 选择该文件导入 |
| **从电脑备份恢复** | 1. 电脑坚果云目录找到 `nanoflow-backup-*.json`<br>2. 通过微信/邮件发送到手机<br>3. 手机打开 NanoFlow → 设置 → 导入数据 |

#### 场景 2：电脑数据丢失，需要恢复

| 恢复源 | 操作步骤 |
|--------|----------|
| **从云端恢复**（推荐） | 1. 打开 NanoFlow<br>2. 登录同一账号<br>3. 数据自动同步恢复 |
| **从坚果云备份恢复** | 1. 打开坚果云同步目录（如 `~/Nutstore/NanoFlow`）<br>2. 找到 `nanoflow-backup-*.json`（按日期选择）<br>3. 打开 NanoFlow → 设置 → 导入数据<br>4. 选择该文件导入 |
| **从手动导出恢复** | 1. 找到之前下载的 `nanoflow-export-*.json`<br>2. 打开 NanoFlow → 设置 → 导入数据<br>3. 选择该文件导入 |
| **从坚果云历史版本恢复** | 1. 右键点击备份文件 → 查看历史版本<br>2. 选择需要的版本下载<br>3. 导入该版本文件 |

#### 场景 3：误删除任务，需要恢复

| 操作步骤 |
|----------|
| 1. 打开 NanoFlow → 设置 → 系统仪表盘 |
| 2. 进入回收站 |
| 3. 找到误删的任务，点击恢复 |
| ⚠️ 注意：回收站仅保留 30 天，过期自动清理 |

#### 场景 4：需要回滚到历史版本

| 恢复源 | 操作步骤 |
|--------|----------|
| **坚果云版本历史** | 1. 打开坚果云同步目录<br>2. 右键 `nanoflow-backup-*.json` → 历史版本<br>3. 下载指定日期的版本<br>4. 导入该版本 |
| **多个备份文件** | 1. 备份文件名包含时间戳（如 `nanoflow-backup-2026-01-02_14-30-00.json`）<br>2. 选择需要的时间点文件导入 |

---

### 备份文件说明

| 文件类型 | 文件名格式 | 来源 | 内容 |
|----------|------------|------|------|
| **手动导出** | `nanoflow-export-2026-01-02.json` | 设置 → 导出数据 | 所有项目完整数据 |
| **自动备份** | `nanoflow-backup-2026-01-02_14-30-00.json` | 电脑端本地自动备份 | 所有项目完整数据 |

两种文件格式完全兼容，都可以通过「设置 → 导入数据」恢复。

### 数据保护建议

1. **启用云端同步**：登录 Supabase 账号，实现多设备同步和服务器备份
2. **配置本地自动备份**：选择坚果云同步目录，开启定时备份
3. **定期手动导出**：每周导出一次，保存到不同的存储介质
4. **保留多个版本**：不要覆盖旧备份，利用云盘版本历史

## 核心架构

```
src/
├── app/
│   ├── core/           # 核心单例（状态、同步）
│   ├── features/       # 业务模块
│   │   ├── flow/       # 流程图视图（GoJS）
│   │   ├── text/       # 文本视图（移动端默认）
│   │   └── focus/      # 专注模式（Gate/Spotlight/Strata/BlackBox）
│   └── shared/         # 共享组件与模态框
├── services/           # 主服务层（70+ 服务）
├── config/             # 配置常量
├── models/             # 数据模型
└── utils/              # 工具函数

supabase/
├── functions/
│   └── transcribe/     # 语音转写 Edge Function（Groq whisper-large-v3）
└── migrations/         # 数据库迁移脚本
```

---

## Supabase 部署配置

> 💡 **给新手的说明**：Supabase 是一个云端数据库服务。如果你不需要云端同步功能，可以跳过此部分，应用会以离线模式运行。

### 第一步：创建 Supabase 账号和项目

1. 打开 [supabase.com](https://supabase.com)，用 GitHub 或邮箱注册
2. 点击「New Project」创建新项目
3. 输入项目名称（如 `nanoflow`），选择一个靠近你的服务器区域
4. 设置一个数据库密码（记住它，但本应用用不到）
5. 等待几分钟，项目创建完成

### 第二步：创建附件存储桶

1. 在 Supabase 控制台左侧，点击「Storage」
2. 点击「New bucket」
3. 名称输入 `attachments`
4. 取消勾选「Public bucket」（保持私有）
5. 点击「Create bucket」

### 第三步：执行数据库初始化脚本

1. 在左侧菜单点击「SQL Editor」
2. 打开本项目的 `scripts/init-supabase.sql` 文件，全选复制内容
3. 粘贴到 SQL 编辑器中
4. 点击右下角的「Run」按钮
5. 等待执行完成，看到绿色提示「Success」即可

> 这个脚本会自动创建所有需要的表、函数、安全策略等，你不需要理解里面的内容。

### 第四步：获取连接信息

1. 在左侧点击「Project Settings」（齿轮图标）
2. 点击「API」
3. 复制以下两个值：
   - **Project URL**（类似 `https://xxx.supabase.co`）
   - **anon public key**（一长串字符）

### 第五步：配置应用环境变量

在项目根目录创建 `.env.local` 文件，填入：

```
NG_APP_SUPABASE_URL=上面复制的 Project URL
NG_APP_SUPABASE_ANON_KEY=上面复制的 anon public key
```

> ⚠️ **安全提示**：不要使用 `service_role` 密钥，那是管理员密钥，泄露会很危险。

### 第六步：（可选）启用定时清理

如果你想让系统自动清理 30 天前删除的任务：

1. 在控制台左侧点击「Database」→「Extensions」
2. 搜索 `pg_cron`，点击启用
3. 回到「SQL Editor」，执行以下命令：

```sql
SELECT cron.schedule('cleanup-deleted-tasks', '0 3 * * *', $$SELECT cleanup_old_deleted_tasks()$$);
SELECT cron.schedule('cleanup-deleted-connections', '0 3 * * *', $$SELECT cleanup_old_deleted_connections()$$);
SELECT cron.schedule('cleanup-old-logs', '0 4 * * 0', $$SELECT cleanup_old_logs()$$);
SELECT cron.schedule('cleanup-expired-scan-records', '0 5 * * 0', $$SELECT cleanup_expired_scan_records()$$);
```

### 配置完成！

重新启动应用 (`npm start`)，现在你可以：
- 注册/登录账号
- 数据自动同步到云端
- 多设备之间数据保持一致

---

### 附录：数据库对象速查

<details>
<summary>点击展开详细说明（给开发者）</summary>

**核心表（5 个）**
- `projects` - 项目
- `project_members` - 项目成员（协作预留）
- `tasks` - 任务
- `connections` - 任务连接
- `user_preferences` - 用户偏好

**辅助表（8 个）**
- `task_tombstones` / `connection_tombstones` - 永久删除记录
- `cleanup_logs` - 清理日志
- `circuit_breaker_logs` - 安全删除审计
- `app_config` - 应用配置
- `purge_rate_limits` - 速率限制
- `attachment_scans` / `quarantined_files` - 病毒扫描相关

**视图（2 个）**
- `active_tasks` - 过滤已删除任务
- `active_connections` - 过滤已删除连接

**常用 RPC 函数**
- `get_dashboard_stats()` - 获取仪表盘统计
- `batch_upsert_tasks(tasks, project_id)` - 批量更新任务
- `purge_tasks_v3(project_id, task_ids)` - 永久删除任务
- `safe_delete_tasks(task_ids, project_id)` - 安全软删除

完整函数和触发器清单请参考 `scripts/README.md`。

</details>

---

## 关键配置

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | API 超时 |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | 离线模式 |
| `FOCUS_CONFIG.DAILY_TRANSCRIPTION_LIMIT` | 50 | 每日转写配额 |
| `FOCUS_CONFIG.MAX_SNOOZE_PER_DAY` | 3 | 大门每日最大跳过次数 |

---

## 浏览器支持

| 浏览器 | 版本 | 说明 |
|--------|------|------|
| Chrome | 90+ | ✅ 完整支持（推荐） |
| Edge | 90+ | ✅ 完整支持 |
| Firefox | 90+ | ✅ 完整支持 |
| Safari | 15+ | ✅ 支持（语音功能使用 mp4 格式） |
| iOS Safari | 15+ | ✅ 支持（语音需用户手势触发） |
| Android Chrome | 90+ | ✅ 完整支持 |

> ⚠️ **本地自动备份功能**仅支持桌面 Chrome/Edge（使用 File System Access API）

## License

MIT
