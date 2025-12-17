# NanoFlow AI 编码指南

> **架构核心**：Angular 19 + Supabase，离线优先，乐观更新，门面模式

## 关键架构约束

### 1. 服务职责分离（严格执行）

| 服务 | 可以做 | 禁止做 |
|------|--------|--------|
| `StoreService` | 纯透传到子服务 | 添加任何业务逻辑 |
| `SyncCoordinatorService` | 协调同步时序 | 管理 UI 状态 |
| `ProjectStateService` | 管理内存状态 | 发起网络请求 |
| `ChangeTrackerService` | 追踪增量变更 | 执行实际同步 |

### 2. 乐观更新必备模式

```typescript
// 结构性操作必须创建快照（src/services/optimistic-state.service.ts）
const snapshot = optimisticState.createSnapshot('task-update', '更新任务');
projectState.updateProjects(mutator);  // 立即应用
try {
  await syncService.save(data);
  optimisticState.commitSnapshot(snapshot.id);
} catch {
  optimisticState.rollbackSnapshot(snapshot.id); // 失败必须回滚
}
```

### 3. ID 策略：客户端生成 UUID（重要）

```typescript
// 所有实体在客户端创建时直接使用 UUID
const newTask: Task = {
  id: crypto.randomUUID(),  // 不使用临时 ID
  title: '新任务',
  // ...
};
// 直接保存，无需 ID 转换
await localDb.tasks.put(newTask);
await supabase.from('tasks').upsert(newTask);
```

**好处**：离线创建的数据可直接关联（如创建任务 A，立即创建子任务 B 指向 A），同步时无需 ID 转换。

### 4. 移动端 GoJS 懒加载

```typescript
// 移动端使用条件渲染完全销毁/重建 FlowView
@if (!store.isMobile() || store.activeView() === 'flow') {
  <app-flow-view />
}
```

**禁止**：不使用 `visibility: hidden` 隐藏 GoJS canvas（占用内存）。

## 核心模式

### Result 类型（统一错误处理）

```typescript
// src/utils/result.ts - 不使用 throw，使用 Result 类型
import { Result, success, failure, isFailure, ErrorCodes } from '../utils/result';

function doSomething(): Result<Project, OperationError> {
  if (error) return failure(ErrorCodes.DATA_NOT_FOUND, '项目不存在');
  return success(project);
}
```

### 增量变更追踪

```typescript
// src/services/change-tracker.service.ts - 避免全量同步
changeTracker.trackTaskUpdate(projectId, task, ['title', 'content']);
const summary = changeTracker.getProjectChangeSummary(projectId);
// 同步成功后清除
changeTracker.clearProjectChanges(projectId);
```

### 字段级操作锁（防远程覆盖）

```typescript
changeTracker.lockTaskField(taskId, projectId, 'rank');   // 拖拽时锁定
changeTracker.unlockTaskField(taskId, projectId, 'rank'); // ACK 后解锁
```

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

1. **StoreService 膨胀**：新功能创建子服务，StoreService 只做透传
2. **全量同步**：必须使用 ChangeTrackerService 追踪增量
3. **GoJS 内存泄漏**：组件销毁时调用 `diagram.clear()` 和移除事件监听
4. **递归栈溢出**：所有树遍历使用迭代算法 + 深度限制（MAX_TREE_DEPTH: 500）
5. **乐观更新不回滚**：结构性操作必须创建快照

## 关键配置（src/config/constants.ts）

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖延迟 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | 普通 API 超时 |
| `UNDO_CONFIG.MAX_HISTORY_SIZE` | 50 | 撤销历史上限 |

---

<details>
<summary>📚 详细架构文档（点击展开）</summary>

## 架构概览

NanoFlow 是一个 **Angular 19 + Supabase** 构建的项目追踪应用，支持**双视图模式**（文本/流程图）和**离线优先**的云端同步。

### 核心架构决策

1. **离线优先**：本地 IndexedDB 为主，云端 Supabase 为备份。用户数据永不丢失是最高优先级
2. **乐观更新**：UI 立即响应，后台异步同步，失败时快照回滚
3. **门面模式**：StoreService 是唯一公共 API，内部逻辑由专职子服务实现
4. **客户端 UUID**：所有实体 ID 在客户端生成，无需服务端分配

### 核心数据流

