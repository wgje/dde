# NanoFlow AI 编码指南

> **核心哲学**：不要造轮子。利用 Supabase Realtime 做同步，利用 UUID 做 ID，利用 PWA 做离线，利用 Sentry 做错误监控。

## 极简架构原则

### 1. ID 策略：客户端生成 UUID

```typescript
// 绝对规则：所有实体在客户端创建时使用 UUID v4
const newTask: Task = {
  id: crypto.randomUUID(),  // 禁止使用临时 ID 或数据库自增 ID
  title: '新任务',
  // ...
};
// 直接保存，无需 ID 转换
await localDb.tasks.put(newTask);
await supabase.from('tasks').upsert(newTask);
```

**好处**：离线创建的数据可直接关联（如创建任务 A，立即创建子任务 B 指向 A），同步时无需 ID 转换。

### 2. 数据流与同步（利用 Supabase）

```
读取：
  首屏加载 → 优先读取本地 IndexedDB
  后台 → 静默请求 Supabase (updated_at > last_sync_time)

写入（乐观更新）：
  用户操作 → 立即写入本地 → 立即更新 UI
  后台 → 推送到 Supabase
  错误 → 放入 RetryQueue，网络恢复自动重试

冲突解决：
  Last-Write-Wins (LWW) - 以 updated_at 为准，谁晚谁生效
```

### 3. 状态管理（Angular Signals）

```typescript
// 使用扁平化 Signal + Map 结构实现 O(1) 查找
// src/app/core/state/stores.ts
@Injectable({ providedIn: 'root' })
export class TaskStore {
  readonly tasksMap = signal<Map<string, Task>>(new Map());
  
  getTask(id: string): Task | undefined {
    return this.tasksMap().get(id);  // O(1)
  }
}
```

### 4. 移动端 GoJS 懒加载

```typescript
// 移动端使用 @defer + 条件渲染完全销毁/重建 FlowView
@if (!store.isMobile() || store.activeView() === 'flow') {
  @defer (on viewport; prefetch on idle) {
    <app-flow-view />
  } @placeholder {
    <div>加载流程视图...</div>
  }
}
```

**禁止**：不使用 `visibility: hidden` 隐藏 GoJS canvas（占用内存）。

### 5. RetryQueue 持久化（离线数据保护）

```typescript
// SimpleSyncService 自动将失败操作持久化到 localStorage
// 页面刷新后自动恢复，网络恢复后自动重试
private readonly RETRY_QUEUE_STORAGE_KEY = 'nanoflow.retry-queue';
private readonly RETRY_QUEUE_VERSION = 1;

// 最多重试 5 次，间隔 5 秒
private readonly MAX_RETRIES = 5;
private readonly RETRY_INTERVAL = 5000;
```

### 6. 错误监控（Sentry 集成）

```typescript
// main.ts - 应用启动时初始化 Sentry
import * as Sentry from '@sentry/angular';

Sentry.init({
  dsn: 'your-sentry-dsn',
  integrations: [
    Sentry.browserTracingIntegration(),   // 性能追踪
    Sentry.replayIntegration({             // 会话回放
      maskAllText: false,
      blockAllMedia: false,
    }),
  ],
  tracesSampleRate: 1.0,                   // 个人项目全量采集
  replaysSessionSampleRate: 1.0,           // 正常会话 100% 录制
  replaysOnErrorSampleRate: 1.0,           // 报错时 100% 录屏
});

// 业务代码中捕获错误
import * as Sentry from '@sentry/angular';
try {
  await riskyOperation();
} catch (error) {
  Sentry.captureException(error, { tags: { operation: 'operationName' } });
}
```

**Sentry 集成点**：
- `main.ts`：全局初始化 + Angular ErrorHandler 集成
- `SimpleSyncService`：同步操作错误上报
- `FlowDiagramService`：GoJS 相关错误上报
- `ModalLoaderService`：模态框加载错误上报
- `StorePersistenceService`：本地存储错误上报

**Supabase 错误转换**（`src/utils/supabase-error.ts`）：
```typescript
// Supabase 返回的错误是普通对象，需要转换才能被 Sentry 正确捕获
const enhanced = supabaseErrorToError(error);
Sentry.captureException(enhanced, { 
  tags: { operation: 'syncTask' },
  level: enhanced.isRetryable ? 'warning' : 'error'
});
```

