# NanoFlow

NanoFlow 是一个离线优先、单用户、多设备同步的个人任务系统。当前仓库已经不再只是“项目追踪器”，而是把文本任务树、GoJS 流程图、Parking Dock、Focus Mode、备份/恢复、Supabase 云同步整合在同一个 Angular PWA 中。

项目创建于 `2025-11-22`，最近一轮主线演进集中在 `2026-03`：停泊坞/Dock 模块化、Focus 交互打磨、个人后端收缩、安全与可靠性加固，以及同步链路的持续整理。

## 当前定位

- 面向个人工作流，而不是团队协作平台。
- 默认假设是“本地立即可用，联网后再补同步”。
- 手机端优先文本视图；流程图在需要时按需加载，而不是常驻后台。
- Dock 和 Focus 已经是一级能力，不再只是附属功能。

## 核心能力

| 能力 | 本地离线 | 需要 Supabase | 可选 Edge Functions | 说明 |
|------|----------|---------------|----------------------|------|
| 文本任务树 | 是 | 否 | 否 | 任务分层编辑、过滤、深链定位、键盘操作 |
| 流程图视图 | 是 | 否 | 否 | GoJS 渲染、节点连接、空间规划；移动端按需进入 |
| Parking Dock | 是 | 否 | 否 | 停泊、提醒、时间槽、状态机、专注接管 |
| Focus Mode | 是 | 否 | 否 | Gate、Spotlight、Strata、Black Box 工作流 |
| Markdown 渲染 | 是 | 否 | 否 | 已做安全处理，适合任务内容和说明文本 |
| 导出 / 导入 | 是 | 否 | 否 | 本地 JSON 级数据迁移与恢复 |
| 本地自动备份 | 是 | 否 | 否 | 基于 File System Access API，适合桌面 Chrome 类浏览器 |
| 附件上传与签名 URL 刷新 | 否 | 是 | 否 | 依赖 Supabase Storage |
| 云同步 | 否 | 是 | 否 | IndexedDB 本地优先，后台增量拉取，LWW 冲突策略 |
| 黑匣子语音转写 | 否 | 是 | `transcribe` | 通过 Edge Function 代理 Groq `whisper-large-v3` |
| 服务端备份 / 恢复 | 否 | 是 | 是 | 仓库包含 backup / cleanup / restore 相关函数与调度面 |

## 架构总览

### 前端基线

- Angular `19.2.x`
- TypeScript `5.8.x`
- Signals + `standalone: true` + `OnPush`
- PWA / Service Worker
- `withHashLocation()` 路由策略

### 关键模块

- `src/app/core/state/stores.ts`
  - 任务、项目、连接三类核心 store，保持扁平状态结构。
- `src/app/core/services/simple-sync.service.ts`
  - 同步门面，负责 LWW、RetryQueue、增量拉取、重试与恢复。
- `src/app/features/text/`
  - 文本视图，适合密集编辑与层级组织。
- `src/app/features/flow/`
  - GoJS 流程图视图，负责空间布局与连接关系。
- `src/app/features/parking/`
  - 停泊坞与 Dock 相关 UI，是当前版本的重要工作台能力。
- `src/app/features/focus/`
  - Gate / Spotlight / Strata / Black Box 组成的专注工作流。
- `src/services/`
  - 大量业务服务、编排服务、备份/附件/偏好/Focus/Dock 服务都在这里。

### 数据与同步模型

- 所有业务实体 ID 由客户端 `crypto.randomUUID()` 生成。
- 读取路径：`IndexedDB -> 后台增量拉取(updated_at > last_sync_time)`。
- 写入路径：本地写入并立即更新 UI -> `3s` 防抖推送 -> 失败进入 RetryQueue。
- 冲突策略：LWW（Last-Write-Wins）。
- 手机端默认文本视图；流程图通过懒加载与销毁/重建规避 GoJS 常驻成本。

## 目录速览

```text
src/
  app/
    core/                 # shell、state、sync 核心单例
    features/
      text/               # 文本视图
      flow/               # GoJS 流程图
      parking/            # Parking Dock / Dock UI
      focus/              # Focus Mode
  services/               # 业务服务层
  config/                 # 配置常量
  models/                 # 领域模型
  utils/                  # 工具函数

supabase/
  functions/              # transcribe / backup / cleanup / restore 等 Edge Functions
  migrations/             # 数据库迁移

scripts/
  init-supabase.sql       # 唯一权威数据库初始化脚本
  run-test-matrix.cjs     # 测试矩阵驱动
```

## 快速开始

### 1. 本地离线开发

开发环境下，即使未配置 Supabase，也可以以离线模式运行主应用。

```bash
npm install
npm start
```

- Node.js 要求：`>=18.19.0`
- 默认开发端口：`3000`
- `npm start` 会自动执行 `npm run config`

### 2. 连接 Supabase 运行

如果你需要登录、云同步、附件或语音转写，请补齐环境和后端。

1. 复制环境模板：

```text
将 .env.template 复制为 .env.local
```

2. 至少填写以下变量：

```bash
NG_APP_SUPABASE_URL=...
NG_APP_SUPABASE_ANON_KEY=...
```

3. 在 Supabase 中完成以下准备：

- 创建私有 Storage bucket：`attachments`
- 执行 [`scripts/init-supabase.sql`](scripts/init-supabase.sql)
- 如需语音转写，部署 `transcribe` Edge Function 并配置对应 Secret

4. 启动应用：

```bash
npm start
```

### 3. 生产部署前校验

```bash
npm run validate-env:prod
npm run build:strict
```

## 环境变量

