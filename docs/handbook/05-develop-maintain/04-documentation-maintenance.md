---
title: 文档维护
status: canonical
audience: maintainer, ai-agent
last_verified: 2026-07-15
category: develop-maintain
source_paths:
  - docs/README.md
  - docs/handbook/catalog.json
  - docs/handbook/change-coverage.json
  - docs/context7/README.md
  - scripts/validate-context7-docs.cjs
  - scripts/contracts/check-human-docs-coupled-changes.cjs
  - package.json
---

# 文档维护

NanoFlow 文档有两层，必须分别维护并分别验证。中文手册解决“真人如何使用、判断状态、恢复和部署”；Context7 解决“维护者和检索工具如何定位源码事实与契约”。同一个主题可以同时存在于两层，但不应把一层的写法机械复制到另一层。

## 本文内容

- [真人手册与 Context7 的区别](#真人手册与-context7-的区别)
- [什么时候更新真人手册](#什么时候更新真人手册)
- [什么时候更新 Context7](#什么时候更新-context7)
- [新增手册文章](#新增手册文章)
- [让真人文档跟随产品变化](#让真人文档跟随产品变化)
- [新增或调整覆盖路由](#新增或调整覆盖路由)
- [运行文档门禁](#运行文档门禁)
- [下一步](#下一步)

## 真人手册与 Context7 的区别

| 层 | 路径 | 受众 | 写法 |
| --- | --- | --- | --- |
| 真人手册 | `docs/handbook` | 使用者、操作者、贡献者 | 解释性强、可执行、易读，写清步骤、预期状态、恢复和误解 |
| Context7 语料 | `docs/context7` | AI agent、检索工具、维护者 | 精确、能追溯源码、适合机器检索 |

同一主题可以出现在两层，但写作目标不同。比如“附件上传失败”：手册说明用户看到了什么、先保留什么、怎样恢复；Context7 说明服务、队列、Storage 和函数的源码路径及契约。

## 什么时候更新真人手册

当改动影响以下任意内容时，更新 `docs/handbook`：

- 用户工作流；
- 上手或首次配置；
- 部署或运维步骤；
- 恢复行为；
- 安全预期；
- 贡献者环境准备；
- 验证命令。

一篇合格的文章不仅说明“功能存在”，还应让读者知道何时使用、操作后的正常状态、遇到异常先保护什么、以及下一篇应读什么。

## 什么时候更新 Context7

当改动影响以下任意内容时，更新 `docs/context7`：

- 源码路径；
- 模型字段；
- 服务或所有权边界；
- 同步契约；
- 安全契约；
- API 或 Edge Function 引用；
- 机器检索路由。

不要把 Context7 当成泛泛的产品说明。它应帮助维护者或 agent 在不猜测的情况下找到事实源、关键服务、模型和验证规则。

## 新增手册文章

1. 选择已有分类；只有读者确实需要独立工作流时才新建分类。
2. 在该分类下创建 Markdown 文件。
3. 添加必需 front matter。
4. 加入 `## 本文内容` 目录。
5. 链接相邻文章，并写清读完后下一步去哪里。
6. 将页面加入 `docs/handbook/catalog.json`。
7. 运行校验。

必需的 front matter 结构如下：

```yaml
---
title: 页面标题
status: canonical
audience: user, operator
last_verified: 2026-07-15
category: use-nanoflow
source_paths:
  - README.md
---
```

`source_paths` 不是装饰。它告诉后来维护者此页的事实来源；产品实现变动时，也让人知道该页是否需要重新核对。

## 让真人文档跟随产品变化

`docs/handbook/change-coverage.json` 是从用户可见实现区域到相应中文手册文章的事实来源映射。每个路由声明：

- 实现触发 glob，例如 `src/app/features/text/**`；
- 行为变化时必须同时改变的一篇或多篇真人手册；
- 一句中文说明，解释为什么此实现区域对读者可见。

`scripts/contracts/check-human-docs-coupled-changes.cjs` 会读取该映射。当已修改的生产文件命中路由时，同一变更必须包含映射手册页之一。纯测试文件刻意不触发这个要求，因为测试重构本身不改变用户行为。

新增用户可见功能时，先添加或收窄路由，再依赖它。映射的页面应解释工作流、预期状态、恢复路径，以及读者能观察到的设备或云端服务边界。

不要用手册根首页、分类首页或无关概览页满足门禁。读者应能打开被映射的专题文章，在不反向阅读 UI 或源码的情况下完成改变后的流程。

## 新增或调整覆盖路由

把一个路由当作可执行文档契约，而不是目录条目。当生产改动会改变人怎样开始工作、输入数据、判断状态、从失败恢复、处理隐私或在设备间转移工作时，应添加路由。

1. 从实现边界开始，选择最窄、真正代表用户可见行为的生产路径。不要为显得全面而加入大目录。
2. 若已有 canonical 文章已经解释流程，复用最具体的页面；只有读者需要拼接无关流程时才建新页。
3. 在 `docs/handbook/change-coverage.json` 加入 `id`、明确中文说明、`triggers` 和必须更新的 `handbook` 页面路径。
4. 在 `src/tests/scripts/check-human-docs-coupled-changes.spec.ts` 添加两条契约测试：一条证明只有实现路径时会被拒绝，一条证明同时包含正确页面时会被接受。
5. 依赖更宽文档门禁前先运行聚焦 Vitest 文件。

两条断言应采用下面的结构：

```ts
it('blocks the behavior change when its handbook page is absent', () => {
  const result = runGuard(['src/path/to/user-visible-behavior.ts']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('route-id');
  expect(result.stderr).toContain('docs/handbook/category/page.md');
});

it('accepts the matching handbook page with the behavior change', () => {
  const result = runGuard([
    'src/path/to/user-visible-behavior.ts',
    'docs/handbook/category/page.md',
  ]);

  expect(result.status, String(result.stderr)).toBe(0);
  expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
});
```

测试不可省略。glob 拼写错误、过期路径或过宽路由都可能让门禁看起来存在，却没有保护真正的产品边界。

## 运行文档门禁

真人手册：

```bash
npm run docs:human:validate
```

包含真人手册变更耦合检查：

```bash
npm run docs:human:guard
```

修改覆盖映射时的聚焦契约：

```bash
npx vitest run --config vitest.config.mts src/tests/scripts/check-human-docs-coupled-changes.spec.ts
```

Context7 文档：

```bash
npm run docs:context7:validate
```

组合文档门禁：

```bash
npm run docs:validate
```

若一个行为变化同时影响读者流程和源码契约，两层文档应在同一工作项中更新。只要任一层门禁失败，就不要用另一层通过来宣称文档已完成。

## 下一步

- 用 [测试与质量](03-testing-and-quality.md) 为本次改动选择验证命令。
- 需要精确、可追溯的源码事实时，使用 [Context7 文档](../../context7/README.md)。