## 目录结构（实际架构）

```
src/
├── app/
│   ├── core/                    # 核心基础设施（单例服务）
│   │   ├── services/            # SimpleSyncService, ModalLoaderService
│   │   └── state/               # stores.ts, store-persistence.service.ts
│   ├── features/                # 业务功能（待迁移）
│   │   ├── flow/                # 流程图视图（index.ts）
│   │   └── text/                # 文本列表视图（index.ts）
│   └── shared/                  # 共享 UI 组件
│       ├── ui/                  # index.ts
│       └── services/            # index.ts
├── components/                  # 组件（主要存放位置）
│   ├── flow/                    # 流程图相关组件
│   │   ├── flow-palette.component.ts
│   │   ├── flow-toolbar.component.ts
│   │   ├── flow-task-detail.component.ts
│   │   ├── flow-connection-editor.component.ts
│   │   └── flow-link-type-dialog.component.ts
│   ├── modals/                  # 模态框组件
│   │   ├── login-modal.component.ts
│   │   ├── settings-modal.component.ts
│   │   ├── new-project-modal.component.ts
│   │   ├── trash-modal.component.ts
│   │   ├── conflict-modal.component.ts
│   │   └── dashboard-modal.component.ts
│   ├── text-view/               # 文本视图组件
│   │   ├── text-stages.component.ts
│   │   ├── text-unfinished.component.ts
│   │   ├── text-unassigned.component.ts
│   │   ├── text-task-editor.component.ts
│   │   └── text-task-card.component.ts
│   ├── flow-view.component.ts   # 流程图主视图
│   ├── text-view.component.ts   # 文本主视图
│   ├── project-shell.component.ts # 项目容器/视图切换
│   ├── error-boundary.component.ts
│   ├── error-page.component.ts
│   └── offline-banner.component.ts
├── services/                    # 服务层（主要存放位置）
│   ├── flow-diagram.service.ts        # GoJS 主服务
│   ├── flow-event.service.ts          # 事件处理
│   ├── flow-template.service.ts       # 模板配置
│   ├── flow-template-events.ts        # 事件总线
│   ├── flow-selection.service.ts      # 选择管理
│   ├── flow-zoom.service.ts           # 缩放控制
│   ├── flow-layout.service.ts         # 布局计算
│   ├── flow-drag-drop.service.ts      # 拖放逻辑
│   ├── global-error-handler.service.ts # 全局错误处理（分级 + Sentry）
│   ├── task-operation.service.ts      # 任务 CRUD
│   ├── store.service.ts               # 状态管理
│   ├── auth.service.ts                # 认证服务
│   ├── supabase-client.service.ts     # Supabase 客户端
│   ├── toast.service.ts               # Toast 提示
│   ├── logger.service.ts              # 日志服务
│   ├── theme.service.ts               # 主题服务
│   └── ...
├── models/                      # 数据模型
│   ├── index.ts                 # Task, Project, Connection 类型导出
│   ├── supabase-types.ts        # Supabase 数据库类型
│   └── supabase-mapper.ts       # 类型转换
├── config/                      # 配置常量
│   ├── constants.ts             # 全局配置
│   └── flow-styles.ts           # GoJS 样式
├── utils/                       # 工具函数
│   ├── result.ts                # Result 类型
│   ├── supabase-error.ts        # Supabase 错误转换（Sentry 友好）
│   ├── date.ts                  # 日期工具
│   └── validation.ts            # 验证工具
└── environments/                # 环境配置
    ├── environment.ts
    └── environment.development.ts
```

## 核心服务架构

