# NanoFlow — Global Agent Instructions

> **最后更新**: 2026-02-02
> 
> **重要**: 本项目使用 VS Code Copilot 官方工具名称。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.2.x | Signals + 独立组件 + OnPush |
| Supabase | 2.84+ | 认证 + PostgreSQL + Storage + Edge Functions |
| GoJS | 3.1.x | 流程图渲染 |
| Groq | whisper-large-v3 | 语音转写（Edge Function 代理） |
| Sentry | 10.32+ | 错误监控 + 会话回放 |
| Vitest | 4.0.x | 单元测试 |
| Playwright | 1.48+ | E2E 测试 |
| TypeScript | 5.8.x | 类型安全 |

---

## 核心哲学（不要造轮子）

- **同步**：Supabase + LWW（Last-Write-Wins）
- **ID**：客户端 `crypto.randomUUID()`
- **离线**：PWA + IndexedDB（idb-keyval）
- **监控**：Sentry（懒加载）
- **状态**：Angular Signals（非 RxJS Store）

---

## 绝对规则（Hard Rules）

### 1. ID 策略
- 所有实体 ID 必须由客户端 `crypto.randomUUID()` 生成
- **禁止**：数据库自增 ID、临时 ID、同步时做 ID 转换

### 2. 数据流与同步（Offline-first）
```
读：IndexedDB → 后台增量拉取（updated_at > last_sync_time）
写：本地写入 + UI 立即更新 → 后台推送（防抖 3s）→ 失败进入 RetryQueue
冲突：LWW（Last-Write-Wins）
```
- **目标体验**：点击立即生效、无 loading 转圈；断网写入不丢，联网自动补同步

### 3. 移动端 GoJS
- 手机默认 Text 视图；Flow 图按需懒加载（`@defer`）
- **禁止** `visibility:hidden`：必须完全销毁/重建 GoJS

### 4. 树遍历
- 一律用迭代算法 + 深度限制（`MAX_SUBTREE_DEPTH = 100`）

### 5. 服务注入规则
- **禁止** `inject(StoreService)`，直接注入具体子服务
- StoreService 已废弃，仅保留兼容性 API

---

## 状态管理（Angular Signals）

```typescript
// src/app/core/state/stores.ts
tasksMap: Map<string, Task>          // O(1) 查找
tasksByProject: Map<string, Set<string>>  // 按项目索引
connectionsMap: Map<string, Connection>   // 连接索引
```

- 保持扁平，避免深层嵌套结构
- 使用 `signal()`, `computed()`, `effect()` 进行响应式更新

---

## 错误处理（Result Pattern + Sentry）

```typescript
// src/utils/result.ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
success(data);
failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');

// src/utils/supabase-error.ts
supabaseErrorToError(error)  // 统一转换 Supabase 错误
```

### 错误分级（GlobalErrorHandler）

| 级别 | 处理 | 示例 |
|------|------|------|
| SILENT | 仅日志 | ResizeObserver |
| NOTIFY | Toast | 保存失败 |
| RECOVERABLE | 恢复对话框 | 同步冲突 |
| FATAL | 错误页面 | Store 初始化失败 |

---

## 关键配置

| 配置 | 值 | 文件 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | sync.config.ts |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | 30000ms | sync.config.ts |
| `SYNC_CONFIG.POLLING_INTERVAL` | 300000ms (5min) | sync.config.ts |
| `SYNC_CONFIG.POLLING_ACTIVE_INTERVAL` | 60000ms | sync.config.ts |
| `SYNC_CONFIG.REALTIME_ENABLED` | false | sync.config.ts |
| `TIMEOUT_CONFIG.QUICK` | 5000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.HEAVY` | 30000ms | timeout.config.ts |
| `TIMEOUT_CONFIG.UPLOAD` | 60000ms | timeout.config.ts |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | 100 | layout.config.ts |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | auth.config.ts |
| `GUARD_CONFIG.SESSION_CHECK_TIMEOUT` | 2000ms | auth.config.ts |
| `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY` | 3 | focus.config.ts |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA` | 50 | focus.config.ts |
---

## 目录结构