```
用户操作 → StoreService (门面) → 子服务层 → SyncCoordinatorService → Supabase
                                    ↓
               TaskOperationAdapterService / ProjectStateService
                                    ↓
                    ChangeTrackerService (增量追踪)
                                    ↓
                    ActionQueueService (离线队列)
```

### 视图架构

```
AppComponent (全局容器，模态框宿主)
    └── ProjectShellComponent (视图切换)
            ├── TextViewComponent (文本视图)
            │       ├── TextUnfinishedComponent
            │       ├── TextUnassignedComponent
            │       └── TextStagesComponent
            └── FlowViewComponent (流程图视图)
                    ├── FlowPaletteComponent
                    ├── FlowToolbarComponent
                    └── FlowTaskDetailComponent
```

- **移动端**：使用 `@if` 条件渲染控制 FlowView 组件的显示/销毁
- **桌面端**：并排显示文本和流程图视图

---

## 同步系统深度解析

### LWW（Last-Write-Wins）策略

采用简单的 **Last-Write-Wins** 策略处理冲突：

```
以 updated_at 时间戳为准，谁晚谁生效

冲突处理：
1. 本地修改 → 立即应用，后台同步
2. 远程版本较新 → 可选择覆盖本地
3. 版本冲突 → 默认保留本地版本（用户刚编辑的内容）
```

**策略说明**：
- 个人应用场景中，冲突概率极低
- 简化实现，减少复杂度
- 用户可手动选择使用哪个版本

### 离线队列机制

[src/services/action-queue.service.ts](src/services/action-queue.service.ts) 实现：

```typescript
// 操作优先级（决定失败处理策略）
type OperationPriority = 'low' | 'normal' | 'critical';

// low: 失败后 FIFO 丢弃，无提示
// normal: 失败进死信队列，有容量限制
// critical: 失败超阈值触发用户提示
```

**业务错误 vs 网络错误**：
```typescript
// 这些错误不重试，直接进死信队列
BUSINESS_ERROR_PATTERNS: [
  'not found', 'permission denied', 'row level security',
  'duplicate key', 'unique constraint', 'foreign key'
]
```

### 远程变更处理

[src/services/remote-change-handler.service.ts](src/services/remote-change-handler.service.ts) 处理 Supabase Realtime 推送：

```typescript
// 编辑保护：用户编辑期间跳过远程更新
private shouldSkipRemoteUpdate(): boolean {
  const isEditing = this.uiState.isEditing;
  const hasPending = this.syncCoordinator.hasPendingLocalChanges();
  const timeSinceLastPersist = Date.now() - this.syncCoordinator.getLastPersistAt();
  return isEditing || hasPending || timeSinceLastPersist < 300;
}
```

### 同步模式（借鉴思源笔记）

[src/services/sync-mode.service.ts](src/services/sync-mode.service.ts) 支持三种模式：

| 模式 | 适用场景 | 行为 |
|------|----------|------|
| `automatic` | 桌面端稳定网络 | 按间隔自动同步（默认30秒） |
| `manual` | 移动端流量环境 | 仅启动/退出时同步 |
| `completely-manual` | 敏感数据场景 | 用户明确选择上传/下载 |

---

## GoJS 流程图集成

### 服务拆分

| 服务 | 职责 |
|------|------|
| **GoJSDiagramService** | 图表初始化、节点/连接模板、主题 |
| **FlowDiagramService** | 数据绑定、节点交互回调 |
| **FlowDragDropService** | 拖放逻辑、插入位置计算 |
| **FlowTouchService** | 触摸手势、长按拖拽 |
| **FlowLinkService** | 连接线类型、父子 vs 关联 |
| **LineageColorService** | 血缘追溯、家族颜色分配 |

### 自定义 DynamicLinkingTool

[src/services/gojs-diagram.service.ts](src/services/gojs-diagram.service.ts) 实现从节点边缘任意位置拖出连接线（而非固定端口）。

### 布局算法

[src/services/layout.service.ts](src/services/layout.service.ts) 核心概念：

- **stage**：阶段/列索引（1, 2, 3...）
- **rank**：垂直排序权重（数值越大越靠下）
- **parentId**：父子关系，子任务 stage = parent.stage + 1
- **displayId**：动态计算（如 "1", "1,a", "2,b"），随位置变化
- **shortId**：永久 ID（如 "NF-A1B2"），创建时生成，永不改变

