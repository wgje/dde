# NanoFlow 文档中心

这里是 NanoFlow 的文档总入口。请先根据自己的身份选择入口，不要直接在 `docs/` 目录里随机打开历史计划文档。

NanoFlow 现在有两层长期维护的文档：

- **给使用者看的中文使用手册**：从 [handbook/index.md](handbook/index.md) 开始阅读，适合了解功能、上手操作、部署自己的实例、排查日常使用问题。
- **给 AI 与维护者检索的 Context7 文档**：从 [context7/index.md](context7/index.md) 开始使用，适合查源码路径、同步契约、模型字段、服务边界和验证规则。

## 先从这里开始

| 你想做什么 | 应该先读 |
| --- | --- |
| 第一次了解 NanoFlow 是什么 | [handbook/index.md](handbook/index.md) |
| 只想尽快把应用跑起来 | [handbook/01-get-started/01-quickstart.md](handbook/01-get-started/01-quickstart.md) |
| 不想配置云服务，只想本地使用 | [handbook/01-get-started/02-local-only-mode.md](handbook/01-get-started/02-local-only-mode.md) |
| 想跟着一步一步建立第一个项目 | [handbook/01-get-started/03-first-project.md](handbook/01-get-started/03-first-project.md) |
| 想配置登录、附件、跨设备同步 | [handbook/01-get-started/04-cloud-sync-setup.md](handbook/01-get-started/04-cloud-sync-setup.md) |
| 想知道文本视图、流程图、停泊坞和专注模式怎么用 | [handbook/02-use-nanoflow/index.md](handbook/02-use-nanoflow/index.md) |
| 担心数据丢失、同步冲突或隐私问题 | [handbook/03-data-sync-safety/index.md](handbook/03-data-sync-safety/index.md) |
| 想部署自己的私有实例 | [handbook/04-deploy-operate/01-private-deployment.md](handbook/04-deploy-operate/01-private-deployment.md) |
| 想查 AI/Context7 的机器可读资料 | [context7/README.md](context7/README.md) |

## 文档区域说明

| 区域 | 用途 | 适合谁 |
| --- | --- | --- |
| [handbook](handbook/index.md) | 中文使用手册：上手、功能、数据安全、部署运维 | 使用者、私有实例操作者 |
| [context7](context7/index.md) | 机器可读文档：源码路线、契约、参考、运行手册、校验规则 | AI Agent、维护者 |
| [handbook/05-develop-maintain](handbook/05-develop-maintain/index.md) | 维护者资料：开发环境、仓库地图、测试质量和文档维护 | 维护者、贡献者 |
| [superpowers/plans](superpowers/plans/) | Agent 执行计划与阶段性方案 | 维护者 |
| [archive](archive/README.md) | 历史审计、旧方案、遗留 SQL | 需要追溯背景的人 |

## 使用手册的阅读方式

如果你是普通使用者，建议按这个顺序读：

1. [快速开始](handbook/01-get-started/01-quickstart.md)：确认应用能在本机打开。
2. [本地离线模式](handbook/01-get-started/02-local-only-mode.md)：理解没有 Supabase 时哪些数据只在本机。
3. [第一个项目演练](handbook/01-get-started/03-first-project.md)：跟着创建项目、任务、停泊项和专注会话。
4. [使用 NanoFlow](handbook/02-use-nanoflow/index.md)：逐个理解文本视图、流程图、Parking Dock、Focus、Black Box、思源锚点和 Android 小组件。
5. [备份与恢复](handbook/03-data-sync-safety/03-backup-and-restore.md)：在正式放入重要数据前先读。

如果你要自己部署实例，建议按这个顺序读：

1. [云同步配置](handbook/01-get-started/04-cloud-sync-setup.md)。
2. [私有部署](handbook/04-deploy-operate/01-private-deployment.md)。
3. [Supabase 运维](handbook/04-deploy-operate/02-supabase-operations.md)。
4. [Edge Functions](handbook/04-deploy-operate/03-edge-functions.md)。
5. [生产排障](handbook/04-deploy-operate/04-production-troubleshooting.md)。

## 文档质量门禁

修改中文使用手册后运行：

```bash
npm run docs:human:validate
```

这个命令会检查：

- `docs/handbook/catalog.json` 是否覆盖所有手册页面；
- 页面 front matter 是否包含标题、受众、分类和源码依据；
- 中文用户页面是否真的以中文为主；
- 相对链接是否有效；
- 页面是否包含“本文内容”和“下一步”；
- 使用者页面是否有足够的正文长度，避免只写一个很薄的提纲。

修改全部文档后运行：

```bash
npm run docs:validate
```

这个组合门禁会同时检查 Context7 机器文档和中文使用手册。