```
src/
├── app/
│   ├── core/                      # 核心单例
│   │   ├── services/
│   │   │   ├── simple-sync.service.ts     # 同步核心（LWW + RetryQueue）
│   │   │   ├── modal-loader.service.ts    # 模态框懒加载
│   │   │   └── sync/                      # 同步子服务（模块化拆分）
│   │   │       ├── batch-sync.service.ts
│   │   │       ├── connection-sync-operations.service.ts
│   │   │       ├── project-data.service.ts
│   │   │       ├── realtime-polling.service.ts
│   │   │       ├── retry-queue.service.ts
│   │   │       ├── session-manager.service.ts
│   │   │       ├── sync-operation-helper.service.ts
│   │   │       ├── sync-state.service.ts
│   │   │       ├── task-sync-operations.service.ts
│   │   │       ├── tombstone.service.ts
│   │   │       └── user-preferences-sync.service.ts
│   │   ├── state/
│   │   │   ├── stores.ts                  # Signals 状态（Map<id, Task>）
│   │   │   ├── focus-stores.ts            # 专注模式状态
│   │   │   ├── store-persistence.service.ts
│   │   │   └── persistence/               # 持久化子服务
│   │   │       ├── backup.service.ts
│   │   │       ├── data-integrity.service.ts
│   │   │       ├── delta-sync-persistence.service.ts
│   │   │       └── indexeddb.service.ts
│   │   └── shell/
│   │       └── project-shell.component.ts   # 项目容器/视图切换
│   │
│   ├── features/
│   │   ├── flow/                  # 流程图视图
│   │   │   ├── components/        # 21 组件
│   │   │   │   ├── flow-view.component.ts
│   │   │   │   ├── flow-toolbar.component.ts
│   │   │   │   ├── flow-palette.component.ts
│   │   │   │   ├── flow-right-panel.component.ts
│   │   │   │   ├── flow-task-detail.component.ts
│   │   │   │   ├── flow-connection-editor.component.ts
│   │   │   │   ├── flow-batch-delete-dialog.component.ts
│   │   │   │   ├── flow-batch-toolbar.component.ts
│   │   │   │   ├── flow-cascade-assign-dialog.component.ts
│   │   │   │   ├── flow-delete-confirm.component.ts
│   │   │   │   ├── flow-link-delete-hint.component.ts
│   │   │   │   ├── flow-link-type-dialog.component.ts
│   │   │   │   ├── mobile-drawer-container.component.ts
│   │   │   │   ├── mobile-black-box-drawer.component.ts
│   │   │   │   └── mobile-todo-drawer.component.ts
│   │   │   ├── services/          # 31 GoJS 服务
│   │   │   │   ├── flow-diagram.service.ts        # 图表核心
│   │   │   │   ├── flow-diagram-config.service.ts
│   │   │   │   ├── flow-diagram-effects.service.ts
│   │   │   │   ├── flow-diagram-retry.service.ts
│   │   │   │   ├── flow-template.service.ts       # 节点/链接模板
│   │   │   │   ├── flow-template-events.ts        # 事件代理（解耦）
│   │   │   │   ├── flow-event.service.ts
│   │   │   │   ├── flow-event-registration.service.ts
│   │   │   │   ├── flow-task-operations.service.ts
│   │   │   │   ├── flow-selection.service.ts
│   │   │   │   ├── flow-select-mode.service.ts
│   │   │   │   ├── flow-drag-drop.service.ts
│   │   │   │   ├── flow-link.service.ts
│   │   │   │   ├── flow-layout.service.ts
│   │   │   │   ├── flow-zoom.service.ts
│   │   │   │   ├── flow-touch.service.ts
│   │   │   │   ├── flow-swipe-gesture.service.ts
│   │   │   │   ├── flow-command.service.ts        # 快捷键命令
│   │   │   │   ├── flow-keyboard.service.ts
│   │   │   │   ├── flow-batch-delete.service.ts
│   │   │   │   ├── flow-cascade-assign.service.ts
│   │   │   │   ├── flow-mobile-drawer.service.ts
│   │   │   │   ├── flow-overview.service.ts
│   │   │   │   ├── flow-palette-resize.service.ts
│   │   │   │   ├── flow-view-cleanup.service.ts
│   │   │   │   ├── minimap-math.service.ts
│   │   │   │   ├── reactive-minimap.service.ts
│   │   │   │   └── mobile-drawer-gesture.service.ts
│   │   │   └── types/
│   │   │       └── flow-template.types.ts
│   │   │
│   │   ├── text/                  # 文本视图（移动端默认）
│   │   │   ├── components/        # 11 组件
│   │   │   │   ├── text-view.component.ts
│   │   │   │   ├── text-view-loading.component.ts
│   │   │   │   ├── text-stages.component.ts
│   │   │   │   ├── text-stage-card.component.ts
│   │   │   │   ├── text-task-card.component.ts
│   │   │   │   ├── text-task-editor.component.ts
│   │   │   │   ├── text-task-connections.component.ts
│   │   │   │   ├── text-unassigned.component.ts
│   │   │   │   ├── text-unfinished.component.ts
│   │   │   │   └── text-delete-dialog.component.ts
│   │   │   └── services/
│   │   │       └── text-view-drag-drop.service.ts
│   │   │
│   │   └── focus/                 # 专注模式
│   │       ├── focus-mode.component.ts      # 专注模式入口
│   │       ├── focus.animations.css         # 动画样式
│   │       └── components/
│   │           ├── gate/                    # 大门模块
│   │           │   ├── gate-overlay.component.ts
│   │           │   ├── gate-card.component.ts
│   │           │   └── gate-actions.component.ts
│   │           ├── spotlight/               # 聚光灯模块
│   │           │   ├── spotlight-view.component.ts
│   │           │   ├── spotlight-card.component.ts
│   │           │   └── spotlight-trigger.component.ts
│   │           ├── strata/                  # 地质层模块
│   │           │   ├── strata-view.component.ts
│   │           │   ├── strata-layer.component.ts
│   │           │   └── strata-item.component.ts
│   │           └── black-box/               # 黑匣子模块
│   │               ├── black-box-panel.component.ts
│   │               ├── black-box-recorder.component.ts
│   │               ├── black-box-entry.component.ts
│   │               ├── black-box-text-input.component.ts
│   │               └── black-box-date-group.component.ts
│   │
│   └── shared/
│       ├── components/            # 8 通用组件
│       │   ├── demo-banner.component.ts
│       │   ├── error-boundary.component.ts
│       │   ├── error-page.component.ts
│       │   ├── not-found.component.ts
│       │   ├── offline-banner.component.ts
│       │   ├── reset-password.component.ts
│       │   ├── sync-status.component.ts
│       │   └── toast-container.component.ts
│       └── modals/                # 13 模态框
│           ├── base-modal.component.ts      # 基类
│           ├── login-modal.component.ts
│           ├── settings-modal.component.ts
│           ├── new-project-modal.component.ts
│           ├── dashboard-modal.component.ts
│           ├── trash-modal.component.ts
│           ├── delete-confirm-modal.component.ts
│           ├── conflict-modal.component.ts
│           ├── error-recovery-modal.component.ts
│           ├── migration-modal.component.ts
│           ├── config-help-modal.component.ts
│           └── storage-escape-modal.component.ts
│
├── services/                      # 主服务层（90+ 文件）
│   │
│   ├── # 任务操作
│   ├── task-operation.service.ts           # 任务 CRUD 核心
│   ├── task-operation-adapter.service.ts   # 任务操作 + 撤销协调
│   ├── task-repository.service.ts          # 任务持久化
│   ├── task-trash.service.ts               # 回收站
│   ├── task-creation.service.ts            # 任务创建
│   ├── task-move.service.ts                # 任务移动
│   ├── task-attribute.service.ts           # 任务属性
│   ├── task-connection.service.ts          # 任务连接
│   ├── subtree-operations.service.ts       # 子树操作
│   │
│   ├── # 项目操作
│   ├── project-operation.service.ts        # 项目 CRUD
│   ├── project-state.service.ts            # 项目/任务状态
│   ├── project-sync-operations.service.ts  # 项目同步操作
│   │
│   ├── # 附件
│   ├── attachment.service.ts               # 附件管理
│   ├── attachment-export.service.ts
│   ├── attachment-import.service.ts
│   │
│   ├── # 导入导出
│   ├── export.service.ts
│   ├── import.service.ts
│   │
│   ├── # 专注模式
│   ├── gate.service.ts                     # 大门逻辑
│   ├── spotlight.service.ts                # 聚光灯逻辑
│   ├── strata.service.ts                   # 地质层逻辑
│   ├── black-box.service.ts                # 黑匣子 CRUD
│   ├── black-box-sync.service.ts           # 黑匣子同步
│   ├── speech-to-text.service.ts           # 语音转写
│   ├── focus-preference.service.ts         # 专注模式偏好
│   │
│   ├── # 状态管理
│   ├── ui-state.service.ts                 # UI 状态
│   ├── optimistic-state.service.ts         # 乐观更新
│   ├── undo.service.ts                     # 撤销/重做
│   │
│   ├── # 同步服务
│   ├── sync-coordinator.service.ts         # 同步调度
│   ├── sync-mode.service.ts                # 模式管理
│   ├── delta-sync-coordinator.service.ts   # 增量同步
│   ├── mobile-sync-strategy.service.ts
│   ├── remote-change-handler.service.ts
│   ├── conflict-resolution.service.ts
│   ├── conflict-storage.service.ts
│   ├── change-tracker.service.ts
│   ├── action-queue.service.ts
│   ├── action-queue-processors.service.ts
│   ├── request-throttle.service.ts
│   ├── tab-sync.service.ts
│   ├── clock-sync.service.ts
│   ├── connection-adapter.service.ts
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
│   ├── theme.service.ts
│   ├── global-error-handler.service.ts
│   ├── sentry-alert.service.ts
│   ├── sentry-lazy-loader.service.ts
│   ├── permission-denied-handler.service.ts
│   ├── before-unload-manager.service.ts
│   ├── file-type-validator.service.ts
│   ├── virus-scan.service.ts
│   ├── web-vitals.service.ts
│   ├── persist-scheduler.service.ts
│   │
│   ├── # 杂项
│   ├── search.service.ts
│   ├── layout.service.ts
│   ├── lineage-color.service.ts
│   ├── event-bus.service.ts
│   ├── modal.service.ts
│   ├── dynamic-modal.service.ts
│   │
│   └── guards/
│       ├── auth.guard.ts
│       ├── project.guard.ts
│       └── unsaved-changes.guard.ts
│
├── config/                        # 配置常量（16 文件）
│   ├── index.ts                   # Barrel 导出
│   ├── sync.config.ts             # SYNC_CONFIG, CIRCUIT_BREAKER_CONFIG, CLOCK_SYNC_CONFIG, MOBILE_SYNC_CONFIG
│   ├── layout.config.ts           # LAYOUT_CONFIG, FLOATING_TREE_CONFIG, GOJS_CONFIG
│   ├── timeout.config.ts          # TIMEOUT_CONFIG, RETRY_POLICY
│   ├── auth.config.ts             # AUTH_CONFIG, GUARD_CONFIG
│   ├── focus.config.ts            # FOCUS_CONFIG
│   ├── ui.config.ts
│   ├── task.config.ts
│   ├── attachment.config.ts
│   ├── drawer.config.ts
│   ├── local-backup.config.ts
│   ├── sentry-alert.config.ts
│   ├── virus-scan.config.ts
│   ├── feature-flags.config.ts
│   ├── performance.config.ts
│   └── flow-styles.ts             # GoJS 颜色配置
│
├── models/                        # 数据模型
│   ├── index.ts                   # Task, Project, Connection, Attachment, ColorMode
│   ├── core-types.ts              # 核心类型
│   ├── focus.ts                   # BlackBoxEntry, StrataItem, GateState, FocusPreferences
│   ├── supabase-types.ts          # 数据库类型定义
│   ├── flow-view-state.ts
│   └── gojs-boundary.ts           # GoJS 边界类型
│
├── utils/                         # 工具函数
│   ├── result.ts                  # Result<T,E> + ErrorCodes
│   ├── supabase-error.ts          # supabaseErrorToError()
│   ├── permanent-failure-error.ts
│   ├── validation.ts
│   ├── date.ts
│   ├── gesture.ts
│   ├── timeout.ts
│   ├── markdown.ts
│   └── standalone-logger.ts
│
├── types/
│   ├── gojs-extended.d.ts
│   └── supabase.ts                # 自动生成：npm run db:types
│
├── tests/                         # 测试相关
│   └── integration/
│
└── environments/
    ├── environment.ts             # 生产（自动生成）
    └── environment.development.ts # 开发（自动生成）

supabase/
├── functions/                     # Edge Functions
│   ├── _shared/                   # 共享工具
│   ├── transcribe/                # 语音转写（Groq whisper-large-v3）
│   ├── backup-alert/              # 备份告警
│   ├── backup-attachments/        # 附件备份
│   ├── backup-cleanup/            # 备份清理
│   ├── backup-full/               # 全量备份
│   ├── backup-incremental/        # 增量备份
│   ├── backup-restore/            # 备份恢复
│   ├── cleanup-attachments/       # 附件清理
│   └── virus-scan/                # 病毒扫描
└── migrations/                    # 数据库迁移
    ├── 20260126000000_database_optimization.sql
    ├── 20260126074130_remote_commit.sql
    ├── 20260126100000_batch_load_optimization.sql
    ├── 20260202_performance_rpc_functions.sql
    └── archive/
```

