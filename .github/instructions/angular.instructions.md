---
description: "Angular 19 项目级编码规范（Signals + standalone + OnPush）"
applyTo: "src/**/*.ts,src/**/*.html,src/**/*.scss,src/**/*.css"
---

# Angular Development Instructions (NanoFlow)

## 目标
- 产出可维护、可测试、与现有架构一致的 Angular 19 代码。
- 保持与 `AGENTS.md`、`.github/copilot-instructions.md` 一致，不新增冲突规则。

## 必须遵守

### 组件与模板
- 默认 `standalone: true`。
- 默认 `ChangeDetectionStrategy.OnPush`。
- Angular 19 优先函数式 API：`input()`、`output()`、`viewChild()`、`viewChildren()`。
- 模板优先使用 `@if`、`@for`、`@defer`。
- 模板中避免调用高成本函数，列表渲染必须提供稳定追踪键。

### 依赖注入
- 使用 `inject()`。
- 禁止 `inject(StoreService)`，直接注入具体子服务。

### 状态管理
- 使用 Signals：`signal()`、`computed()`、`effect()`。
- 保持扁平状态结构，优先 `Map<string, Entity>` + 辅助索引。
- 避免把业务状态塞入深层嵌套对象。

### 类型与错误处理
- TypeScript 严格类型，优先 `unknown` + 类型守卫，避免 `any`。
- 业务返回优先 Result Pattern（`success/failure`）。
- Supabase 相关错误统一走 `supabaseErrorToError()`。

## 项目特定规则
- 离线优先：先本地写入，再后台同步。
- 同步冲突遵循 LWW，涉及同步的查询不得漏掉关键字段（如 `content`）。
- 手机默认 Text 视图，Flow 图按需 `@defer`。
- GoJS 不允许 `visibility:hidden` 持有实例，必须销毁/重建。

## 测试要求
- 新增或修改逻辑时，补齐同目录 Vitest 测试。
- 影响交互路径时，补充 Playwright 用例或明确记录未覆盖风险。
