# Project Conventions

> 项目编码约定和架构规则
> 来源：[everything-claude-code Continuous Learning](https://github.com/affaan-m/everything-claude-code)

## 架构约定

### 服务层次结构

```
StoreService (门面) ※ 禁止业务逻辑
    ├── UserSessionService
    ├── TaskOperationAdapterService
    ├── ProjectStateService
    ├── UiStateService
    ├── SyncCoordinatorService
    ├── SearchService
    └── PreferenceService
```

**规则**: 新代码禁止 `inject(StoreService)`，直接注入子服务

### GoJS 事件解耦

```
FlowTemplateService → flow-template-events.ts → FlowEventService
```

**规则**: GoJS 模板内的事件通过 `flow-template-events.ts` 代理

---

## ID 策略

### UUID 生成
```typescript
// ✅ 正确：客户端生成
const id = crypto.randomUUID();

// ❌ 禁止
// - 数据库自增 ID
// - 临时 ID（如 temp_xxx）
// - 同步时 ID 转换
```

### ID 字段命名
| 字段 | 用途 |
|------|------|
| `id` | 主键，UUID |
| `displayId` | 动态显示 ID，如 "1,a" |
| `shortId` | 永久短 ID，如 "NF-A1B2" |

---

## 数据同步约定

### Offline-first 流程
```
读：IndexedDB → 后台增量拉取（updated_at > last_sync_time）
写：本地写入 + UI 更新 → 后台推送（防抖 3s）→ 失败进 RetryQueue
冲突：LWW（Last-Write-Wins）
```

### 软删除
```typescript
// 使用 deletedAt 字段，不物理删除
interface Task {
  deletedAt?: string | null;
}

// 查询时过滤
const activeTasks = tasks.filter(t => !t.deletedAt);
```

---

## 组件约定

### Angular 组件配置
```typescript
@Component({
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ...
})
```

### 模态框基类
所有模态框继承 `BaseModalComponent`：
```typescript
export class MyModalComponent extends BaseModalComponent {
  // 自动处理：ESC 关闭、点击外部关闭、焦点管理
}
```

---

## 错误处理约定

### Result 模式
```typescript
import { Result, success, failure, ErrorCodes } from '@/utils/result';

function doSomething(): Result<Data, ErrorCode> {
  if (error) return failure(ErrorCodes.DATA_NOT_FOUND, '消息');
  return success(data);
}
```

### 错误分级
| 级别 | 处理 | 示例 |
|------|------|------|
| SILENT | 仅日志 | ResizeObserver |
| NOTIFY | Toast | 保存失败 |
| RECOVERABLE | 恢复对话框 | 同步冲突 |
| FATAL | 错误页面 | Store 初始化失败 |

---

## 配置约定

### 配置文件位置
```
src/config/
├── sync.config.ts        # 同步配置
├── layout.config.ts      # 布局配置
├── timeout.config.ts     # 超时配置
├── auth.config.ts        # 认证配置
├── focus.config.ts       # 专注模式配置
└── ...
```

### 配置常量命名
```typescript
export const SYNC_CONFIG = {
  DEBOUNCE_DELAY: 3000,      // 防抖延迟
  CLOUD_LOAD_TIMEOUT: 30000, // 云加载超时
} as const;
```

---

## 如何添加新约定

```markdown
### 约定名称

描述或代码示例

规则说明
```