---

## 服务架构

### 核心服务依赖图

```
┌─────────────────────────────────────────────────────────────────┐
│                        SimpleSyncService                         │
│  （同步核心：LWW + RetryQueue + 增量拉取）                        │
├─────────────────────────────────────────────────────────────────┤
│  sync/                                                           │
│  ├── SessionManagerService      # 会话管理                       │
│  ├── SyncStateService           # 同步状态                       │
│  ├── SyncOperationHelperService # 操作辅助                       │
│  ├── TaskSyncOperationsService  # 任务同步                       │
│  ├── ConnectionSyncOperationsService  # 连接同步                 │
│  ├── ProjectDataService         # 项目数据                       │
│  ├── RealtimePollingService     # 轮询服务                       │
│  ├── RetryQueueService          # 重试队列                       │
│  ├── TombstoneService           # 墓碑处理                       │
│  ├── BatchSyncService           # 批量同步                       │
│  └── UserPreferencesSyncService # 偏好同步                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TaskOperationAdapterService                   │
│  （任务操作适配器：CRUD + 撤销协调 + 乐观更新）                    │
├─────────────────────────────────────────────────────────────────┤
│  ├── TaskOperationService       # 任务 CRUD 核心                 │
│  ├── TaskRepositoryService      # 持久化                         │
│  ├── TaskCreationService        # 创建                           │
│  ├── TaskMoveService            # 移动                           │
│  ├── TaskAttributeService       # 属性                           │
│  ├── TaskConnectionService      # 连接                           │
│  ├── SubtreeOperationsService   # 子树                           │
│  └── UndoService                # 撤销/重做                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Stores (Signals)                        │
│  src/app/core/state/stores.ts                                    │
├─────────────────────────────────────────────────────────────────┤
│  ├── tasksMap: Signal<Map<string, Task>>                         │
│  ├── tasksByProject: Signal<Map<string, Set<string>>>            │
│  ├── connectionsMap: Signal<Map<string, Connection>>             │
│  └── projectsMap: Signal<Map<string, Project>>                   │
└─────────────────────────────────────────────────────────────────┘
```