```
服务架构 - 2024-12 更新
├── core/ (src/app/core/)
│   ├── services/
│   │   ├── SimpleSyncService        # 简化同步（LWW + 持久化 RetryQueue + Sentry 错误上报）
│   │   └── ModalLoaderService       # 模态框动态加载 + Sentry 错误上报
│   └── state/
│       ├── stores.ts                # 状态管理 (Signal-based Map<id, Entity>)
│       └── StorePersistenceService  # 本地持久化 + Sentry 错误上报
│
├── services/ (src/services/) - 主服务层
│   ├── GoJS 流程图服务（已完全拆分）
│   │   ├── FlowDiagramService       # 主服务：初始化、生命周期、导出 + Sentry 错误上报
│   │   ├── FlowEventService         # 事件处理：回调注册、事件代理
│   │   ├── FlowTemplateService      # 模板配置：节点/连接线/Overview
│   │   ├── FlowSelectionService     # 选择管理：选中/多选/高亮
│   │   ├── FlowZoomService          # 缩放控制：放大/缩小/适应内容
│   │   ├── FlowLayoutService        # 布局计算：自动布局/位置保存
│   │   ├── FlowDragDropService      # 拖放逻辑
│   │   └── flow-template-events.ts  # 事件总线（解耦桥梁）
│   │
│   ├── 业务服务
│   │   ├── TaskOperationService     # 任务 CRUD
│   │   ├── AttachmentService        # 附件管理
│   │   ├── SearchService            # 搜索
│   │   └── StoreService             # 状态管理
│   │
│   ├── 错误处理
│   │   └── GlobalErrorHandler       # 全局错误处理（分级 + Sentry 集成）
│   │
│   └── 基础设施
│       ├── AuthService              # 认证
│       ├── SupabaseClientService    # Supabase 客户端
│       ├── ToastService             # Toast 提示
│       ├── LoggerService            # 日志
│       └── ThemeService             # 主题
│
└── utils/ (src/utils/)
    ├── result.ts                    # Result 类型统一错误处理
    └── supabase-error.ts            # Supabase 错误转换为 Sentry 友好的 Error
```

### 事件代理模式（FlowTemplateService ↔ FlowEventService）

```typescript
// 模板中发送信号（flow-template.service.ts）
click: (e: any, node: any) => {
  flowTemplateEventHandlers.onNodeClick?.(node);
}

// EventService 注册处理器（flow-event.service.ts）
flowTemplateEventHandlers.onNodeClick = (node) => {
  this.zone.run(() => this.emitNodeClick(node.data.key, false));
};
```

**好处**：完全解耦，模板不知道回调是谁，EventService 不知道模板长什么样。

## 开发命令

```bash
npm start              # 开发服务器 (localhost:3000)
npm run test           # Vitest watch 模式
npm run test:run       # 单次运行测试
npm run test:e2e       # Playwright E2E
npm run lint:fix       # ESLint 自动修复
```

## 代码风格

- **中文注释**描述业务逻辑和架构决策
- **Angular Signals** 进行状态管理（非 RxJS BehaviorSubject）
- **独立组件**：`standalone: true` + `OnPush` 变更检测
- **严格类型**：避免 `any`，使用 `unknown` + 类型守卫
- 测试文件与源文件同目录：`*.service.ts` → `*.service.spec.ts`

## 常见陷阱

1. **全量同步**：使用增量同步，基于 `updated_at > last_sync_time`
2. **GoJS 内存泄漏**：组件销毁时调用 `diagram.clear()` 和移除事件监听
3. **递归栈溢出**：所有树遍历使用迭代算法 + 深度限制（MAX_TREE_DEPTH: 500）
4. **离线数据丢失**：失败操作必须进入 RetryQueue
5. **Sentry 错误丢失**：Supabase 错误是普通对象，需使用 `supabaseErrorToError()` 转换

## 关键配置（src/config/constants.ts）

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖延迟 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | 普通 API 超时 |
| `TRASH_CONFIG.AUTO_CLEANUP_DAYS` | 30 | 回收站自动清理 |

---

<details>
<summary>📚 详细架构文档（点击展开）</summary>

## 架构概览

NanoFlow 是一个 **Angular 19 + Supabase** 构建的项目追踪应用，支持**双视图模式**（文本/流程图）和**离线优先**的云端同步。

### 用户意图

用户希望获得一个**"打开即用"**的 PWA：
- 不需要复杂的协同算法
- 必须要快：点击完成，立刻打勾，没有 loading 转圈
- 必须要稳：地铁上断网写的日记，连上 wifi 后必须自动传上去，别丢数据

### 核心架构决策

1. **离线优先**：本地 IndexedDB 为主，云端 Supabase 为备份
2. **乐观更新**：UI 立即响应，后台异步同步
3. **LWW 冲突解决**：以 updated_at 为准，简单可靠
4. **客户端 UUID**：所有实体 ID 在客户端生成

