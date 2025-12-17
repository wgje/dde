# NanoFlow 极简重构计划

> 基于 `.github/agents.md` 的极简架构原则，对项目进行大规模简化重构

## 📊 当前问题分析

### 服务数量过多（50+ 服务文件）
当前架构过度工程化，核心问题：

| 问题 | 影响 | 根因 |
|------|------|------|
| 临时 ID 机制 | swapId 逻辑复杂、易出错 | 没有使用客户端生成 UUID |
| 三路合并 | 代码复杂、维护困难 | 过度设计，LWW 足够 |
| 僵尸模式 (visibility:hidden) | 移动端内存占用高 | 应该完全销毁/重建 |
| 同步服务碎片化 | 10+ 同步相关服务 | 职责划分过细 |

### 需要删除/简化的服务

```
❌ 删除（功能被新架构替代）
├── optimistic-state.service.ts (临时ID逻辑 → 客户端UUID)
├── three-way-merge.service.ts (三路合并 → LWW)
├── base-snapshot.service.ts (Base快照 → 不再需要)
├── sync-checkpoint.service.ts (检查点 → LWW 不需要)
├── sync-perception.service.ts (多设备感知 → Supabase Realtime)
├── sync-mode.service.ts (同步模式 → 简化为自动)
├── conflict-history.service.ts (冲突历史 → LWW无冲突)
├── conflict-storage.service.ts (冲突存储 → 不再需要)
├── conflict-resolution.service.ts (冲突解决 → LWW自动)
└── change-tracker.service.ts (变更追踪 → 简化)

🔀 合并（职责重叠）
├── sync-coordinator.service.ts ─┐
├── sync.service.ts ─────────────┼→ SimpleSyncService
└── remote-change-handler.service.ts ─┘

├── task-operation.service.ts ───┐
├── task-operation-adapter.service.ts ┼→ TaskService
└── task-repository.service.ts ──┘
```

---

## 🎯 重构目标

### 1. ID 策略：客户端生成 UUID（第一优先级）

**Before:**
```typescript
// 当前：临时 ID + swapId
const tempId = optimisticState.generateTempId('task');
// ... 创建任务
optimisticState.swapId(tempId, serverAssignedId);
```

**After:**
```typescript
// 新策略：客户端直接生成 UUID
const task: Task = {
  id: crypto.randomUUID(),
  title: '新任务',
  // ...
};
// 直接保存，无需 ID 转换
await localDb.tasks.put(task);
await supabase.from('tasks').upsert(task);
```

**改动点：**
- [x] 删除 `OPTIMISTIC_CONFIG.TEMP_ID_PREFIX` ✅
- [x] 删除 `OptimisticStateService.generateTempId()` ✅
- [x] 删除 `OptimisticStateService.swapId()` ✅
- [x] 删除所有 `isTempId()` 检查 ✅
- [x] 更新所有创建任务/项目/连接线的代码 ✅

---

### 2. 同步策略：Last-Write-Wins（第二优先级）

**Before:**
```typescript
// 当前：三路合并
const mergeResult = threeWayMerge.merge(base, local, remote);
if (mergeResult.hasConflicts) {
  // 复杂的冲突处理...
}
```

**After:**
```typescript
// 新策略：LWW
const winner = local.updated_at > remote.updated_at ? local : remote;
await localDb.tasks.put(winner);
```

**改动点：**
- [x] 删除 `ThreeWayMergeService` ✅
- [x] 删除 `BaseSnapshotService` ✅
- [ ] 删除所有冲突相关服务（保留 ConflictStorageService 用于 UI 展示）
- [x] 在 `SyncService` 中实现简单的 LWW 逻辑 ✅
- [x] 所有实体添加 `updated_at` 字段（已存在）✅

---

### 3. GoJS 懒加载：完全销毁/重建（第三优先级）

**Before:**
```typescript
// 当前：僵尸模式
.flow-container.zombie-mode {
  visibility: hidden; // 仍占用内存
}
```

**After:**
```typescript
// 新策略：条件渲染 + @defer
@if (store.activeView() === 'flow') {
  @defer (on viewport) {
    <app-flow-view />
  } @placeholder {
    <div>加载中...</div>
  }
}
```

**改动点：**
- [x] 移除 `zombie-mode` CSS ✅
- [ ] 使用 Angular `@defer` 块实现懒加载（使用 `@if` 条件渲染替代）
- [x] FlowViewComponent 每次进入时重新初始化 ✅
- [ ] 移除 GoJS canvas 重绘 hack

---

### 4. 简化后的服务架构