### GoJS 事件解耦

```
FlowTemplateService → flow-template-events.ts → FlowEventService
                           (事件代理)
```

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
  createdDate: string;
  displayId: string;             // 动态 "1,a"（随位置变化）
  shortId?: string;              // 永久 "NF-A1B2"（创建时生成）
  updatedAt?: string;            // LWW 关键字段
  deletedAt?: string | null;     // 软删除
  hasIncompleteTask?: boolean;   // 是否包含未完成待办
  attachments?: Attachment[];
  tags?: string[];               // 预留
  priority?: 'low' | 'medium' | 'high' | 'urgent';  // 预留
  dueDate?: string | null;       // 预留
  // 客户端临时字段（不同步到数据库）
  deletedConnections?: Connection[];
  deletedMeta?: { parentId, stage, order, rank, x, y };
}

interface Connection {
  id: string;
  source: string;
  target: string;
  title?: string;                // 联系块标题
  description?: string;          // 联系块描述
  deletedAt?: string | null;
}

interface Attachment {
  id: string;
  type: 'image' | 'document' | 'link' | 'file';
  name: string;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  size?: number;
  createdAt: string;
  signedAt?: string;             // URL 签名时间戳
  deletedAt?: string;            // 软删除
}

interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string;
  version?: number;
  viewState?: ViewState;
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

