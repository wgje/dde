# NanoFlow - Global Agent Instructions

> 最后更新：2026-02-10
> 说明：本文件按 VS Code 官方建议组织为「仓库上下文 + 编码标准 + 测试与验证流程」执行手册。

## 1. 目标与适用范围

- 适用对象：VS Code Copilot Coding Agent 及同类代码代理。
- 目标：在保持 NanoFlow 既有架构理念下，完成可交付、可验证、可回滚的代码改动。
- 原则：优先最小改动；不破坏同步一致性、离线可靠性、移动端可用性。

## 2. 指令层级（仓库内）

- `AGENTS.md`：Agent 执行手册与验收门禁。
- `.github/copilot-instructions.md`：全局默认编码规则。
- `.github/instructions/*.instructions.md`：按文件类型补充。
- 冲突处理：以本文件与 `.github/copilot-instructions.md` 的 Hard Rules 为准。

## 3. 技术栈基线

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.2.x | Signals + 独立组件 + OnPush |
| Supabase | 2.84+ | Auth + PostgreSQL + Storage + Edge Functions |
| GoJS | 3.1.x | Flow 图渲染 |
| Groq | whisper-large-v3 | 语音转写（经 Edge Function 代理） |
| Sentry | 10.32+ | 错误监控 + 会话回放 |
| Vitest | 4.0.x | 单元/服务/组件测试 |
| Playwright | 1.48+ | E2E 测试 |
| TypeScript | 5.8.x | 严格类型 |

## 4. 核心哲学（必须保留）

- 不要造轮子：优先复用现有服务、配置和工具。
- 同步：Supabase + 增量拉取 + LWW（Last-Write-Wins）。
- ID：实体 ID 由客户端 `crypto.randomUUID()` 生成。
- 离线：PWA + IndexedDB（idb-keyval）先写后同步。
- 监控：Sentry 按需懒加载。
- 状态：Angular Signals，避免 RxJS Store 化。

## 5. Hard Rules（不可违反）

### 5.1 ID 策略
- 所有实体 ID 必须客户端生成：`crypto.randomUUID()`。
- 禁止数据库自增 ID、临时 ID、同步时 ID 映射转换。

### 5.2 Offline-first 数据流
- 读路径：`IndexedDB -> 后台增量拉取(updated_at > last_sync_time)`。
- 写路径：本地写入 + UI 即时更新 -> 3s 防抖推送 -> 失败进入 RetryQueue。
- 冲突策略：LWW。
- 体验目标：点击立即生效，无阻塞 loading；断网可写，联网自动补同步。

### 5.3 GoJS（移动端）
- 手机默认 Text 视图。
- Flow 图必须按需 `@defer` 懒加载。
- 禁止 `visibility:hidden` 持有图实例；必须销毁/重建。

### 5.4 树遍历
- 仅允许迭代算法。
- 深度上限：`FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100`。

### 5.5 依赖注入
- 禁止 `inject(StoreService)`。
- 必须直接注入具体子服务（StoreService 仅兼容保留）。

## 6. 核心架构速览

### 6.1 状态存储（Signals）
`src/app/core/state/stores.ts`
- `tasksMap: Map<string, Task>`（O(1) 查找）
- `tasksByProject: Map<string, Set<string>>`（项目索引）
- `connectionsMap: Map<string, Connection>`（连接索引）
- `projectsMap: Map<string, Project>`（项目索引）

要求：结构扁平、避免深层嵌套，统一使用 `signal()/computed()/effect()`。

### 6.2 同步主干
- `SimpleSyncService`：同步核心（LWW + RetryQueue + 增量拉取）。
- 子服务位于 `src/app/core/services/sync/`：`batch-sync`、`retry-queue`、`realtime-polling`、`tombstone` 等。

### 6.3 任务操作主干
- `TaskOperationAdapterService`：任务操作与撤销协调。
- 任务核心服务位于 `src/services/`：`task-operation`、`task-repository`、`task-creation`、`task-move` 等。

### 6.4 GoJS 事件解耦
`FlowTemplateService -> flow-template-events.ts -> FlowEventService`

## 7. 数据模型约束（实现时必须检查）

### 7.1 Task
- `id`：客户端 UUID。
- `updatedAt`：LWW 冲突判定关键字段。
- `content`：同步查询不可漏字段。
- `deletedAt`：软删除标记。

### 7.2 Connection / Attachment / Project
- 均使用字符串 ID。
- 软删除字段统一 `deletedAt/deleted_at` 语义。
- `Project.updatedAt` 参与同步。

### 7.3 Focus 模式
- `BlackBoxEntry.updatedAt`：LWW 关键字段。
- 每日语音额度：`FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA = 50`。
- 打盹上限：`FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY = 3`。

## 8. 错误处理与可观测性

- 统一 Result Pattern：
  - `success(data)`
  - `failure(ErrorCodes.XXX, message)`