**防无限循环**：所有递归算法已改为迭代 + 最大深度限制：
```typescript
const ALGORITHM_CONFIG = {
  MAX_TREE_DEPTH: 500,
  BASE_MAX_ITERATIONS: 10000,
  ITERATIONS_PER_TASK: 100,
};
```

---

## 数据模型

核心模型在 [src/models/index.ts](src/models/index.ts)：

```typescript
interface Task {
  id: string;
  title: string;
  content: string;           // Markdown
  stage: number | null;      // null = 未分配
  rank: number;              // 垂直排序权重
  parentId: string | null;   // 父任务
  status: 'active' | 'completed' | 'archived';
  displayId: string;         // 动态计算
  shortId?: string;          // 永久 ID
  deletedAt?: string;        // 软删除
}

interface Connection {
  id: string;
  source: string;
  target: string;
  description?: string;
  deletedAt?: string;
}

interface Project {
  id: string;
  name: string;
  tasks: Task[];
  connections: Connection[];
  version?: number;          // 乐观锁版本号
}
```

### Supabase 表结构

- `projects`：项目元数据（owner_id, title, version, migrated_to_v2）
- `tasks`：任务（v2 独立表）
- `connections`：连接线
- `task_tombstones`：已删除任务标记（防止跨设备复活）

---

## 认证与路由守卫

[src/services/auth.service.ts](src/services/auth.service.ts) - 强制登录模式，所有数据操作都需要 user_id。

开发环境可配置自动登录（environment.devAutoLogin）。

未配置 Supabase 时自动启用离线模式，使用 `AUTH_CONFIG.LOCAL_MODE_USER_ID`。

---

## 附件系统

[src/services/attachment.service.ts](src/services/attachment.service.ts)：

- 支持上传取消
- URL 自动刷新（Supabase 签名 URL 7天有效，6天后自动刷新）
- 最大文件大小 10MB，每个任务最多 20 个附件

---

## 错误处理

[src/services/global-error-handler.service.ts](src/services/global-error-handler.service.ts) 按严重级别分类：

- `SILENT`：仅记录日志（图片加载失败、ResizeObserver）
- `NOTIFY`：Toast 提示（保存失败、网络断开）
- `RECOVERABLE`：恢复对话框
- `FATAL`：跳转错误页面

---

## 测试策略

### 单元测试（Vitest + happy-dom）

- 配置：[vitest.config.mts](vitest.config.mts)
- 测试文件与源文件同目录

### E2E 测试（Playwright）

[e2e/critical-paths.spec.ts](e2e/critical-paths.spec.ts) 测试关键路径。

关键选择器约定：`data-testid="xxx"`

---

## 文件组织约定

```
src/
├── components/          # 组件
│   ├── modals/          # 模态框
│   ├── flow/            # 流程图子组件
│   └── text-view/       # 文本视图子组件
├── services/            # 服务 + 同目录测试
├── models/              # 数据模型
├── config/              # 配置常量
└── utils/               # 工具函数
```

---

## 配置常量速查

[src/config/constants.ts](src/config/constants.ts) 中的关键配置：

| 配置组 | 关键常量 | 说明 |
|--------|----------|------|
| `SYNC_CONFIG` | `DEBOUNCE_DELAY: 3000` | 同步防抖延迟 |
| `SYNC_CONFIG` | `CLOUD_LOAD_TIMEOUT: 30000` | 云端加载超时 |
| `TIMEOUT_CONFIG` | `QUICK/STANDARD/HEAVY/UPLOAD` | 分级超时 |
| `RETRY_POLICY` | `MAX_RETRIES: 3` | 最大重试次数 |
| `OPTIMISTIC_CONFIG` | `TEMP_ID_PREFIX: 'temp-'` | 临时 ID 前缀 |
| `TRASH_CONFIG` | `AUTO_CLEANUP_DAYS: 30` | 回收站自动清理 |
| `UNDO_CONFIG` | `MAX_HISTORY_SIZE: 50` | 撤销历史上限 |
| `UI_CONFIG` | `LONG_PRESS_DELAY: 200` | 长按触发延迟 |
| `GOJS_CONFIG` | `POSITION_SAVE_DEBOUNCE: 300` | 位置保存防抖 |

</details>