// 专注模式数据模型
interface BlackBoxEntry {
  id: string;                    // UUID 客户端生成
  projectId: string;
  userId: string;
  content: string;               // 转写文本
  date: string;                  // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;             // LWW 关键
  isRead: boolean;
  isCompleted: boolean;
  isArchived: boolean;
  snoozeUntil?: string;
  snoozeCount?: number;
  deletedAt: string | null;
  syncStatus?: 'pending' | 'synced' | 'conflict';
  originalAudioDuration?: number;
}

interface FocusPreferences {
  gateEnabled: boolean;          // 默认 true
  spotlightEnabled: boolean;
  strataEnabled: boolean;
  blackBoxEnabled: boolean;
  maxSnoozePerDay: number;       // 默认 3
}

interface StrataItem {
  type: 'black_box' | 'task';
  id: string;
  title: string;
  completedAt: string;
  source?: BlackBoxEntry | unknown;
}

type GateState = 'checking' | 'reviewing' | 'completed' | 'bypassed' | 'disabled';
```

---

## 开发命令

```bash
# 开发
npm start                    # 开发服务器
npm run build               # 生产构建
npm run build:dev           # 开发构建

# 测试
npm run test                # Vitest watch
npm run test:run            # 单次测试
npm run test:run:pure       # 纯函数测试
npm run test:run:services   # 服务测试
npm run test:run:components # 组件测试
npm run test:e2e            # Playwright E2E
npm run test:e2e:ui         # Playwright UI 模式

