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