- Supabase 错误必须通过 `supabaseErrorToError()` 转换。
- GlobalErrorHandler 分级：`SILENT` / `NOTIFY` / `RECOVERABLE` / `FATAL`。
- 关键错误上报 Sentry；Sentry 采用懒加载。

## 9. 关键配置基线

| 配置 | 值 |
|------|-----|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | `3000ms` |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | `30000ms` |
| `SYNC_CONFIG.POLLING_INTERVAL` | `300000ms` |
| `SYNC_CONFIG.POLLING_ACTIVE_INTERVAL` | `60000ms` |
| `SYNC_CONFIG.REALTIME_ENABLED` | `false` |
| `TIMEOUT_CONFIG.QUICK` | `5000ms` |
| `TIMEOUT_CONFIG.STANDARD` | `10000ms` |
| `TIMEOUT_CONFIG.HEAVY` | `30000ms` |
| `TIMEOUT_CONFIG.UPLOAD` | `60000ms` |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | `100` |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | `'local-user'` |
| `GUARD_CONFIG.SESSION_CHECK_TIMEOUT` | `2000ms` |
| `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY` | `3` |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA` | `50` |

## 10. Agent 执行流程（标准作业）

1. 读取上下文
- 先定位改动边界：功能、数据流、受影响服务。
- 必读同目录测试与调用链，避免局部修复破坏全局。

2. 设计改动
- 优先复用现有服务与配置。
- 明确同步、离线、冲突、移动端 GoJS 生命周期影响。

3. 实施改动
- 采用最小可回滚变更。
- 保持现有命名和分层，不引入平行抽象。

4. 自检与测试
- 至少运行与改动范围匹配的测试。
- 同步/离线/GoJS/专注模式改动需额外场景验证。

5. 交付说明
- 说明改了什么、为何这样改、潜在风险与回滚点。

## 11. 代码规范

- 中文注释解释业务意图；英文标识符。
- `standalone: true` + `OnPush`。
- Angular 19 优先 `input()`, `output()`, `viewChild()` 等函数式 API。
- 严格类型：用 `unknown` + 类型守卫替代 `any`。
- 测试同目录：`*.service.ts -> *.service.spec.ts`。
- 规模约束：单文件建议 200-400 行（最大 800），函数 <= 50 行，嵌套 <= 4 层。

## 12. 安全规则

1. API Key 只允许存储于 Supabase Secrets，禁止前端硬编码。
2. 所有表启用 RLS，数据按 `user_id` 隔离。
3. 输入必须校验与消毒；Markdown 渲染做 XSS 防护。
4. 文件上传必须经过类型验证与病毒扫描。
5. Edge Function 代理第三方 API，前端不直连敏感凭证。

## 13. 测试策略与命令

### 13.1 测试金字塔
`E2E(少量关键路径) -> Integration(服务边界) -> Unit(大量快速)`

### 13.2 常用命令

```bash
# 开发
npm start
npm run build
npm run build:dev

# 测试
npm run test
npm run test:run
npm run test:run:pure
npm run test:run:services
npm run test:run:components
npm run test:e2e
npm run test:e2e:ui

# 质量
npm run lint
npm run lint:fix
npx knip

# 数据库类型
npm run db:types
```

## 14. 目录导航（精简）

```text
src/
  app/core/                 # 核心单例（sync/state/shell）
  app/features/flow/        # GoJS 流程图
  app/features/text/        # 移动端默认文本视图
  app/features/focus/       # 专注模式（gate/spotlight/strata/black-box）
  services/                 # 业务服务层（任务/项目/同步/基础设施）
  config/                   # 配置常量
  models/                   # 数据模型
  utils/                    # 工具函数（Result、error 转换等）

supabase/functions/         # Edge Functions
supabase/migrations/        # 数据库迁移
```

## 15. 常见陷阱与规避

| 陷阱 | 规避 |
|------|------|
| 全量同步流量激增 | 严格使用增量条件 `updated_at > last_sync_time` |
| GoJS 内存泄漏 | 视图切换时 `diagram.clear()` + 解绑全部监听 |
| 递归爆栈 | 迭代遍历 + 深度限制 100 |
| 离线写入丢失 | 失败操作必须进入 RetryQueue |
| Sentry 上报信息不完整 | 先做 `supabaseErrorToError()` 统一转换 |
| Edge Function API Key 泄露 | `supabase secrets set` 管理密钥 |
| iOS Safari 不支持 webm | 运行时检测 mimeType，回退 mp4 |
| 同步时 `content` 丢失覆盖 | 查询字段必须包含 `content` |

## 16. 完成定义（Definition of Done）

- 所有 Hard Rules 仍成立。
- 关键路径（同步、离线、GoJS、专注模式）无回归。
- 对应层级测试通过，或明确说明未执行项与原因。
- 文档/类型/配置变更已同步更新。
- 提交说明包含风险点和回滚策略。
