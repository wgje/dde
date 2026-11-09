# NanoFlow Agent Instructions

> 常驻项目合同；CodeGraph 机器合同见 `docs/codegraph-nanoflow-agent-contract.md`，运维说明见 `docs/codegraph-nanoflow-adaptation.md`。

## Repository context gate

- 代码、配置、调试、审查或实现任务在简短进度说明后，首个仓库事实动作必须使用 CodeGraph MCP。本仓库广泛上下文优先 `nanoflow_context_pack`，精确 NanoFlow 语义使用 `nanoflow_overlay_query`。
- `functions.exec` 返回 `Script running...` 仍在运行；下一步只能对同一 `cell_id` 等待明确终态。仅明确 timeout/transport/failure/unavailable 才触发 fallback，运行中禁止并行 fallback 或绕过检查。
- MCP 明确失败后下一事实动作必须是 `npm run codegraph:adapter:context -- --query "<query>" --json`；精确 overlay 可用 `npm run codegraph:overlay:query -- --query "<symbol-or-relation>" --skip-refresh`。两者失败后原生 `@colbymchenry/codegraph@1.5.0` 仅作 locator。
- MCP 与 adapter 都失败前禁止普通搜索、文件、git、Context7 或 web。建立 CodeGraph 事实后，外部框架/API/安全/数据库/同步/离线问题再用 Context7并精读定位文件。
- 项目 MCP 配置是 `D:\Code\dde\.codex\config.toml`；用户配置仅 fallback，`.vscode/mcp.json` 无效。wrapper/config 改后须 fresh adapter/wrapper 验证并重启 session。
- 写入前检查 bytes、`git status`、lease/barrier、CodeGraph freshness；保留并发改动，不越权 stage/commit/push/release/cleanup。

### Worker evidence contract

- Worker 必须分开报告请求设置与当前 turn 的有效运行设置。只有 `thread_settings_applied`、`turn_context` 或当前 App Server 响应等权威元数据存在时，才允许报告 `effective_model` 与 `effective_reasoning_effort`；不得从通用 Codex 系统文本、模型家族名、UI 标签或 model-switch warning 推断。
- `xhigh` 与 `max` 是不同值，禁止互相翻译或猜测。当前 turn 未暴露字段时必须报告 `UNVERIFIED` 及证据来源，禁止用泛称 `GPT-5` 代替实际模型。
- CodeGraph-first 必须直接调用已配置的 `nanoflow_context_pack`、`codegraph_explore` 或 `nanoflow_overlay_query`。`list_mcp_resources` 与 `list_mcp_resource_templates` 不是 CodeGraph 可用性探针；`resources=[]` 或 `resourceTemplates=[]` 只表示没有静态资源，不构成 MCP 失败。
- 只有符合 schema 的直接 CodeGraph 工具调用明确返回 MCP/tool/transport failure 时，才允许下一仓库事实动作使用规定的 adapter fallback。回执必须标明 `DIRECT_MCP` 或 `ADAPTER_FALLBACK`、精确工具/命令、status 和 failure class。

- Context7 为 deferred MCP：先探测精确 `mcp__context7__*` 并遵循 schema；参数无效不是 MCP failure。外部指南先 `resolve_library_id` 再 `query_docs`，各最多 3 次；纯本地原子报 `CONTEXT7: N/A`。

## Product priorities

- 优先最小、可回滚改动；复用现有服务、配置和工具，不引入平行抽象。
- 启动与移动端路径优先保证离线 Text 可立即编辑、Flow 秒开；网络、同步、诊断和 GoJS 不得阻塞编辑路径。
- 数据安全高于功能速度：必须保持数据可导出、状态可恢复、同步可重放、写入可解释。存在可能丢功能的歧义时先询问用户。

## 5. Hard Rules（不可违反）

### 5.1 ID 策略

- 所有实体 ID 必须客户端生成：`crypto.randomUUID()`。
- 禁止数据库自增 ID、临时 ID、同步时 ID 映射转换。

### 5.2 Offline-first 数据流