```
新架构（约20个核心服务）
├── core/
│   ├── SupabaseClientService    # Supabase 客户端
│   ├── AuthService              # 认证
│   ├── LocalDbService           # IndexedDB (Dexie)
│   └── SimpleSyncService        # 简化的同步（LWW）
│
├── state/
│   ├── ProjectStore             # 项目状态 (Signals)
│   ├── TaskStore                # 任务状态 (Signals, Map结构)
│   └── UiStateService           # UI 状态
│
├── features/
│   ├── TaskService              # 任务 CRUD
│   ├── ConnectionService        # 连接线 CRUD
│   ├── AttachmentService        # 附件管理
│   └── SearchService            # 搜索
│
├── flow/
│   ├── FlowDiagramService       # GoJS 图表
│   ├── FlowDragDropService      # 拖放
│   └── LayoutService            # 布局计算
│
└── shared/
    ├── ToastService             # Toast 提示
    ├── LoggerService            # 日志
    └── ThemeService             # 主题
```

---

## 📝 实施步骤

### Phase 1: ID 策略重构（预计 2-3 小时）

1. **修改数据模型**
   ```typescript
   // models/index.ts
   interface Task {
     id: string;  // UUID，不再有 temp- 前缀
     // ...
   }
   ```

2. **更新创建逻辑**
   - `TaskService.createTask()` 使用 `crypto.randomUUID()`
   - `ProjectStateService.createProject()` 使用 `crypto.randomUUID()`

3. **删除临时 ID 相关代码**
   - 清理 `OptimisticStateService` 中的 tempId 逻辑
   - 删除所有 `swapId` 调用

### Phase 2: 同步系统简化（预计 3-4 小时）

1. **创建 SimpleSyncService**
   ```typescript
   @Injectable({ providedIn: 'root' })
   export class SimpleSyncService {
     async pushToCloud(entity: Task | Project | Connection) {
       // 简单 upsert，依赖 updated_at 实现 LWW
       await supabase.from('tasks').upsert(entity);
     }

     async pullFromCloud(lastSyncTime: Date) {
       const { data } = await supabase
         .from('tasks')
         .select()
         .gt('updated_at', lastSyncTime.toISOString());
       
       // LWW：更新比本地新的数据
       for (const remote of data) {
         const local = await localDb.tasks.get(remote.id);
         if (!local || remote.updated_at > local.updated_at) {
           await localDb.tasks.put(remote);
         }
       }
     }
   }
   ```

2. **删除复杂同步服务**
   - 三路合并、快照、冲突存储等

### Phase 3: GoJS 懒加载重构（预计 2 小时）

1. **修改 ProjectShellComponent**
   ```typescript
   @if (activeView() === 'flow') {
     @defer {
       <app-flow-view />
     } @loading {
       <div class="flex items-center justify-center h-full">
         <span>加载流程图...</span>
       </div>
     }
   }
   ```

2. **简化 FlowViewComponent**
   - 移除僵尸模式相关逻辑
   - 每次挂载时完整初始化

### Phase 4: 清理和测试（预计 1-2 小时）

1. **更新配置**
   - 简化 `constants.ts`
   - 更新 `copilot-instructions.md`

2. **更新测试**
   - 删除过时的测试文件
   - 添加新架构的测试

---

## ⚠️ 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| LWW 可能丢失并发编辑 | 个人应用场景，冲突概率极低 |
| GoJS 重建可能有性能问题 | 桌面端保持双视图，仅移动端销毁 |
| 大规模删除可能引入bug | 分 Phase 执行，每步完成后测试 |

---

## ✅ 验收标准

- [x] 所有任务/项目 ID 使用 UUID，无 `temp-` 前缀 ✅
- [x] 无三路合并逻辑，同步使用 LWW ✅
- [x] 移动端切换视图时，GoJS 完全销毁/重建 ✅
- [ ] 服务数量从 50+ 减少到 20 左右（部分完成，仍有优化空间）
- [x] 所有现有测试通过 ✅ (311/311)
- [ ] E2E 关键路径测试通过

---

## 📌 执行状态

### ✅ 已完成
- **Phase 1**: ID 策略重构 - 移除临时 ID 机制，改用客户端 UUID
- **Phase 2**: 同步系统简化 - 删除三路合并/Base快照，改用 LWW
- **Phase 3**: GoJS 懒加载 - 移动端使用 `@if` 条件渲染

### 🔄 待完成（可选优化）
- 进一步合并冗余服务（如合并同步相关服务为 SimpleSyncService）
- 删除更多不再需要的服务（如 sync-checkpoint.service.ts）
- E2E 测试验证