### 视图架构

```
AppComponent (全局容器)
    └── ProjectShellComponent (视图切换)
            ├── TextViewComponent (文本视图)
            │       ├── TextUnfinishedComponent
            │       ├── TextUnassignedComponent
            │       └── TextStagesComponent
            └── FlowViewComponent (流程图视图) - 移动端条件渲染
                    ├── FlowPaletteComponent
                    ├── FlowToolbarComponent
                    └── FlowTaskDetailComponent
```

---

## LWW（Last-Write-Wins）同步策略

```typescript
// SimpleSyncService 核心逻辑
async pullTasks(projectId: string, since?: string): Promise<Task[]> {
  const { data } = await supabase
    .from('tasks')
    .select()
    .eq('project_id', projectId)
    .gt('updated_at', since);
  
  // LWW：更新比本地新的数据
  for (const remote of data) {
    const local = await localDb.tasks.get(remote.id);
    if (!local || remote.updated_at > local.updated_at) {
      await localDb.tasks.put(remote);
    }
  }
}
```

**策略说明**：
- 个人应用场景中，冲突概率极低
- 简化实现，减少复杂度
- 以 updated_at 时间戳为准

---

## GoJS 流程图集成

### 服务拆分（2024-12 优化后）

| 服务 | 职责 |
|------|------|
| **FlowDiagramService** | 主服务：初始化、生命周期、导出 + Sentry 错误上报 |
| **FlowEventService** | 事件处理：回调注册、事件代理 |
| **FlowTemplateService** | 模板配置：节点/连接线/Overview |
| **FlowSelectionService** | 选择管理：选中/多选/高亮 |
| **FlowZoomService** | 缩放控制：放大/缩小/适应内容 |
| **FlowLayoutService** | 布局计算：自动布局/位置保存 |
| **FlowDragDropService** | 拖放逻辑 |
| **flow-template-events.ts** | 事件总线（解耦桥梁） |

### 布局算法

- **stage**：阶段/列索引（1, 2, 3...）
- **rank**：垂直排序权重
- **parentId**：父子关系
- **displayId**：动态计算（如 "1", "1,a"）
- **shortId**：永久 ID（如 "NF-A1B2"）

---

## 数据模型

```typescript
interface Task {
  id: string;           // UUID
  title: string;
  content: string;      // Markdown
  stage: number | null; // null = 未分配
  rank: number;
  parentId: string | null;
  status: 'active' | 'completed' | 'archived';
  updatedAt: string;    // LWW 关键字段
  deletedAt?: string;   // 软删除
}

interface Project {
  id: string;           // UUID
  name: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt: string;
}
```

### Supabase 表结构

- `projects`：项目元数据
- `tasks`：任务
- `connections`：连接线

---

## 认证

强制登录模式，所有数据操作都需要 user_id。

开发环境可配置自动登录（environment.devAutoLogin）。

未配置 Supabase 时自动启用离线模式。

---

## 错误处理

```typescript
// Result 类型统一错误处理
import { Result, success, failure, ErrorCodes } from '../utils/result';

function doSomething(): Result<Project, OperationError> {
  if (error) return failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');
  return success(project);
}
```

### 错误严重级别（GlobalErrorHandler）

| 级别 | 说明 | 处理方式 |
|------|------|----------|
| `SILENT` | 无关紧要的错误 | 仅记录日志 |
| `NOTIFY` | 需要告知用户 | Toast 提示 |
| `RECOVERABLE` | 可恢复错误 | 恢复对话框 |
| `FATAL` | 致命错误 | 跳转错误页面 |

### Sentry 错误上报

关键操作失败时会自动上报到 Sentry，包含 `tags.operation` 标识操作类型。

```typescript
// 示例：同步操作错误上报
Sentry.captureException(enhanced, { 
  tags: { operation: 'syncTask', projectId },
  level: enhanced.isRetryable ? 'warning' : 'error'
});
```

---

## 测试策略

### 单元测试（Vitest + happy-dom）

测试文件与源文件同目录。

### E2E 测试（Playwright）

关键选择器约定：`data-testid="xxx"`

</details>
