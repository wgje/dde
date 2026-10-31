---
title: 仓库地图
status: canonical
audience: contributor, maintainer, ai-agent
last_verified: 2026-07-15
category: develop-maintain
source_paths:
  - README.md
  - AGENTS.md
  - package.json
  - src/
  - src/app/core/
  - src/app/features/
  - src/services/
  - src/models/
  - supabase/
  - android/
  - scripts/
  - docs/context7/source-map.md
---

# 仓库地图

这页是“改动应该落在哪里”的索引，不是完整的源码导览。先根据你的改动场景找到主所有者，再沿着状态、服务、后端和测试确认完整链路。这样可以避免一个常见问题：界面所在目录看似是功能的全部，但真正的写入权、同步规则或恢复逻辑其实在另一个边界。

## 本文内容

- [怎么使用这张地图](#怎么使用这张地图)
- [顶层区域](#顶层区域)
- [前端和业务所有权](#前端和业务所有权)
- [按改动场景找入口](#按改动场景找入口)
- [数据从界面到云端的边界](#数据从界面到云端的边界)
- [后端、部署和 Android 边界](#后端部署和-android-边界)
- [测试、脚本和文档边界](#测试脚本和文档边界)
- [高风险区域](#高风险区域)
- [开始一个改动的阅读顺序](#开始一个改动的阅读顺序)
- [下一步](#下一步)

## 怎么使用这张地图

1. 用一句话描述可观察的改变，例如“离线编辑任务标题后刷新仍存在”或“Gate 审核完成后不再重复出现”。
2. 在下面的“按改动场景找入口”表中找到主区域；这只是起点，不代表只需改那一个目录。
3. 按仓库指令先从 CodeGraph 获取当前结构、调用链和影响面，再阅读被定位到的局部源文件和相邻测试。NanoFlow 提供上下文包和语义查询；MCP 不可用时先使用仓库规定的适配器回退。
4. 沿着“数据从界面到云端的边界”检查谁创建状态、谁持久化、谁同步、谁处理失败。不要把展示层当成数据所有者。
5. 改完后从 [测试与质量](03-testing-and-quality.md) 选择证明这条改变的门禁；若读者、运维者或 AI 能观察到新行为，再同步对应文档。

这张地图与 [Context7 源码地图](../../context7/source-map.md) 互补：这里用中文帮助真人决定从哪里开始，Context7 页面提供更紧凑的检索路由和源码契约。

## 顶层区域

| 路径 | 主要职责 | 什么时候进入 | 不要把它当成 |
| --- | --- | --- | --- |
| `src/app/` | Angular 应用壳、功能界面和共享 UI | 修改用户入口、视图、组件交互或应用生命周期 | 所有业务和同步逻辑的唯一位置 |
| `src/app/core/` | 应用壳、全局状态、持久化、同步和跨功能服务 | 改启动、会话、离线状态、同步调度或全局恢复 | 某个功能的视觉组件目录 |
| `src/app/features/` | 文本、Flow、Focus、Parking Dock 等功能 UI | 改对应工作流的界面和功能级交互 | 可以直接越过服务层写数据库的地方 |
| `src/app/shared/` | 跨功能组件、弹窗、管道和 UI 工具 | 多个功能确实共享同一种呈现或交互时 | 收纳尚未找清所有者的业务规则的抽屉 |
| `src/services/` | 任务操作、业务编排和跨 UI 的领域服务 | 改任务、连接、Focus、Dock 等业务行为 | 平行全局 store 的替代品 |
| `src/models/` | 领域模型、可持久化结构和功能数据类型 | 改数据形状、兼容性或跨层字段 | 只供某个模板临时使用的 UI 状态 |
| `src/config/` | 功能、同步、布局和安全相关常量 | 改显式配置、阈值或特性开关的契约 | 存放凭据或环境变量的地方 |
| `src/state/` | 独立状态工具和状态相关实现 | 当前逻辑明确属于该目录的状态职责时 | 绕过 `src/app/core/state/` 的新全局真相来源 |
| `src/utils/` | 无业务所有权的低层工具 | 输入输出能脱离产品领域独立理解时 | 逃避领域服务和错误处理的通用入口 |
| `src/tests/` | 单元、服务、组件、契约和脚本测试 | 为改动新增/更新直接证明 | 只跑一次就能替代生产行为审查的证据 |
| `supabase/` | 迁移、RLS、Storage 与 Edge Function | 改数据库、服务端秘密、云端 API 或部署行为 | 可从前端直接复制凭据的配置目录 |
| `android/` | Android 宿主、小组件和移动平台集成 | 改 Android 小组件、深链、通知或原生桥接 | Web PWA 的镜像副本 |
| `scripts/` | 构建、测试、文档、质量、环境和运维命令 | 需要新增或理解可执行门禁时 | 用手工步骤替代长期验证的地方 |
| `docs/` | 人类手册、Context7 契约、计划和归档 | 行为、运维、契约或维护路径改变时 | 已经通过代码注释就可以忽略的附属物 |
| `e2e/` | Playwright 关键用户流 | 改浏览器级工作流、离线恢复或部署验收时 | 所有小逻辑变更的默认首测 |
| `public/` | 静态资源与 PWA 发布资源 | 改用户直接加载的静态文件或发布资源时 | 应用运行时状态的存放处 |

## 前端和业务所有权

### 应用壳、状态与同步

`src/app/core/shell/` 负责应用壳和启动期协调；`src/app/core/state/` 负责全局状态与本地持久化边界；`src/app/core/services/sync/` 以及相关协调服务负责云端同步与恢复。修改启动、登录、离线、同步状态或应用级恢复时，不要只看某个页面组件：确认入口如何进入 shell、状态如何读写、失败是否进入队列，以及会话变化后有没有清理或重试。

当前的核心状态所有权以具体 store 和持久化服务为准。不要新建一个同时包住 `TaskStore`、`ProjectStore` 和 `ConnectionStore` 的 facade store；这会制造第二个状态入口，模糊谁负责一致性和持久化。

### 功能界面

| 区域 | 主工作流 | 修改时至少继续检查 |
| --- | --- | --- |
| `src/app/features/text/` | 文本任务树、编辑、搜索、层级与移动端交互 | 任务操作服务、相关拖拽/编辑规格和移动端行为 |
| `src/app/features/flow/` | GoJS Flow 图、节点关系和图形交互 | Flow 服务、模型同步和生命周期释放；保持按需加载且可销毁 |
| `src/app/features/focus/` | Focus、Gate、Black Box、Strata | `src/models/focus.ts`、Gate/Black Box 服务、离线捕获和审核状态 |
| `src/app/features/parking/` | Parking Dock、停泊、恢复和提醒 | Dock 服务、`src/models/parking-dock.ts`、恢复与快照兼容性 |
| `src/app/shared/` | 多功能共用的 UI 与弹窗 | 使用者是否真的跨功能共享；不要把一个功能的业务链搬进来 |

Angular 页面使用独立组件、signals 和 OnPush 预期。组件应表达交互和渲染；业务规则、持久化和同步继续由已存在的服务、状态和模型承担。

### 领域服务和模型

`src/services/` 中的 `task-*`、操作类服务以及 Focus、Dock 等服务负责任务和关系图的业务动作。任务图不应由渲染代码直接变异；UI 需要改变任务时，应经过现有操作服务和状态路径，让本地保存、同步队列、日志与失败恢复仍在同一条业务链中。

`src/models/` 定义跨层会用到的数据结构，特别是任务、Focus 和 Parking Dock 的持久化模型。修改字段时先判断它是否会跨越本地存储、同步、备份、Android 或 Supabase；如果会，就把兼容性和迁移视为一项完整改动，而不是只改一个 TypeScript 接口。

## 按改动场景找入口

| 你看到的需求或问题 | 先看这些路径 | 然后追到 | 典型文档与验证 |
| --- | --- | --- | --- |
| 任务树编辑、层级、搜索、快捷操作或拖拽 | `src/app/features/text/` | `src/services/task-*`、相关模型和规格 | [文本视图](../02-use-nanoflow/01-text-view.md)、相关规格测试 |
| Flow 节点、连线、图形导出或内存/加载问题 | `src/app/features/flow/` | Flow 服务、`src/config/layout.config.ts`、持久化/同步边界 | [流程图视图](../02-use-nanoflow/02-flow-view.md)、Flow 规格和性能检查 |
| Focus、Gate、Black Box、语音或每日审核 | `src/app/features/focus/` | `src/models/focus.ts`、`src/services/gate.service.ts`、`src/services/black-box*.ts` | [Focus 专注模式](../02-use-nanoflow/04-focus-mode.md)、[Black Box](../02-use-nanoflow/05-black-box.md) |
| 停泊、恢复、提醒或任务回流 | `src/app/features/parking/` | `src/services/dock-*.ts`、`src/models/parking-dock.ts` | [Parking Dock 停泊坞](../02-use-nanoflow/03-parking-dock.md) |
| 本地数据不见、刷新后不同步、待同步/死信或冲突 | `src/app/core/state/`、`src/app/core/services/sync/` | 同步协调服务、模型、会话与 Supabase 契约 | [离线优先模型](../03-data-sync-safety/01-offline-first-model.md)、[同步诊断与冲突中心](../03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md) |
| 登录、会话、权限或用户切换 | `src/app/core/shell/`、核心服务 | 会话管理、同步重试和用户级本地状态清理 | [启动、登录与状态提示](../01-get-started/05-startup-login-and-status.md)、相关服务规格 |
| 上传、附件、Storage 或文件清理 | 附件/同步服务与 `supabase/` | Storage、队列、任务存在性和恢复分支 | [附件与文件安全](../02-use-nanoflow/10-attachments-and-file-safety.md) |
| 数据库字段、RLS、RPC、表或索引 | `supabase/migrations/` | `src/types/supabase.ts`、调用服务、运维与安全文档 | [Supabase 运维](../04-deploy-operate/02-supabase-operations.md)、迁移审查与生成类型 |
| Edge Function、第三方服务或服务端秘密 | `supabase/functions/` | 前端调用方、函数环境、部署和错误边界 | [Edge Functions](../04-deploy-operate/03-edge-functions.md) |
| Android 小组件、通知、深链或宿主行为 | `android/` | 小组件数据来源、相关 Edge Function 与 Web 入口 | [Android 小组件](../02-use-nanoflow/07-android-widget.md) |
| 构建、启动、测试、文档或质量门禁 | `package.json`、`scripts/` | 调用脚本、契约测试、CI 约束和相关文档 | [测试与质量](03-testing-and-quality.md)、[文档维护](04-documentation-maintenance.md) |

## 数据从界面到云端的边界

下图不是某个单一方法的调用栈，而是改动任务数据时需要确认的所有权顺序：

```text
用户操作 / 页面组件
        |
        v
功能服务或任务操作服务
        |
        +--> 核心状态 store
        |          |
        |          v
        |      本地持久化
        |
        v
同步协调与队列
        |
        v
Supabase 行、RPC、Storage 或 Edge Function
```

每一层都可能失败，且失败后的动作不一定是“重试一次”。有的操作应保留本地证据，有的应进入重试队列，有的要因权限/会话改变而停止重放。修改其中任一层时，沿着前后层确认这些问题：

- 本地状态是否仍是立即可用的真相来源？
- 本地持久化与云端确认是否被错误地合并为同一个“成功”状态？
- 失败后会保留足够证据供恢复，还是会过早删除数据？
- 组件是否绕过服务直接写远端，导致队列、日志或权限恢复失效？
- 同一个变更是否会在另一台设备、用户切换或浏览器重启后出现不同结果？

## 后端、部署和 Android 边界

### Supabase

`supabase/migrations/` 是数据库结构、RLS、函数、索引和权限演进的入口；`supabase/functions/` 是 Deno Edge Function 的服务端行为。不要把服务角色密钥、第三方私钥或部署令牌放入前端 `NG_APP_*` 配置、源码、示例或浏览器可见构建产物。

修改迁移时，一起确认受影响的表、函数、权限和已有数据的回滚/备份策略。修改 schema 后，使用仓库提供的 `npm run db:types` 更新生成类型，并检查调用方、运维说明和 Context7 数据模型是否仍然一致。对不确定的 linked project、真实生产数据或云端密钥，不要运行 reset、push、deploy 或 secret-set 命令。

### 发布与环境

环境生成、构建、发布前验证和部署产物检查都在 `scripts/` 与 `package.json` 中以 npm 命令暴露。开发环境的缺失云配置可能允许本地离线模式继续，但不代表生产配置有效；生产前要使用对应的环境校验和构建路径。详细步骤在 [开发环境](01-development-environment.md) 和 [私有部署](../04-deploy-operate/01-private-deployment.md)。

### Android

`android/` 包含原生宿主和小组件实现。它可以共享数据协议和深链，但不是 Web 前端的自动副本。改小组件或宿主时，确认云端数据来源、登录/用户边界、网络失败退化和用户从 Android 跳回 Web 应用后的处理；只改 Kotlin 或只改 Web 往往不足以覆盖完整体验。

## 测试、脚本和文档边界

### 验证从哪里开始

| 改动类型 | 先运行 | 何时扩大 |
| --- | --- | --- |
| 只改 Markdown 手册 | `npm run docs:human:validate` | 改了覆盖路由时再跑聚焦 Vitest 和 `npm run docs:validate` |
| 用户可见功能 | 相关规格测试 | 共享组件/服务或跨端路径时加组件、服务或 E2E 分组 |
| 同步、离线、持久化或会话 | 定向服务/契约规格 | 触及共享协调、恢复或多设备语义时扩大到服务分组或本地矩阵 |
| 迁移或 Edge Function | 迁移审查、类型与相关契约 | 部署、RLS、Storage 或生产行为一起变时补运维验证 |
| 启动、Flow 加载、字体或发布产物 | 相关规格或构建步骤 | 必须运行 `npm run perf:guard` |
| 文档和行为一起变 | 对应功能的直接测试 | `npm run docs:human:guard`，并按需要跑 Context7 校验 |

不要用 `scripts/` 中一段手工命令替代已有 npm 脚本。脚本封装了环境准备、固定版本、顺序和额外产物校验；从 `package.json` 的命令开始，再追到具体脚本理解其边界。

### 哪些文档要更新

| 变化 | 必须检查的文档位置 |
| --- | --- |
| 使用者能看到的功能、状态、恢复或设备差异 | `docs/handbook/` 中对应专题文章，以及 `docs/handbook/change-coverage.json` |
| 源码所有权、模型字段、同步契约、API 或 Edge Function | `docs/context7/` 中对应参考页和检索路由 |
| 新增或移动手册文章 | `docs/handbook/catalog.json`、父级导航、相对链接和校验结果 |
| 开发命令、质量门禁、维护流程 | `docs/handbook/05-develop-maintain/` 与相关脚本/测试说明 |
| 过期计划或历史背景 | `docs/archive/`；不要让它取代当前 canonical 文档 |

“文档已经更新”的可验证含义是：目录清单能找到页面，页面有清楚的受众、源码依据、步骤、验收与下一步，链接能通过校验，而且实现变化的覆盖映射指向的正是读者需要的那一页。

## 高风险区域

下列区域变化时，不要只看局部编译是否通过。它们更容易影响数据完整性、跨设备一致性、安全或运行性能：

- `src/config/sync.config.ts`；
- `src/app/core/services/sync/`；
- `src/app/core/state/store-persistence.service.ts` 和持久化实现；
- `src/models/core-types.ts`、`src/models/focus.ts`、`src/models/parking-dock.ts`；
- `src/app/features/flow/`、`src/app/features/focus/`、`src/app/features/parking/`；
- `supabase/migrations/` 与 `supabase/functions/`；
- 启动壳、发布脚本、PWA 资源和 Android 小组件的数据入口。

遇到这些区域时，先从定向规格建立事实，再结合 [测试与质量](03-testing-and-quality.md) 的服务、契约、性能或端到端门禁扩大验证。若门禁仍红，应报告为未完成，而不是因为其他检查通过就忽略。

## 开始一个改动的阅读顺序

1. 从这页的场景表选出功能或基础设施入口。
2. 用 CodeGraph 确认当前符号、调用者、被调用者和影响面；再读被定位到的文件与相邻规格。
3. 对照 [Context7 源码地图](../../context7/source-map.md) 查清同步、模型、Edge Function 或 Agent 规则的精确契约。
4. 明确哪些中文手册和 Context7 页面会受影响；在实现同一工作项中更新它们。
5. 运行最窄的证明，再按高风险边界补充验证；保留实际命令和结果。

## 下一步

1. 准备本机环境时读 [开发环境](01-development-environment.md)。
2. 已找到改动位置后，用 [测试与质量](03-testing-and-quality.md) 选择第一条验证命令。
3. 涉及读者流程或源码契约时，按 [文档维护](04-documentation-maintenance.md) 更新并验证文档。
