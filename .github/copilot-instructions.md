# NanoFlow Copilot Instructions

> 适用范围：VS Code GitHub Copilot 全局工作区指令。
> 目标：在不丢失 NanoFlow 核心理念的前提下，产出可落地、可验证、最小风险的代码改动。

## 指令优先级（仓库内）

- 本文件是全局默认指令。
- `AGENTS.md` 提供 Coding Agent 的执行流程与验收门禁。
- `.github/instructions/*.instructions.md` 仅作为文件类型补充。
- 若出现冲突，以本文件和 `AGENTS.md` 的硬规则为准。

## 项目核心理念（不可丢失）

- 不造轮子：优先复用现有服务、配置、工具链。
- 同步模型：Supabase + 增量同步 + LWW（Last-Write-Wins）。
- ID 策略：客户端 `crypto.randomUUID()` 生成所有业务实体 ID。
- 离线优先：IndexedDB 本地先写，后台异步同步，失败进入 RetryQueue。
- 状态管理：Angular Signals（非 RxJS Store）。

## Hard Rules

1. ID 规则
- 所有实体 ID 必须在客户端生成：`crypto.randomUUID()`。
- 禁止自增 ID、临时 ID、同步时做 ID 映射转换。

2. Offline-first 数据流
- 读取：`IndexedDB -> 后台增量拉取(updated_at > last_sync_time)`。
- 写入：本地先写 + UI 立即更新 -> 防抖推送（3s）-> 失败入 RetryQueue。
- 冲突：LWW。

3. GoJS（移动端）
- 手机默认 Text 视图，Flow 图按需 `@defer` 懒加载。
- 禁止 `visibility:hidden` 保活 GoJS，必须彻底销毁/重建。

4. 树操作
- 仅使用迭代算法。
- 必须遵守 `MAX_SUBTREE_DEPTH = 100`。

5. 依赖注入
- 禁止 `inject(StoreService)`。
- 必须直接注入具体子服务。

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