| 变量 | 是否必需 | 用途 |
|------|----------|------|
| `NG_APP_SUPABASE_URL` | 开发离线否；云同步/生产是 | Supabase 项目 URL |
| `NG_APP_SUPABASE_ANON_KEY` | 开发离线否；云同步/生产是 | Supabase 公开匿名 Key |
| `NG_APP_SENTRY_DSN` | 否 | Sentry 错误监控 |
| `NG_APP_GOJS_LICENSE_KEY` | 否 | GoJS License，移除水印 |
| `NG_APP_DEMO_MODE` | 否 | 公共演示实例限制开关 |
| `NG_APP_DEV_AUTO_LOGIN_EMAIL` | 否 | 本地开发自动登录 |
| `NG_APP_DEV_AUTO_LOGIN_PASSWORD` | 否 | 本地开发自动登录 |

说明：

- 开发环境缺少 Supabase 配置时，会降级为离线模式。
- 生产环境缺少 Supabase 配置时，会被视为配置错误。
- `npm run config` / `npm start` / `npm run build` 会读取这些变量并生成环境文件。

## 开发、测试与质量命令

### 开发与构建

```bash
npm start
npm run build
npm run build:dev
npm run build:strict
npm run validate-env
npm run validate-env:prod
```

### 测试

```bash
npm run test
npm run test:run
npm run test:run:verify
npm run test:run:full
npm run test:run:pure
npm run test:run:services
npm run test:run:components
npm run test:e2e
npm run test:e2e:perf
```

### 质量与性能门禁

```bash
npm run test:contracts
npm run lint
npm run lint:fix
npm run quality:guard:encoding
npm run perf:guard
npm run perf:guard:no-regression
```

### 数据库

```bash
npm run db:types
```

测试体系说明：

- 本地默认测试入口是 `scripts/run-test-matrix.cjs`
- 支持 Lane 分片、Quarantine 隔离、LPT 调度
- `npm run test:e2e` 默认只跑关键路径 E2E；性能预算门禁使用 `npm run test:e2e:perf`
- 更细的测试矩阵与脚本说明见 [`scripts/README.md`](scripts/README.md)

## 部署与基础设施

### 静态前端产物

- 产物目录：`dist/browser`
- 仓库内已提供：
  - [`vercel.json`](vercel.json)
  - [`netlify.toml`](netlify.toml)
  - [`railway.json`](railway.json)

### 路由与托管

- 路由使用 `withHashLocation()`，静态部署时对 rewrite 的依赖比 history 模式更低。
- 仓库仍然保留了 Vercel / Netlify / Railway 的托管配置，适合作为默认部署起点。

### Supabase 初始化原则

- [`scripts/init-supabase.sql`](scripts/init-supabase.sql) 是唯一权威初始化脚本。
- 改动表、RLS、RPC、触发器、索引、视图后，应同步更新该脚本，再执行 `npm run db:types`。

### 当前后端形态

当前主线后端已经收缩为更明确的个人部署模型：

- 以单用户、多设备同步为中心
- 协作表面已从主线 schema 中移除
- 保留了备份/恢复/清理等偏运维能力

这意味着 README 不再把 NanoFlow 描述为协作产品，而是一个个人工作台。

## 数据保护与同步

### 本地优先

- IndexedDB 是第一落点，保证断网可用。
- 本地操作优先生效，不等待云端确认。
- 失败写入进入 RetryQueue，等待后续联网重试。

### 云同步

- 通过 Supabase 承载认证、PostgreSQL、Storage、Edge Functions。
- 主同步链路强调增量拉取，而不是全量覆盖。
- Attachments、登录态、多设备一致性都依赖 Supabase。

### 备份与恢复

- 本地 JSON 导出/导入始终可用。
- 本地自动备份适合桌面 Chrome 类浏览器。
- 仓库还保留了服务端备份 / 清理 / 恢复 Edge Function 方案，适合需要额外保险的私有部署。

## 项目演进摘要

下面这段不是逐提交 changelog，而是帮助你快速理解项目从创立到当前版本的主线变化。

| 时间 | 主线变化 |
|------|----------|
| `2025-11` | 项目创建，建立离线优先、客户端 UUID、任务树 + 流程图的基础方向 |
| `2025-12` | 大规模目录整理与模块迁移，配置拆分，Flow 能力与测试逐步成形 |
| `2026-01` | 环境变量流程稳定、转写链路修复、同步/持久化/Flow 服务大量拆分，Sentry 改为懒加载 |
| `2026-02` | 测试矩阵、质量门禁、编码/终端兼容性治理、技术债清理与文档体系完善 |
| `2026-03` | Parking Dock / Dock Engine 成为一级模块，Focus 细节继续打磨，数据库转向 personal backend slim-down，认证与同步问题持续修复 |

如果你关心更细的上下文，可以从以下文件继续读：

- [`AGENTS.md`](AGENTS.md)
- [`.github/context/current-focus.md`](.github/context/current-focus.md)
- [`.github/context/recent-decisions.md`](.github/context/recent-decisions.md)

## 当前限制与取舍

- 当前主线不是协作产品；个人后端是明确方向。
- 本地自动备份依赖 File System Access API，移动端与部分浏览器不可用。
- 移动端默认文本视图，流程图不是手机端常驻主视图。
- 云同步、附件、登录态、语音转写都依赖 Supabase。
- 语音转写的实际限额和可用性取决于你的 Edge Function 部署与服务器侧策略，因此 README 不硬编码服务端配额承诺。
- 仓库中仍存在一些保留/实验性后端表面；本文只描述当前主线确认仍在使用的能力。

## 相关文档

- [私有实例部署指南](docs/deploy-private-instance.md)
- [脚本与数据库说明](scripts/README.md)
- [转写故障排查](TRANSCRIBE-TROUBLESHOOTING.md)
- [AGENTS 执行手册](AGENTS.md)

## License

MIT
