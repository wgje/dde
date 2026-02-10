---
description: "Vitest + Playwright 测试规范与稳定性要求"
applyTo: "**/*.spec.ts,**/*.test.ts,tests/**,e2e/**"
---

# Testing Standards (NanoFlow)

## 测试金字塔
- Unit：覆盖核心逻辑与边界条件（数量最多）。
- Integration：覆盖服务边界与关键协作。
- E2E：覆盖关键用户路径（数量少但稳定）。

## 工具与配置
- Vitest：`vitest.config.mts`、`vitest.pure.config.mts`、`vitest.services.config.mts`、`vitest.components.config.mts`。
- Playwright：`playwright.config.ts`。

## 编写要求
- 测试文件与实现同目录优先（如 `*.service.ts -> *.service.spec.ts`）。
- 使用 `Arrange -> Act -> Assert` 结构。
- Mock 只用于隔离外部依赖，不掩盖真实业务逻辑。

## E2E 稳定性
- 选择器优先级：`data-testid` -> 语义角色 -> 文本。
- 禁止固定睡眠等待（如 `waitForTimeout`）作为主等待策略。
- 使用可观测状态等待（元素出现、接口完成、URL 变化）。

## 与项目理念对齐的必测项
- 同步与离线写入：断网写入、恢复后补同步。
- GoJS 生命周期：切换视图后无残留监听/实例。
- LWW 冲突处理：`updatedAt` 新值覆盖旧值。
- 错误转换：Supabase 错误可被统一映射并正确分级。

## 提交前最低验证
- 改动涉及纯逻辑：至少运行对应 Vitest 子集。
- 改动涉及 UI 关键路径：至少运行相关 E2E 用例。
- 若未执行测试，必须在交付说明中明确原因与风险。
