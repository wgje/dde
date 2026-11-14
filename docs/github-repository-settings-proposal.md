# GitHub 仓库设置建议

> 本文是审阅清单，不代表任何在线设置已经更改。观察日期：2026-11-14。仓库：`wgje/dde`（公开仓库）。

## 当前已核实状态

- 默认分支：`main`；仓库描述为空；Topics 为空；Homepage 已设置。
- Issues、Projects、Wiki 已启用；Discussions 未启用；仓库未归档。
- 当前可见 Issue 标签共 9 个：`bug`、`documentation`、`duplicate`、`enhancement`、`good first issue`、`help wanted`、`invalid`、`question`、`wontfix`。
- GitHub 私密漏洞报告已于 2026-11-14 启用：仓库设置页显示保存成功且操作按钮变为“Disable private vulnerability reporting”；随后官方 REST 状态读取返回 `enabled: true`。未读取任何 Secret 值。
- 公开的 main branch rule evaluation 和仓库 Rulesets 列表返回空结果。经典 branch-protection 与 Actions permissions 端点需要认证；组织级规则、权限、环境保护要求均未据此确认。
- 仓库有 7 个 Environment；本次只核对数量，未读取环境配置或任何 Secret 值。

## 建议的发现信息

### Repository description（建议文案）

`Offline-first personal workspace for notes, task planning, visual flows, and focused work.`

描述强调当前产品定位，不承诺多端同步无损收敛、恢复闭环或未验证的可靠性指标。

### Topics（建议候选）

`task-management`、`personal-productivity`、`offline-first`、`angular`、`typescript`、`pwa`、`flowchart`、`android`、`supabase`。

这些 Topics 是检索建议，不是现有标签；由维护者审阅后再选择应用。

## 分类标签建议

保留 GitHub 默认标签，不批量改名或删除。工作类型继续复用 `bug`、`enhancement`、`documentation`；如维护者认为统计有价值，再考虑增加 `maintenance`。

为按能力检索，可另行评估以下 `area:` 标签：

- `area:text`、`area:flow`、`area:focus`、`area:parking`、`area:android`
- `area:offline-sync`、`area:data-safety`、`area:auth`
- `area:infrastructure`、`area:developer-tooling`

标签只提供分类，不代表 owner、排期、支持承诺或功能状态。在线新增标签需在 PR 审阅后单独执行并读回验证。

## 安全与治理待办

1. GitHub 私密漏洞报告已启用，并新增 [`SECURITY.md`](../SECURITY.md) 说明报告入口与披露边界。维护团队仍需确保有人关注 GitHub 私密报告通知；目前未承诺响应时限或漏洞赏金。
2. 用已授权账号复核 main 分支保护/Rulesets、Actions 权限、7 个 Environment 的审批与分支限制；只记录配置状态，不导出或展示 Secret 值。
3. 当前根目录未发现 `LICENSE`，且 `package.json` 未声明 `license`；在维护者决定前，不要向贡献者暗示已授予某种开放源码许可。
4. 审阅通过后，分别记录仓库描述/Topics/标签/安全设置的修改前后读回。PR 不会自动改变 GitHub Settings。

## 非本次动作

本次维护动作启用了 GitHub 私密漏洞报告，并通过设置页与只读 API 状态读回确认；PR 文档补充了状态及报告流程。除此之外，没有修改标签、分支规则、Actions 权限、Environment、Secret 或部署。
