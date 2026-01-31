# NanoFlow — Global Agent Instructions

> **映射源**: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
> 
> **重要**: 本项目使用 VS Code Copilot 官方工具名称，而非 Claude Code 工具名。

## 核心哲学（不要造轮子）
- 同步：Supabase
- ID：客户端 crypto.randomUUID()
- 离线：PWA + IndexedDB
- 监控：Sentry

---

## 可用 Agents

| Agent | 描述 | 触发方式 | 核心工具 |
|-------|------|----------|----------|
| `@planner` | 任务规划和分解 | `@planner`, `/plan` | readFile, codebase, textSearch |
| `@architect` | 系统架构设计 | `@architect`, `/design` | readFile, codebase, usages |
| `@implementation` | 按计划实现功能 | `@implementation`, `/implement` | editFiles, runInTerminal, runTests |
| `@tdd-guide` | 测试驱动开发 | `@tdd-guide`, `/tdd` | editFiles, runTests, testFailure |
| `@code-reviewer` | 代码审查 | `@code-reviewer`, `/code-review` | readFile, changes, problems |
| `@security-reviewer` | 安全漏洞检测 | `@security-reviewer`, `/security` | textSearch, runInTerminal |
| `@build-error-resolver` | 构建错误修复 | `@build-error-resolver`, `/build-fix` | editFiles, problems, runTests |
| `@e2e-runner` | E2E 测试 | `@e2e-runner`, `/e2e` | runInTerminal, playwright/* |
| `@refactor-cleaner` | 死代码清理 | `@refactor-cleaner`, `/refactor-clean` | editFiles, usages |
| `@doc-updater` | 文档更新 | `@doc-updater`, `/docs` | editFiles, codebase |
| `@database-reviewer` | 数据库审查 | `@database-reviewer` | runInTerminal, supabase/* |

## VS Code 工具别名参考

| VS Code 工具名 | Claude Code 等效 | 用途 |
|----------------|-----------------|------|
| `readFile` | `Read` | 读取文件 |
| `editFiles` | `Edit`, `Write` | 编辑文件 |
| `createFile` | `Write` | 创建文件 |
| `textSearch` | `Grep` | 文本搜索 |
| `fileSearch` | `Glob` | 文件名搜索 |
| `codebase` | `semantic_search` | 语义搜索 |
| `runInTerminal` | `Bash` | 终端命令 |
| `listDirectory` | `LS` | 目录列表 |
| `changes` | `git diff` | 变更列表 |
| `problems` | `get_errors` | 编译问题 |
| `usages` | N/A | 引用查找 |
| `runTests` | N/A | 运行测试 |
| `fetch` | `WebFetch` | 网页获取 |
| `mcp-name/*` | MCP 工具 | MCP 服务器工具 |

## 可用 Commands

| Command | 描述 |
|---------|------|
| `/plan` | 规划任务 |
| `/tdd` | TDD 循环 |
| `/code-review` | 代码审查 |
| `/build-fix` | 修复构建错误 |
| `/e2e` | 运行 E2E 测试 |
| `/refactor-clean` | 清理死代码 |
| `/security` | 安全审计 |
| `/docs` | 更新文档 |
| `/verify` | 验证实现 |
| `/implement` | 实现功能 |
| `/design` | 设计架构 |
| `/orchestrate` | 协调多 agent |
| `/checkpoint` | 保存检查点 |

---

## 绝对规则（Hard Rules）
1) **ID 策略**
- 所有实体 id 必须由客户端 `crypto.randomUUID()` 生成
- 禁止：数据库自增 ID、临时 ID、同步时做 ID 转换

2) **数据流与同步（Offline-first）**
- 读：IndexedDB → 后台增量拉取（updated_at > last_sync_time）
- 写：本地写入 + UI 立即更新 → 后台推送（防抖 3s）→ 失败进入 RetryQueue
- 冲突：LWW（Last-Write-Wins）
- 目标体验：点击立即生效、无 loading 转圈；断网写入不丢，联网自动补同步

3) **移动端 GoJS**
- 手机默认 Text 视图；Flow 图按需懒加载（@defer）
- 禁止 `visibility:hidden`：必须完全销毁/重建 GoJS

4) **树遍历**
- 一律用迭代算法 + 深度限制（MAX_SUBTREE_DEPTH = 100）

## 状态管理（Angular Signals）
- tasksMap: Map<string, Task>（O(1) 查找）
- tasksByProject: Map<string, Set<string>>（按项目索引）
- 保持扁平，避免深层嵌套结构

## 错误处理（Result Pattern + Sentry）
- 用 Result 类型，避免 try/catch 地狱
- 网络错误：静默（入队重试）
- 业务错误：Toast
- Supabase 错误统一转换：supabaseErrorToError(error)

## 全局错误分级（GlobalErrorHandler）
- SILENT：仅日志（例：ResizeObserver）
- NOTIFY：Toast（例：保存失败）
- RECOVERABLE：恢复对话框（例：同步冲突）
- FATAL：错误页（例：Store 初始化失败）

## 目录结构（必须遵守）
- src/app/core/：核心单例（SimpleSyncService, stores.ts）
  - src/app/core/shell/：应用容器组件（ProjectShellComponent）
- src/app/features/：业务组件
  - src/app/features/flow/components/：Flow 视图组件
  - src/app/features/flow/services/：Flow 相关服务（GoJS、缩放、导出等）
  - src/app/features/text/components/：Text 视图组件
  - src/app/features/text/services/：Text 相关服务
- src/app/shared/：共享资源
  - src/app/shared/components/：通用 UI 组件
  - src/app/shared/modals/：模态框组件（含 base-modal.component.ts 基类）
- src/services/：主服务层（核心业务逻辑）
- src/config/：配置常量（按职责拆分）
- src/utils/：工具函数（result.ts, supabase-error.ts）
- src/tests/integration/：集成测试文件
- scripts/legacy/：历史脚本（已被 init-supabase.sql 取代）

## 关键配置（保持一致，不随意改语义）
- SYNC_CONFIG.DEBOUNCE_DELAY = 3000ms
- SYNC_CONFIG.CLOUD_LOAD_TIMEOUT = 30000ms
- REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT = 4
- TIMEOUT_CONFIG.STANDARD = 10000ms
- FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100
- AUTH_CONFIG.LOCAL_MODE_USER_ID = 'local-user'
---

## 目录结构

```
src/
├── app/
│   ├── core/                      # 核心单例
│   │   ├── services/
│   │   │   ├── simple-sync.service.ts     # 同步核心（LWW + RetryQueue）
│   │   │   └── modal-loader.service.ts    # 模态框懒加载
│   │   └── state/
│   │       ├── stores.ts                  # Signals 状态（Map<id, Task>）
│   │       ├── focus-stores.ts            # 专注模式状态（Gate/Spotlight/Strata/BlackBox）
│   │       └── store-persistence.service.ts
│   │
│   ├── shell/                     # 应用容器
│   │   └── project-shell.component.ts   # 项目容器/视图切换
│   │
│   ├── features/
│   │   ├── flow/                  # 流程图视图
│   │   │   ├── components/        # 11 组件
│   │   │   │   ├── flow-view.component.ts
│   │   │   │   ├── flow-toolbar.component.ts
│   │   │   │   ├── flow-palette.component.ts
│   │   │   │   ├── flow-task-detail.component.ts
│   │   │   │   ├── flow-connection-editor.component.ts
│   │   │   │   └── flow-*-dialog.component.ts    # 批量删除/级联分配/删除确认/链接
│   │   │   └── services/          # 16 GoJS 服务
│   │   │       ├── flow-diagram.service.ts        # 图表核心
│   │   │       ├── flow-template.service.ts       # 节点/链接模板
│   │   │       ├── flow-template-events.ts        # 事件代理（解耦）
│   │   │       ├── flow-event.service.ts
│   │   │       ├── flow-task-operations.service.ts
│   │   │       ├── flow-selection.service.ts
│   │   │       ├── flow-drag-drop.service.ts
│   │   │       ├── flow-link.service.ts
│   │   │       ├── flow-layout.service.ts
│   │   │       ├── flow-zoom.service.ts
│   │   │       ├── flow-touch.service.ts
│   │   │       ├── flow-command.service.ts        # 快捷键命令
│   │   │       ├── minimap-math.service.ts        # 小地图数学
│   │   │       └── reactive-minimap.service.ts    # 响应式小地图
│   │   │
│   │   ├── text/                  # 文本视图（移动端默认）
│   │   │   ├── components/        # 12 组件
│   │   │   │   ├── text-view.component.ts
│   │   │   │   ├── text-stages.component.ts
│   │   │   │   ├── text-stage-card.component.ts
│   │   │   │   ├── text-task-card.component.ts
│   │   │   │   ├── text-task-editor.component.ts
│   │   │   │   ├── text-task-connections.component.ts
│   │   │   │   ├── text-unassigned.component.ts
│   │   │   │   └── text-unfinished.component.ts
│   │   │   └── services/          # Text 相关服务
│   │   │       └── text-view-drag-drop.service.ts
│   │   │
│   │   └── focus/                 # 🆕 专注模式
│   │       ├── focus-mode.component.ts      # 专注模式入口
│   │       ├── focus.animations.css         # 动画样式（521 行）
│   │       └── components/
│   │           ├── gate/                    # 大门模块
│   │           │   ├── gate-overlay.component.ts    # 全屏遮罩 + 键盘快捷键
│   │           │   ├── gate-card.component.ts       # 条目卡片
│   │           │   └── gate-actions.component.ts    # 操作按钮组
│   │           ├── spotlight/               # 聚光灯模块
│   │           │   ├── spotlight-view.component.ts  # 聚光灯视图
│   │           │   ├── spotlight-card.component.ts  # 任务卡片
│   │           │   └── spotlight-trigger.component.ts
│   │           ├── strata/                  # 地质层模块
│   │           │   ├── strata-view.component.ts     # 地质层视图
│   │           │   ├── strata-layer.component.ts    # 单日层
│   │           │   └── strata-item.component.ts     # 单个条目
│   │           └── black-box/               # 黑匣子模块
│   │               ├── black-box-panel.component.ts     # 面板
│   │               ├── black-box-recorder.component.ts  # 录音按钮
│   │               ├── black-box-entry.component.ts     # 条目
│   │               ├── black-box-text-input.component.ts
│   │               ├── black-box-trigger.component.ts
│   │               └── black-box-date-group.component.ts
│   │
│   └── shared/
│       ├── components/            # 8 通用组件（含 index.ts barrel）
│       │   └── attachment-manager | error-boundary | error-page | not-found
│       │       offline-banner | reset-password | sync-status | toast-container
│       └── modals/                # 13 模态框 + base-modal.component.ts 基类
│           └── login | settings | new-project | dashboard | trash | delete-confirm
│               conflict | error-recovery | migration | config-help | storage-escape | recovery
│
├── services/                      # 主服务层（70+ 服务）
│   ├── store.service.ts           # 门面 Facade ※ 禁止业务逻辑
│   │
│   ├── # 业务服务
│   ├── task-operation.service.ts           # 任务 CRUD
│   ├── task-operation-adapter.service.ts   # 任务操作 + 撤销协调
│   ├── task-repository.service.ts          # 任务持久化
│   ├── task-trash.service.ts               # 回收站
│   ├── project-operation.service.ts        # 项目 CRUD
│   ├── attachment.service.ts               # 附件管理
│   ├── attachment-export.service.ts        # 附件导出
│   ├── attachment-import.service.ts        # 附件导入
│   ├── export.service.ts / import.service.ts
│   ├── search.service.ts
│   ├── layout.service.ts
│   ├── lineage-color.service.ts
│   │
│   ├── # 🆕 专注模式服务
│   ├── gate.service.ts                 # 大门逻辑
│   ├── spotlight.service.ts            # 聚光灯逻辑
│   ├── strata.service.ts               # 地质层逻辑
│   ├── black-box.service.ts            # 黑匣子 CRUD
│   ├── black-box-sync.service.ts       # 黑匣子同步
│   ├── speech-to-text.service.ts       # 语音转写（调用 Edge Function）
│   ├── focus-preference.service.ts     # 专注模式偏好
│   │
│   ├── # 状态服务
│   ├── project-state.service.ts    # 项目/任务状态
│   ├── ui-state.service.ts         # UI 状态
│   ├── optimistic-state.service.ts # 乐观更新
│   ├── undo.service.ts             # 撤销/重做
│   │
│   ├── # 同步服务
│   ├── sync-coordinator.service.ts    # 同步调度
│   ├── sync-mode.service.ts           # 模式管理
│   ├── mobile-sync-strategy.service.ts
│   ├── remote-change-handler.service.ts
│   ├── conflict-resolution.service.ts
│   ├── conflict-storage.service.ts
│   ├── change-tracker.service.ts
│   ├── action-queue.service.ts
│   ├── request-throttle.service.ts
│   ├── tab-sync.service.ts
│   ├── clock-sync.service.ts
│   │
│   ├── # 网络/健康
│   ├── network-awareness.service.ts
│   ├── circuit-breaker.service.ts
│   ├── offline-integrity.service.ts
│   │
│   ├── # 基础设施
│   ├── auth.service.ts
│   ├── user-session.service.ts
│   ├── supabase-client.service.ts
│   ├── preference.service.ts
│   ├── local-backup.service.ts
│   ├── migration.service.ts
│   ├── toast.service.ts
│   ├── logger.service.ts
│   ├── theme.service.ts           # 主题管理（色调 + 颜色模式/深色模式）
│   ├── global-error-handler.service.ts
│   ├── sentry-alert.service.ts
│   ├── permission-denied-handler.service.ts
│   ├── before-unload-manager.service.ts
│   ├── file-type-validator.service.ts
│   ├── virus-scan.service.ts
│   │
│   └── guards/
│       ├── auth.guard.ts
│       ├── project.guard.ts
│       └── unsaved-changes.guard.ts
│
├── config/                        # 配置常量
│   ├── sync.config.ts             # SYNC_CONFIG, CIRCUIT_BREAKER_CONFIG
│   ├── layout.config.ts           # LAYOUT_CONFIG, FLOATING_TREE_CONFIG, GOJS_CONFIG
│   ├── timeout.config.ts          # TIMEOUT_CONFIG, RETRY_POLICY
│   ├── auth.config.ts             # AUTH_CONFIG, GUARD_CONFIG
│   ├── focus.config.ts            # 🆕 FOCUS_CONFIG（配额、跳过限制等）
│   ├── ui.config.ts
│   ├── task.config.ts
│   ├── attachment.config.ts
│   ├── local-backup.config.ts
│   ├── sentry-alert.config.ts
│   ├── virus-scan.config.ts
│   ├── feature-flags.config.ts
│   └── flow-styles.ts             # GoJS 颜色配置（支持浅色/深色模式）
│
├── models/
│   ├── index.ts                   # Task, Project, Connection, Attachment, ColorMode
│   ├── focus.ts                   # BlackBoxEntry, StrataItem, GateState, FocusPreferences
│   ├── supabase-types.ts          # 数据库类型定义
│   ├── flow-view-state.ts
│   └── gojs-boundary.ts           # GoJS 边界类型
│
├── utils/
│   ├── result.ts                  # Result<T,E> + ErrorCodes
│   ├── supabase-error.ts          # supabaseErrorToError()
│   ├── permanent-failure-error.ts
│   ├── validation.ts
│   ├── date.ts
│   ├── timeout.ts
│   └── markdown.ts
│
├── types/
│   └── gojs-extended.d.ts
│
└── environments/
    ├── environment.ts             # 生产（自动生成）
    └── environment.development.ts # 开发（自动生成）

supabase/
├── functions/
│   └── transcribe/                # 🆕 语音转写 Edge Function
│       └── index.ts               # Groq whisper-large-v3 代理
└── migrations/
    └── 20260123000000_focus_mode.sql  # 🆕 专注模式数据库迁移
```

---

## 服务架构

```
StoreService (门面) ※ 禁止业务逻辑，透传子服务
    ├── UserSessionService           # 登录/登出、项目切换
    ├── TaskOperationAdapterService  # 任务 CRUD + 撤销协调
    ├── ProjectStateService          # 项目/任务状态读取
    ├── UiStateService               # UI 状态
    ├── SyncCoordinatorService       # 同步调度
    ├── SearchService                # 搜索
    └── PreferenceService            # 用户偏好

GoJS 事件解耦：
FlowTemplateService → flow-template-events.ts → FlowEventService
```

**⚠️ 新代码禁止 `inject(StoreService)`，直接注入子服务**

---

## 关键配置

| 配置 | 值 | 文件 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | sync.config.ts |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | sync.config.ts |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.QUICK` | 5000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.HEAVY` | 30000ms | timeout.config.ts |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | 100 | layout.config.ts |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | auth.config.ts |
| `FOCUS_CONFIG.DAILY_TRANSCRIPTION_LIMIT` | 50 | focus.config.ts |
| `FOCUS_CONFIG.MAX_SNOOZE_PER_DAY` | 3 | focus.config.ts |

---

## 数据模型

```typescript
interface Task {
  id: string;                    // UUID 客户端生成
  title: string;
  content: string;               // Markdown
  stage: number | null;          // null = 待分配区
  parentId: string | null;
  order: number;
  rank: number;
  status: 'active' | 'completed' | 'archived';
  x: number; y: number;          // 流程图坐标
  displayId: string;             // 动态 "1,a"
  shortId?: string;              // 永久 "NF-A1B2"
  updatedAt?: string;            // LWW 关键
  deletedAt?: string | null;     // 软删除
  attachments?: Attachment[];
  tags?: string[];               // 预留
  priority?: 'low' | 'medium' | 'high' | 'urgent';  // 预留
  dueDate?: string | null;       // 预留
  // 客户端临时
  deletedConnections?: Connection[];
  deletedMeta?: { parentId, stage, order, rank, x, y };
}

interface Connection {
  id: string; source: string; target: string;
  title?: string; description?: string;
  deletedAt?: string | null;
}

// 🆕 专注模式数据模型
interface BlackBoxEntry {
  id: string;                    // UUID 客户端生成
  projectId?: string;
  userId: string;
  content: string;               // 语音转写文本
  date: string;                  // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isCompleted: boolean;
  isArchived: boolean;
  snoozeUntil?: string;          // 跳过至该日期
  snoozeCount?: number;
  deletedAt?: string | null;
}

interface FocusPreferences {
  gateEnabled: boolean;          // 是否启用大门（默认 true）
  spotlightEnabled: boolean;     // 是否启用聚光灯
  blackBoxEnabled: boolean;      // 是否启用黑匣子
  maxSnoozePerDay: number;       // 每日最大跳过次数（默认 3）
}
```

---

## 错误处理

```typescript
// Result 模式
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
success(data);
failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');

// Supabase 错误转换
supabaseErrorToError(error)
```

### 错误分级 (GlobalErrorHandler)

| 级别 | 处理 | 示例 |
|------|------|------|
| SILENT | 仅日志 | ResizeObserver |
| NOTIFY | Toast | 保存失败 |
| RECOVERABLE | 恢复对话框 | 同步冲突 |
| FATAL | 错误页面 | Store 初始化失败 |

---

## 开发命令

```bash
npm start               # 开发服务器
npm run test            # Vitest watch
npm run test:run        # 单次测试
npm run test:e2e        # Playwright E2E
npm run lint:fix        # ESLint 修复
npx knip                # 检测未使用代码
```

---

## 代码规范

- 中文注释描述业务逻辑
- Angular Signals 状态管理
- `standalone: true` + `OnPush`
- 严格类型，`unknown` + 类型守卫替代 `any`
- 测试同目录：`*.service.ts` → `*.service.spec.ts`

---

## 常见陷阱

| 陷阱 | 方案 |
|------|------|
| 全量同步 | 增量 `updated_at > last_sync_time` |
| GoJS 内存泄漏 | `diagram.clear()` + 移除监听 |
| 递归栈溢出 | 迭代 + `MAX_SUBTREE_DEPTH: 100` |
| 离线数据丢失 | 失败进 RetryQueue |
| Sentry 错误丢失 | `supabaseErrorToError()` |
| Edge Function API Key 泄露 | 使用 `supabase secrets set`，禁止硬编码 |
| iOS Safari 录音不支持 webm | 动态检测 mimeType，回退到 mp4 |

---

## 专注模式架构

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Angular 前端    │     │  Supabase Edge Function  │     │    Groq API     │
│  ─────────────  │ ──► │  ──────────────────────  │ ──► │  ─────────────  │
│  采集麦克风数据   │     │  持有 GROQ_API_KEY       │     │  whisper-large  │
│  打包成 Blob     │     │  接收 Blob，转发给 Groq   │     │  -v3 转写       │
└─────────────────┘     └──────────────────────────┘     └─────────────────┘
```

**三明治架构优势**：
- ✅ **安全**：API Key 永不暴露在前端
- ✅ **极速**：Groq 转写响应通常 1-2 秒
- ✅ **配额控制**：Edge Function 检查每用户每日 50 次限额

---

## 认证

- 强制登录，数据操作需 `user_id`
- 开发：`environment.devAutoLogin` 自动登录
- 离线模式：`LOCAL_MODE_USER_ID = 'local-user'`

