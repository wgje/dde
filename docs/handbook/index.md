---
title: NanoFlow 使用手册
status: canonical
audience: user, operator
last_verified: 2026-06-13
category: root
source_paths:
  - README.md
  - docs/handbook/catalog.json
  - docs/context7/index.md
  - AGENTS.md
---

# NanoFlow 使用手册

NanoFlow 是一个离线优先的个人任务工作台。它不是团队协作平台，也不是单纯的待办清单，而是把任务树、流程图、任务停泊、专注模式、快速记录、思源知识锚点、备份恢复和可选云同步放在同一个 PWA 里的个人工作系统。

这套手册只服务一个目标：让真正使用 NanoFlow 的人能看懂每一个常见操作应该怎么做、为什么这样做、做完后如何确认结果、遇到异常时先检查哪里。

## 本文内容

- [应该先读哪一部分](#应该先读哪一部分)
- [按场景选择文档](#按场景选择文档)
- [NanoFlow 的基本使用思路](#nanoflow-的基本使用思路)
- [这套手册和 Context7 文档的区别](#这套手册和-context7-文档的区别)
- [阅读时需要记住的规则](#阅读时需要记住的规则)
- [下一步](#下一步)

## 应该先读哪一部分

| 你的情况 | 从这里开始 | 接着读 |
| --- | --- | --- |
| 第一次打开项目 | [开始使用](01-get-started/index.md) | [第一个项目演练](01-get-started/03-first-project.md) |
| 只是想本地体验，不想登录 | [本地离线模式](01-get-started/02-local-only-mode.md) | [备份与恢复](03-data-sync-safety/03-backup-and-restore.md) |
| 已经能打开应用，但不知道每天怎么用 | [使用 NanoFlow](02-use-nanoflow/index.md) | [文本视图](02-use-nanoflow/01-text-view.md)、[Focus 专注模式](02-use-nanoflow/04-focus-mode.md) |
| 准备把重要数据放进来 | [数据、同步与安全](03-data-sync-safety/index.md) | [备份与恢复](03-data-sync-safety/03-backup-and-restore.md) |
| 想在多台设备之间同步 | [云同步配置](01-get-started/04-cloud-sync-setup.md) | [同步与冲突处理](03-data-sync-safety/02-sync-and-conflicts.md) |
| 想自己部署私有实例 | [部署与运维](04-deploy-operate/index.md) | [Supabase 运维](04-deploy-operate/02-supabase-operations.md) |

## 按场景选择文档

| 分类 | 解决的问题 |
| --- | --- |
| [开始使用](01-get-started/index.md) | 安装、启动、本地离线模式、第一个项目、云同步准备 |
| [使用 NanoFlow](02-use-nanoflow/index.md) | 文本视图、流程图、Parking Dock、Focus、Black Box、思源锚点、Android 小组件 |
| [数据、同步与安全](03-data-sync-safety/index.md) | 离线保存、同步状态、冲突、备份、恢复、密钥、隐私 |
| [部署与运维](04-deploy-operate/index.md) | 私有部署、Supabase、Edge Functions、生产问题排查 |

## NanoFlow 的基本使用思路

NanoFlow 最顺的使用方式不是“把所有事情都塞进一个列表”，而是把不同状态的事项放到合适的位置：

1. **想到什么先快速记录**：突然冒出的想法放进 Black Box，不要打断正在做的事。
2. **真正要做的事进入文本任务树**：文本视图是日常主界面，适合批量整理、编辑、搜索和推进任务。
3. **暂时不做但不能忘的事放进 Parking Dock**：这类任务不应该留在当前列表里制造干扰，也不应该直接归档。
4. **准备进入工作状态时打开 Focus**：Focus 会把今天真正要处理的内容压到更小的范围里。
5. **关系复杂时再打开流程图**：流程图适合看结构、依赖和导出，不适合作为手机端常驻主界面。
6. **重要数据先备份再折腾**：批量删除、导入、迁移、换设备、清浏览器数据前，都应该先导出。

## 这套手册和 Context7 文档的区别

| 文档 | 给谁看 | 怎么使用 |
| --- | --- | --- |
| `docs/handbook` | 使用者、私有实例操作者 | 用中文解释功能、步骤、注意事项、验收方式和常见误解 |
| `docs/context7` | AI Agent、维护者 | 提供源码路径、模型字段、契约、参考页和机器检索入口 |

如果你只是想使用 NanoFlow，优先读这套手册。只有在你要改代码、查源码边界、维护同步契约时，才需要打开 Context7 文档。

## 阅读时需要记住的规则

- **本地保存不等于云端已同步**：看到界面已经变化，只能说明本机状态已经更新；是否推到云端要看同步状态。
- **删除不等于立刻永久删除**：普通删除先进入恢复路径，但长期保留仍要靠备份。
- **归档、停泊、删除不是一回事**：归档是长期不活跃，停泊是“稍后还要回来”，删除是移出当前工作区。
- **手机端优先文本视图**：流程图较重，应该按需打开。
- **语音转写依赖云端**：文字记录可以离线，语音转写需要 Edge Function 和第三方服务。
- **私有部署也要认真配置 RLS 和密钥**：不要因为是个人项目就把服务端密钥放进前端。

## 下一步

- 第一次使用：读 [快速开始](01-get-started/01-quickstart.md)。
- 每天怎么用：读 [使用 NanoFlow](02-use-nanoflow/index.md)。
- 先保护数据：读 [备份与恢复](03-data-sync-safety/03-backup-and-restore.md)。
- 自己部署：读 [私有部署](04-deploy-operate/01-private-deployment.md)。