- 读路径：`IndexedDB -> 后台增量拉取(updated_at > last_sync_time)`。
- 写路径：本地写入 + UI 即时更新 -> 3s 防抖推送 -> 失败进入 RetryQueue。
- 冲突策略：LWW。
- 同步查询 tasks 选择字段必须包含 `content`；`FIELD_SELECT_CONFIG.*_FIELDS` 中面向 tasks 的字段列表禁止为了流量优化删除 `content`。
- 体验目标：点击立即生效，无阻塞 loading；断网可写，联网自动补同步。

### 5.3 GoJS（移动端）

- 手机默认 Text 视图。
- Flow 图必须按需 `@defer` 懒加载。
- 禁止 `visibility:hidden` 持有图实例；必须销毁/重建。

### 5.4 树遍历

- 仅允许迭代算法。
- 深度上限：`FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100`。

### 5.5 依赖注入

- 服务层直接注入具体 Store（`TaskStore` / `ProjectStore` / `ConnectionStore`）或具体子服务。
- 禁止引入新的门面 Store 聚合类。
- 历史 `StoreService` 已拆分移除；`services/` 直接从 `app/core/state/stores` 导入 Store。禁止恢复已删除的 `src/services/stores.ts` 过渡桥或反向引用 `app/core/services|shell`。

### 5.6 Personal Data Safety

- NanoFlow must preserve four guarantees:
  - Exportable: current local data, sync cursor, pending queue, and relevant metadata can be exported at any time.
  - Restorable: a valid export can restore the local working state without ID remapping.
  - Replayable: pending and recent sync actions can be replayed or inspected deterministically.
  - Explainable: the app can explain the latest write, including entity, operation, local timestamp, updatedAt baseline, queue/RPC result, conflict/LWW decision, and lastSyncTime effect.
- Do not change sync, migration, storage, or write paths unless tests preserve or improve these guarantees.
- Launch snapshots and project-list rows are metadata-only shells: use `ProjectStateService.setProjectsMetadataOnly()` and never full `setProjects()` before validated entity state exists.
- Before metadata sync writes an offline snapshot, entity arrays must be authoritative from hydration/local mutation or a validated owner-scoped durable snapshot with entity evidence. An empty snapshot does not prove remote emptiness; otherwise skip the write and do not advance the manifest watermark.
- Owner changes and forced teardown must clear `ProjectStore`, `TaskStore`, and `ConnectionStore` together through `ProjectStateService.clearData()`; `setProjects([])` is not an owner-isolation primitive.
- Startup snapshots fail closed before normalization: malformed structures, duplicate IDs, invalid references, or a task without string `content` rejects the whole candidate while preserving original bytes for export and diagnosis.
- `ProjectStore.tasks/connections` are possibly stale metadata shells. Rebuild entity arrays through `ProjectStateService.getProjectWithCurrentData()` / `getProjectsWithCurrentData()` or an authoritative projection; never write shell arrays back as replacement data.

## 9. 关键配置基线

| 配置 | 值 |
|---|---|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | `3000ms` |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | `30000ms` |
| `SYNC_CONFIG.POLLING_INTERVAL` | `600000ms` |
| `SYNC_CONFIG.POLLING_ACTIVE_INTERVAL` | `120000ms` |
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

## Implementation and verification

- Angular 19 使用 standalone + OnPush，优先函数式 `input()` / `output()` / query API；严格类型用 `unknown` + guard，禁止以 `any` 掩盖边界。
- API key 只进 Supabase Secrets；前端不得持有敏感凭证。表启用 RLS 并按 `user_id` 隔离；输入与 Markdown 渲染必须防注入/XSS。
- 测试与改动风险匹配：优先 focused spec，再跑相关类型检查、lint、`git diff --check`；同步/离线/GoJS/专注模式必须补场景验证。未运行项与原因要明确。
- 完成时分别报告：实际改动、验证为绿的范围、仍为红的门禁、风险/回滚点与剩余目标；窄测试通过不等于项目完成。