# 代码质量
npm run lint                # ESLint 检查
npm run lint:fix            # ESLint 修复
npx knip                    # 检测未使用代码

# 数据库
npm run db:types            # 更新 Supabase 类型

# 分析
npm run analyze:bundle      # Bundle 分析
npm run perf:benchmark      # 性能基准测试
```

---

## 代码规范

- 中文注释描述业务逻辑，英文标识符
- Angular Signals 状态管理（非 RxJS Store）
- `standalone: true` + `OnPush` 变更检测
- 使用 `input()`, `output()`, `viewChild()` 等函数而非装饰器
- 严格类型：`unknown` + 类型守卫替代 `any`
- 测试同目录：`*.service.ts` → `*.service.spec.ts`
- 单文件 200-400 行，最大不超过 800 行
- 函数不超过 50 行，嵌套不超过 4 层

---

## 常见陷阱

| 陷阱 | 解决方案 |
|------|----------|
| 全量同步导致流量激增 | 增量 `updated_at > last_sync_time` |
| GoJS 内存泄漏 | `diagram.clear()` + 移除所有监听 |
| 递归栈溢出 | 迭代 + `MAX_SUBTREE_DEPTH: 100` |
| 离线数据丢失 | 失败操作进 RetryQueue |
| Sentry 错误信息丢失 | `supabaseErrorToError()` 统一转换 |
| Edge Function API Key 泄露 | `supabase secrets set`，禁止硬编码 |
| iOS Safari 不支持 webm | 动态检测 mimeType，回退到 mp4 |
| inject(StoreService) | 直接注入具体子服务 |
| 同步时 content 被覆盖 | 查询必须包含 content 字段 |

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

## 认证与授权

- 强制登录，数据操作需 `user_id`
- 开发环境：`environment.devAutoLogin` 自动登录
- 离线模式：`LOCAL_MODE_USER_ID = 'local-user'`
- Row Level Security (RLS)：数据库层面强制隔离

---

## 测试策略

```
E2E Tests (few, critical paths)
    ↓
Integration Tests (service boundaries)
    ↓
Unit Tests (many, fast, isolated)
```

### 测试配置

| 配置文件 | 用途 |
|----------|------|
| `vitest.config.mts` | 主配置 |
| `vitest.pure.config.mts` | 纯函数测试（无 Angular 依赖） |
| `vitest.services.config.mts` | 服务测试 |
| `vitest.components.config.mts` | 组件测试 |
| `playwright.config.ts` | E2E 测试 |

### E2E 测试文件

| 文件 | 覆盖场景 |
|------|----------|
| `critical-paths.spec.ts` | 关键用户路径 |
| `data-protection.spec.ts` | 数据保护 |
| `focus-mode.spec.ts` | 专注模式 |
| `local-mode-performance.spec.ts` | 本地模式性能 |
| `stingy-hoarder-protocol.spec.ts` | 数据囤积协议 |
| `sync-integrity.spec.ts` | 同步完整性 |

---

## 性能优化

### 关键策略

1. **OnPush 变更检测**：所有组件默认 OnPush
2. **懒加载**：模态框、GoJS、Sentry 按需加载
3. **轮询替代 Realtime**：减少 WebSocket 开销
4. **增量同步**：仅拉取变更数据
5. **字段筛选**：避免 SELECT *

### 关键指标

| 指标 | 目标 |
|------|------|
| First Contentful Paint | < 1.5s |
| Time to Interactive | < 3s |
| Bundle Size (main) | < 500KB |

---

## 安全要点

1. **API Key**：仅存放在 Supabase Secrets，禁止前端硬编码
2. **输入消毒**：使用 Angular 内置 sanitization
3. **RLS**：所有表启用 Row Level Security
4. **CSRF**：HttpInterceptor 自动添加保护头
5. **XSS**：DOMPurify 处理 Markdown 渲染
6. **文件上传**：病毒扫描 + 类型验证

