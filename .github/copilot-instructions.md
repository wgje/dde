# NanoFlow Copilot Instructions

> 适用范围：VS Code GitHub Copilot 全局工作区指令。
> 目标：在不丢失 NanoFlow 核心理念的前提下，产出可落地、可验证、最小风险的代码改动。

## 指令优先级（仓库内）

- 本文件是全局默认指令。
- `AGENTS.md` 提供 Coding Agent 的执行流程与验收门禁。
- `.github/CUSTOMIZATION_MAP.md` 是聊天定制文件入口；维护 instructions / skills / agents 时先读它。
- `.github/instructions/*.instructions.md` 仅作为文件类型补充。
- 若出现冲突，Hard Rules 以 `AGENTS.md §5` 为准；本文件只保留 quick reference。

## 项目核心理念（不可丢失）

- 不造轮子：优先复用现有服务、配置、工具链。
- 同步模型：Supabase + 增量同步 + LWW（Last-Write-Wins）。
- ID 策略：客户端 `crypto.randomUUID()` 生成所有业务实体 ID。
- 离线优先：IndexedDB 本地先写，后台异步同步，失败进入 RetryQueue。
- 状态管理：Angular Signals 为响应式状态主干；允许 RxJS Observable 处理事件流/HTTP，但禁止 NgRx 等 RxJS Store 类全局状态库。

## Hard Rules（权威定义）

> **单事实源**：Hard Rules 的权威定义在 [AGENTS.md](../AGENTS.md) 的 §5 中维护。
> 本节提供快速清单，如有冲突以 `AGENTS.md` 为准。

**清单**：
1. **ID 策略** — 客户端 `crypto.randomUUID()`，禁止自增/临时 ID/ID 映射转换。
2. **Offline-first** — IndexedDB 先写 + 增量拉取 + 3s 防抖 + RetryQueue；LWW 冲突策略。
3. **GoJS（移动端）** — Text 默认视图；Flow 图 `@defer` 懒加载；销毁/重建，禁止 `visibility:hidden` 保活。
4. **树遍历** — 仅迭代；深度上限 `MAX_SUBTREE_DEPTH = 100`。
5. **依赖注入** — 直接注入具体 Store（`TaskStore`/`ProjectStore`/`ConnectionStore`）或具体子服务；禁止新建「门面 Store」聚合类。

> 具体字段、实现细节、历史背景、缓解措施、常见陷阱参见 `AGENTS.md §5-§7`。

## 技术基线

- Angular `19.2.x`：`standalone: true` + `ChangeDetectionStrategy.OnPush`。
- TypeScript `5.8.x`：严格类型，优先 `unknown` + 类型守卫。
- Supabase `2.84+`：认证、数据库、Storage、Edge Functions。
- GoJS `3.1.x`：流程图渲染。
- Vitest `4.0.x` + Playwright `1.48+`：测试。

## 代码实现约定

- 优先修改现有服务，不平行新增重复能力。
- 状态结构保持扁平：`Map<string, Entity>` + 二级索引映射。
- 关键字段不可漏查：同步查询必须包含 `content`。
- 错误处理使用 Result Pattern：`success(...)` / `failure(...)`。
- Supabase 错误统一通过 `supabaseErrorToError()` 转换。
- 注释语言：中文解释业务逻辑；标识符保持英文。

### 代码尺寸与复杂度（ESLint 已落位）

以下限额由 `eslint.config.js` 以 `warn` 级别强制，AGENTS.md §12 的自律条款：

- `max-lines: 800`（单文件，跳过空行与注释）
- `max-lines-per-function: 50`（跳过空行与注释，IIFE 不算）
- `max-depth: 4`
- `complexity: 20`

**已超限的历史文件**：不要求一次性清零，但新增代码不得继续加码。抽离时优先沿业务边界拆分成独立 `@Injectable({ providedIn: 'root' })` 服务，组件内保留同名 delegate 方法以维持既有 spec 合约（参考 2026-04-16 `FocusModePreloadService` / `FocusToolsLoaderService` 抽离范式）。

### 超时与空闲调度常量化

禁止在业务代码里使用裸 `setTimeout(fn, 1200)` / `setTimeout(fn, 5000)` 这类魔数。统一走：

- `TIMEOUT_CONFIG.*`（QUICK / STANDARD / HEAVY / UPLOAD / REALTIME）
- `IDLE_SCHEDULE_CONFIG.*`（SHORT_MS / STANDARD_MS / LONG_MS）—— `requestIdleCallback` 的 fallback 超时
- `SUPABASE_CLIENT_FETCH_MAX_MS` —— Supabase 客户端全局 fetch 兜底超时

UI 层瞬时动画/toast 常量（例如 300ms highlight、3000ms 复制成功提示）可保留为组件内部 `const FOO_MS = ...`，但**不得复制粘贴**，必须命名化。

## 安全与合规

- API Key 仅存于 Supabase Secrets，禁止前端硬编码。
- 所有数据表启用 RLS。
- 输入做校验和消毒；Markdown 渲染走 XSS 防护链路。
- 文件上传必须经过类型校验与病毒扫描。

## 性能要求

- 增量同步替代全量拉取。
- 按需懒加载：GoJS、模态框、Sentry。
- 避免 `SELECT *`，只取必要字段。
- 目标指标：FCP < 1.5s，TTI < 3s，main bundle < 500KB。

## 测试与验证

- 测试金字塔：Unit（多）-> Integration（边界）-> E2E（关键路径）。
- 至少运行与改动范围匹配的测试。
- 涉及同步、离线、GoJS、专注模式改动时，必须补充对应验证。

## 常用命令

```bash
npm start
npm run build
npm run test:run
npm run test:run:services
npm run test:run:components
npm run test:e2e
npm run lint
npm run db:types
```

## 输出要求（Copilot）

- 给出可直接应用的代码，不只给概念。
- 先保证正确性和数据一致性，再优化可读性与性能。
- 涉及架构取舍时，明确说明风险、权衡和回滚点。
