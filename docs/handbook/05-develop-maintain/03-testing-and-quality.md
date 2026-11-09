---
title: 测试与质量
status: canonical
audience: contributor, maintainer, ai-agent
last_verified: 2026-07-26
category: develop-maintain
source_paths:
  - README.md
  - package.json
  - scripts/run-test-matrix.cjs
  - scripts/run-health-gate.cjs
  - vitest.config.mts
  - playwright.config.ts
  - scripts/validate-context7-docs.cjs
  - scripts/contracts/check-human-docs-coupled-changes.cjs
  - src/tests/scripts/check-human-docs-coupled-changes.spec.ts
  - scripts/contracts/check-retryqueue-durable-add.cjs
  - src/tests/scripts/check-retryqueue-durable-add.spec.ts
---

# 测试与质量

先运行能直接证明本次改动的最小验证，再在共享契约或高风险路径受影响时扩大范围。一个组件规格通过不能证明 migration 安全；一个文档校验通过也不能证明应用流程正确。测试的职责是回答具体断言，而不是制造一条看起来很长的绿色命令记录。

## 本文内容

- [测试层级](#测试层级)
- [常用命令](#常用命令)
- [按改动选择门禁](#按改动选择门禁)
- [实用验证顺序](#实用验证顺序)
- [仓库健康门禁](#仓库健康门禁)
- [文档门禁](#文档门禁)
- [性能门禁](#性能门禁)
- [怎样理解失败结果](#怎样理解失败结果)
- [下一步](#下一步)

## 测试层级

| 层级 | 用途 |
| --- | --- |
| 单元与纯函数测试 | 快速验证小范围逻辑 |
| 服务测试 | 验证业务服务与同步/服务边界 |
| 组件测试 | 验证 Angular 组件行为 |
| E2E 测试 | 验证关键浏览器工作流 |
| 契约测试 | 验证密钥、文档耦合、Flow 约束等仓库不变量 |
| 性能门禁 | 验证启动、bundle、字体和部署产物预期 |

这些层级彼此互补。先选择能直接覆盖改动行为的最小命令，再为改动触及的共享边界追加契约、质量或性能门禁。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run test:run:pure` | 纯逻辑改动 |
| `npm run test:run:services` | 服务层改动 |
| `npm run test:run:components` | 组件改动 |
| `npm run test:run` | 本地默认测试矩阵 |
| `npm run test:run:verify` | 更广的本地测试矩阵 |
| `npm run test:e2e` | 浏览器工作流 |
| `npm run test:contract-specs` | 不运行完整矩阵的契约/规格套件 |
| `npm run test:contracts` | 在测试矩阵前运行更广的契约、密钥审计、编码与耦合检查 |
| `npm run quality:guard:retryqueue-durable-add` | 拒绝生产代码直接调用未等待持久化确认的 `RetryQueueService.add()` |
| `npm run health` | 大型重构前的标准仓库健康门禁 |
| `npm run health:strict` | 技术债收敛和阶段验收使用的收紧健康门禁 |
| `npm run health:full` | 运行完整本地测试和 Playwright E2E 的慢速健康门禁 |
| `npm run lint` | 源码 lint |
| `npm run quality:baseline` | 代码健康基线 |
| `npm run perf:guard` | 启动与性能门禁 |

宽泛矩阵通常更慢，也会更多地受现有脏工作树影响。不要用它替代能证明你声称的具体分支的聚焦测试；同样，不要用一条聚焦绿色测试证明跨模块的构建、迁移或部署已经就绪。

`npm run test:contracts` 会同时执行两条队列持久化边界：`quality:guard:actionqueue-durable-enqueue` 阻止生产代码绕过 ActionQueue 的 durable enqueue API，`quality:guard:retryqueue-durable-add` 阻止生产代码直接使用 RetryQueue 的同步兼容 API。后者要求生产入队路径使用 `RetryQueueService.addDurably()` 或 `RetryQueueEnqueueService.addToRetryQueueDurably()`，只有持久化确认成功后才能把写入报告为已接受；对应 fixture 规格也包含在 `test:contract-specs` 中。

## 按改动选择门禁

| 改动 | 最小有意义的验证 |
| --- | --- |
| 只改 Markdown 手册 | `npm run docs:human:validate` |
| 改 Context7 文档 | `npm run docs:context7:validate` |
| 服务逻辑 | 相关规格；范围较广时加 `npm run test:run:services` |
| 组件 UI | 相关规格；范围较广时加组件测试分组 |
| 同步、离线或持久化 | 定向规格，加服务分组或完整本地矩阵 |
| Supabase migration | migration 审查、生成类型、相关契约测试 |
| Flow/GoJS 生命周期 | 相关 Flow 规格与移动端行为检查 |

同一改动命中多行时，每行的最小验证都要做。例如新增附件上传状态，需要定向服务/组件测试、相关同步/队列契约，以及用户可见工作流变化时对应的真人手册门禁。

## 实用验证顺序

按下面顺序进行常规改动验证：

1. **写清断言。** 指出改的是用户流程、服务不变量、数据库 schema、部署产物，还是纯文档。
2. **运行窄证明。** 执行如果断言错误就应失败的具体规格、脚本或复现。
3. **补充耦合门禁。** 改动涉及文档、密钥、migration、性能或共享契约时追加对应门禁。
4. **按影响面扩大。** 共享边界才使用服务/组件分组、`test:contract-specs`、`health` 或 E2E。
5. **完整阅读结果。** 记录命令、退出码、失败数量，以及仍存失败是否能证明与当前 diff 无关。

修改 Markdown 手册并调整覆盖映射时，一个实用顺序是：

```bash
npx vitest run --config vitest.config.mts src/tests/scripts/check-human-docs-coupled-changes.spec.ts
npm run docs:validate
```

产品行为改动不能停在这里。覆盖门禁只证明实现路径和一篇手册同时变化，并不证明实现本身正确。

## 仓库健康门禁

大型重构或 agent 主导的结构调整前运行 `npm run health`，判断当前仓库是否适合继续引入变更。它会运行既有质量基线、性能门禁、文档校验、CodeGraph adapter 门禁、显式 TypeScript typecheck 和默认本地测试矩阵。

技术债收敛或阶段验收使用 `npm run health:strict`。它以 `quality:baseline:ratchet` 替换质量快照，并扩展为 `test:run:verify`；当前 ratchet 或性能失败仍是失败，不能当作警告忽略。

可以接受慢速完整答案时，例如发布准备、重大跨模块改动或夜间清理，使用 `npm run health:full`。它保留严格前半段，再运行 `test:run:full` 和 Playwright E2E。

## 文档门禁

真人手册：

```bash
npm run docs:human:validate
```

Context7 文档：

```bash
npm run docs:context7:validate
```

组合文档检查：

```bash
npm run docs:validate
```

修改 `docs/handbook/change-coverage.json` 时，除校验外还要运行聚焦契约：

```bash
npx vitest run --config vitest.config.mts src/tests/scripts/check-human-docs-coupled-changes.spec.ts
```

该测试必须覆盖契约的两面：实现路径没有相应手册时被拒绝；同一改动包含正确手册页时被接受。具体映射工作流见 [文档维护](04-documentation-maintenance.md)。

## 性能门禁

改动影响启动、应用壳加载、Flow 加载、字体、Supabase readiness 或部署产物形状时，运行：

```bash
npm run perf:guard
```

该门禁仍红时，不要把性能工作描述为完成。

## 怎样理解失败结果

非零退出是需要分类的证据，不是盲目重跑命令的理由。

| 失败类型 | 第一动作 | 不要这样做 |
| --- | --- | --- |
| 聚焦规格失败 | 阅读断言和改变过的调用链，复现最小失败 | 还没理解第一个失败就扩展到全量矩阵 |
| 文档校验失败 | 修复报告页面的 front matter、源码依据、目录条目或链接 | 因为 Markdown 本地能渲染就绕过校验 |
| 真人文档耦合失败 | 同一工作项更新映射文章，或用测试修正过宽/过期路由 | 为满足门禁添加无关概览页 |
| 密钥或编码审计失败 | 在分享输出前停止并检查精确路径或损坏内容 | 把疑似凭据粘贴到聊天、issue 或日志 |
| migration/type 契约失败 | 一起检查 schema 变化和生成类型 | 只手改一边并假定数据库会自动调和 |
| 健康或性能门禁失败 | 找到被点名的子门禁，并报告它仍是红色 | 因为窄测试通过就宣布完成 |
| 已知无关失败仍存在 | 保留精确命令输出和文件路径，再证明本次定向验证通过 | 隐藏它、重写历史，或无证据归因到当前 diff |

脏工作树中不要推断每个红色结果都由你的补丁造成。将失败路径与当前 diff 比对，运行本次改动的窄证明，并清楚区分已验证通过与仍未解决但无关的失败。

## 下一步

- 用户可见行为变化时，用 [文档维护](04-documentation-maintenance.md) 同步真人文档和覆盖映射。
- 只在部署后才复现的门禁或行为问题，读 [生产排障](../04-deploy-operate/04-production-troubleshooting.md)。
