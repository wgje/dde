---
title: Supabase 运维
status: canonical
audience: operator
last_verified: 2026-07-15
category: deploy-operate
source_paths:
  - README.md
  - package.json
  - scripts/init-supabase.sql
  - src/services/supabase-client.service.ts
  - src/config/attachment.config.ts
  - src/services/attachment.service.ts
  - src/services/attachment-upload-outbox.service.ts
  - src/services/disaster-backup.service.ts
  - src/services/import-backup-conversion.helpers.ts
  - supabase/functions/_shared/backup-utils.ts
  - supabase/functions/cleanup-attachments/index.ts
  - supabase/functions/cleanup-attachments/cleanup-outbox.ts
  - docs/handbook/01-get-started/04-cloud-sync-setup.md
  - docs/handbook/03-data-sync-safety/03-backup-and-restore.md
---

# Supabase 运维

NanoFlow 把 Supabase 当成正式数据平面，而不是“可选云端增强”。只要这个私有实例启用了登录、同步、附件或 Edge Function，Supabase 的项目配置、RLS、Storage 和维护函数就直接决定用户数据是否安全、是否能恢复、以及跨设备是否可信。

这页只写当前仓库已经落地的能力和边界。不要把旧方案、计划文档或 Supabase 平台默认能力误写成“本仓库已经实现”。

## 本文内容

- [先区分低风险检查和高权限变更](#先区分低风险检查和高权限变更)
- [实例最小接线与首次验收](#实例最小接线与首次验收)
- [RLS 与 ownership 核验](#rls-与-ownership-核验)
- [私有附件桶、软删除与 30 天清理](#私有附件桶软删除与-30-天清理)
- [迁移与类型生成](#迁移与类型生成)
- [备份与恢复边界](#备份与恢复边界)
- [安全诊断顺序](#安全诊断顺序)
- [不要做什么](#不要做什么)
- [下一步](#下一步)

## 先区分低风险检查和高权限变更

先判断你现在是在做“读状态”还是“改基础设施”。这两类动作混在一起，最容易把一次普通排障变成数据事故。

| 动作 | 需要什么 | 会不会改实例 | 什么时候做 |
| --- | --- | --- | --- |
| `npm run supabase:status`、查看 Dashboard、运行只读 SQL、双浏览器验收 | 已登录的项目只读访问 | 否 | 日常检查、上线后验收、故障初判 |
| `npm run db:types` | 已 link 到正确项目 | 否（只更新本地类型文件） | schema 已经变更后，同步前端类型 |
| `npm run supabase:db:push` | 项目写权限、正确 link | 会改 schema / policy / function | 发布迁移时 |
| 在 Storage Dashboard 创建 `attachments` 桶 | Supabase 项目管理员权限 | 会改 Storage 配置 | 首次建库，或桶被误删后恢复 |
| 部署 `cleanup-attachments`、`virus-scan` 等 Edge Function | 函数部署权限 | 会改服务端行为 | 首次接线或函数更新 |
| 配置 `SUPABASE_SERVICE_ROLE_KEY`、`CLEANUP_ATTACHMENTS_SECRET` 等 Secrets | Secret / 平台权限 | 会改服务端能力 | 只有维护函数或服务端能力需要时 |
| 手动调用 `cleanup-attachments` | 维护 Bearer secret | 会改任务附件元数据和 Storage 删除队列 | 受控维护窗口、验证清理链路 |
| `npm run supabase:db:reset` | 项目写权限 | 会清库 / 重建 | 只允许本地开发或一次性测试库，禁止对任何真实数据实例执行 |

如果你只是确认“实例现在是不是安全可用”，优先停在前两行。只有确认问题必须靠 schema、函数或 Secrets 修复时，才进入高权限操作。

## 实例最小接线与首次验收

这套私有实例的最小接线不是“库能连上”就算完成，而是下面五件事同时成立。

### 1. 前端只拿同一个项目的公开连接值

当前前端只认两项环境变量：

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

可见信号：

- `README.md` 和 [云同步配置](../01-get-started/04-cloud-sync-setup.md) 都把这两项列为云同步最少配置；
- `src/services/supabase-client.service.ts` 在未配置时会抛出 `Supabase 未配置，请提供 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY`；
- 前端如果发现 URL 和 anon key 不一致，或把敏感 key 放进 anon key 位置，会阻止初始化并进入本地离线回退。

这一步是普通使用者和实例维护者的分界线。使用者不能靠自己电脑上的 `.env.local` 修复已经发布的网站；真正的修复发生在构建环境或托管平台变量里。

### 2. CLI 已经连到正确项目

仓库暴露的 Supabase CLI 入口在 `package.json`：

```bash
npm run supabase:login
npm run supabase:link
npm run supabase:status
```

如果你在跑本地 Supabase 栈，再用：

```bash
npm run supabase:start
npm run supabase:status
```

可见信号：

- `status` 显示的是你当前要维护的那个项目或本地栈，而不是别的测试项目；
- 任何后续 `db push`、`db pull`、`db:types` 都应基于同一个已确认的目标。

### 3. schema 和 policy 已应用到目标项目

首次建库或发布 schema 变更时，使用：

```bash
npm run supabase:db:push
```

当前仓库要求 schema 变更走迁移，而不是只在 Dashboard 里手改。`scripts/init-supabase.sql` 也明确把表、RLS、RPC、触发器、索引和维护函数写在代码里。

可见信号：

- `db push` 成功结束，没有停在某条 migration 或 SQL error；
- RLS / policy / function 的核验结果与下文一致；
- 前端对这个 schema 的字段访问能通过后续 `db:types` 和验收。

### 4. `attachments` 桶已手动创建成私有桶

当前仓库没有把 `attachments` 桶的创建自动写进 migration。`scripts/init-supabase.sql` 的源注释明确要求在 Dashboard 中创建：

- Name: `attachments`
- Public: `false`
- File size limit: `10MB`

同时，前端代码还固定了：

- 每任务最多 `20` 个附件；
- 图片缩略图最大 `200`；
- 签名 URL 过期时间 `30` 天；
- Storage 上传 `cacheControl` 为 `31536000` 秒。

因此，这里不是“只要有桶就行”，而是“桶名、私有性和文件体积边界都要与前端预期一致”。

### 5. 首次同步验收真的跑过

不要把“控制台看起来没报错”当成上线完成。当前 handbook 的云同步验收要求至少做一轮小项目验收：

1. 设备 A 登录。
2. 创建测试项目和两个测试任务。
3. 等待同步稳定。
4. 设备 B 或另一个浏览器资料登录同一账户。
5. 确认测试项目出现。
6. 在设备 B 修改一个任务标题。
7. 回到设备 A，确认变更能看到。
8. 如果启用了附件，上传一个很小的 `.txt` 文件并在另一端打开。

可见信号：

- 任务结构跨设备出现；
- 附件跨设备可读；
- 没有出现“配置帮助”、本地离线回退或附件权限错误。

## RLS 与 ownership 核验

当前实例的数据隔离不是靠“前端只显示自己的项目”，而是靠 RLS、policy 和 helper 函数。只要这里不对，前端再谨慎也不能当安全边界。

### 先查 RLS 是否真的打开并强制

用只读 SQL 查关键表：

```sql
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'projects',
    'project_members',
    'tasks',
    'connections',
    'user_preferences',
    'black_box_entries',
    'transcription_usage',
    'focus_sessions',
    'routine_tasks',
    'routine_completions',
    'attachment_scans',
    'quarantined_files',
    'attachment_cleanup_jobs'
  )
order by c.relname;
```

你应该看到：

- `projects` / `tasks` / `connections` / `user_preferences` 至少 `rls_enabled = true`；
- `black_box_entries`、`focus_sessions`、`routine_tasks`、`routine_completions`、`attachment_scans`、`quarantined_files`、`attachment_cleanup_jobs` 也已经启用；
- `scripts/init-supabase.sql` 末尾还会把多张表切到 `FORCE ROW LEVEL SECURITY`。

只要这里有一张核心表没开 RLS，先停下，不要继续把实例交给真实用户。

### 再查 policy 名称和作用域

```sql
select
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where
  (schemaname = 'public' and tablename in (
    'projects',
    'project_members',
    'tasks',
    'connections',
    'user_preferences',
    'black_box_entries',
    'focus_sessions',
    'routine_tasks',
    'routine_completions',
    'attachment_scans',
    'quarantined_files',
    'attachment_cleanup_jobs'
  ))
  or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;
```

当前仓库的锚点信号是：

- `projects` 有 `owner select/insert/update/delete`；
- `project_members` 只允许项目 owner 管；
- `tasks` / `connections` 不是直接看 `tasks.user_id`，而是通过 `user_accessible_project_ids()`、`user_has_project_access(project_id)`、`user_is_project_owner(project_id)` 做 project 级 ownership；
- `user_preferences` 走 `auth.uid() = user_id`；
- `storage.objects` 上有 `Users can upload/view/delete/update own attachments`，并且目录首段必须等于 `auth.uid()`；
- `attachment_scans`、`quarantined_files`、`attachment_cleanup_jobs` 都是 `service_role` 专用策略。

这里最容易误判的一点是 `tasks`。当前 schema 不应该用“有没有 `tasks.user_id`”来审 owner；该仓库的 owner 关系通过 `project_id -> projects.owner_id` 和访问 helper 函数确认。

### 最后做两账户隔离验收

只读 SQL 能证明策略存在，但不能代替双账户验收。至少做这两件事：

1. 用账户 A 创建测试项目、任务和一个小附件。
2. 用账户 B 登录，确认看不到账户 A 的项目，也不能读到 A 的附件。

如果账户 B 能看到 A 的结构数据或附件，或者账户 A 看不到自己的数据，先冻结新写入，再修 RLS。不要先改前端，不要先改缓存。

## 私有附件桶、软删除与 30 天清理

当前附件链路有三层：私有桶、前端软删除、服务端后台清理。只修其中一层，结果通常是“眼前看似正常，几周后数据或成本开始出问题”。

### 桶和路径必须符合当前代码预期

当前前端上传和读取都固定使用：

- bucket: `attachments`
- 路径格式：`{owner_id}/{project_id}/{task_id}/{attachmentId}.{ext}`
- 私有签名 URL：`30` 天
- 单文件大小上限：`10MB`
- 每任务附件上限：`20`

`scripts/init-supabase.sql` 的 `storage.objects` policy 也直接按路径首段校验：

- 上传：`(storage.foldername(name))[1] = auth.uid()::text`
- 读取：同样只允许读自己目录
- 删除 / 更新：同样只允许自己目录

如果桶名对了，但路径首段不是 owner id，RLS 一样会拒绝。

### 正常删除不是硬删

`src/services/attachment.service.ts` 明确把“正常删除”定义成软删除：

- 用户侧删除调用 `markAsDeleted()`；
- 注释写明“正常删除应使用 markAsDeleted 进行软删除”；
- 真正的硬删除接口 `deleteFile()` / `deleteFiles()` 仅供清理任务使用。

这意味着：

- 用户刚删掉附件时，不应指望 Storage 对象立刻消失；
- 只要清理任务还没跑，过期对象就可能继续留在桶里；
- 误把“对象还在桶里”当成“前端没删成功”，很容易做出错误人工修复。

### 30 天清理靠 `cleanup-attachments`，不是靠前端定时器

当前仓库里实际存在的清理服务端能力是 `supabase/functions/cleanup-attachments`，不是假想的通用备份 worker。它做三件事：

1. 扫描 `tasks.attachments` 中 `deletedAt` 超过 `30` 天的软删除附件；
2. 用 `claim_task_attachment_cleanup(...)` 做 `updated_at` CAS 更新，并把 Storage 删除任务写入 `attachment_cleanup_jobs`；
3. 用 `claim_attachment_cleanup_jobs(...)` + Storage `remove()` 处理持久化 outbox，失败会指数退避重试。

这条链路的安全边界也已经写死：

- 只能 `POST`；
- 请求 Bearer 不是用户 JWT，也不是 service-role key，而是 `CLEANUP_ATTACHMENTS_SECRET` 或 `MAINTENANCE_CRON_SECRET`；
- 函数内部才读取 `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY`；
- 缺 secret 返回 `503 Maintenance secret is not configured`；
- 缺服务端配置返回 `503 Supabase service configuration is not configured`；
- Bearer 不对返回 `401 Unauthorized`。

所以，手动触发清理时要记住一条红线：请求凭据和函数内部的 service-role 凭据不是同一件事。不要把 service-role key 当作 HTTP Bearer 去调用这个函数。

### 成功、空跑和异常各自会看到什么

`cleanup-attachments` 的 HTTP 返回体会给出操作者真正可见的结果：

- 空跑：`success: true`，`message: "No expired attachments to clean up"`
- 正常处理：`success`、`deletedCount`、`storageDeletedCount`、`dbUpdatedCount`
- 分页续跑信息：`hasMore`、`tasksProcessed`、`nextCursor`、`scanWrapped`
- 错误摘要：`storageErrors`、`dbErrors`

如何解读：

- `deletedCount > 0` 但 `storageDeletedCount = 0`：说明找到过期附件了，但对象删除没有完成；
- `dbUpdatedCount < deletedCount`：说明一部分任务在清理窗口里发生了 `updated_at` 变化，CAS 没抢到；
- `hasMore = true`：本轮只是扫完了当前页面，不是实例已经彻底清空；
- 长期只看到 `No expired attachments to clean up`，但桶容量持续上涨：检查是否只有 outbox 在失败重试，或软删除根本没有被写入。

### 病毒扫描和隔离区是 service-only 能力

当前 schema 还定义了：

- `attachment_scans`
- `quarantined_files`

这两张表都启用了 RLS，并且只给 `service_role` 开策略和权限。普通认证用户不应直接查表；前端也被明确设计成“通过 Edge Function 间接访问”。如果你计划把病毒扫描作为正式能力上线，检查的不只是 `virus-scan` 函数目录是否存在，还要确认 service-only 表和 Secrets 已在目标项目接好。

用户影响：

- 桶或 policy 配错时，用户会看到附件上传失败、跨设备附件打不开，或者签名 URL 生成失败后附件被立即清理；
- 清理函数缺席时，用户界面可能暂时看不出异常，但 30 天后的对象回收不会完成，Storage 成本和陈旧对象会持续累积。

## 迁移与类型生成

当前仓库把 migration 和 TypeScript 类型生成拆成两个明确步骤。不要只做其中一个。

### 发布 schema 的标准顺序

1. 先确认目标项目正确 link。
2. 备份当前可恢复点。
3. 执行：

```bash
npm run supabase:db:push
```

4. 然后执行：

```bash
npm run db:types
```

5. 检查 `src/types/supabase.ts` 是否与这次 schema 变化一致。

为什么必须补第 4 步：

- `package.json` 明确把 `db:types` 定义成 `node scripts/supabase-cli.cjs gen types typescript --linked > src/types/supabase.ts`；
- `src/services/supabase-client.service.ts` 直接使用 `../types/supabase` 里的 `Database` 类型；
- schema 变了但类型没变，前端很容易在编译时或运行时带着过时字段假设继续上线。

### 看到什么信号才算这次迁移真的收口

- `db push` 成功结束；
- `src/types/supabase.ts` 反映了本次新增/变更字段；
- 双设备验收和附件验收通过；
- 如果这次改了文档或用户行为，`npm run docs:human:validate` 通过。

### 回滚和恢复边界

这个仓库没有提供“一键回滚上一个 schema 版本”的自动脚本。出现问题时，优先按下面顺序思考：

1. 前端是否可以单独回滚，且不触发 schema 不兼容；
2. 能否用新的 forward migration 修正；
3. 如果已经破坏真实数据或 policy，是否必须走 Supabase 平台级恢复。

不要把 `npm run supabase:db:reset` 当成“快速回滚”。它是清库工具，不是生产恢复工具。

## 备份与恢复边界

这一节只说当前仓库已经有的恢复路径，以及它们的边界。不要把计划中的云端备份当现状。

### 当前仓库真实存在的恢复路径

| 路径 | 当前来源 | 能保住什么 | 不能替代什么 |
| --- | --- | --- | --- |
| JSON 导出 / 导入 | `export.service.ts` / `import.service.ts`，见 [备份与恢复](../03-data-sync-safety/03-backup-and-restore.md) | 项目、任务、连接、附件元数据 | 原始附件二进制 |
| 附件 ZIP 导出 / 导入 | `attachment-export.helpers.ts` / `attachment-import.service.ts` | 原始附件文件 | 项目结构 |
| 本地增强备份 | `DisasterBackupService` + `LocalBackupService` | 项目结构、可选 cloud user state、本机待同步状态 | 平台级 DB / Storage 快照 |
| 浏览器内 IndexedDB 回滚副本 | 内部恢复层 | 同一浏览器 profile 内的回滚 | 跨设备恢复、重装后恢复 |

### 本地增强备份当前到底比普通 JSON 多什么

`DisasterBackupService` 当前会构造 `BackupData`，其中：

- `coverage.includesProjectData` 固定为 `true`
- `coverage.includesLocalState` 固定为 `true`
- `coverage.includesCloudUserState` 只有在“存在有效用户 + Supabase 已配置 + 远端读取未 deferred”时才为 `true`

共享备份契约 `supabase/functions/_shared/backup-utils.ts` 还明确包含：

- `attachments` 元数据
- `externalSourcePendingLinks`
- `attachmentUploadOutbox`
- action queue / retry queue / dead letters / conflicts

这说明本地增强备份不是“另一个 JSON 导出按钮”，而是桌面端灾难恢复包。

### 恢复时的 owner 边界

`import-backup-conversion.helpers.ts` 对待上传附件 outbox 的恢复做了 owner 校验：

- 必须有 `backup.localState.dataSafety.ownerUserId`
- 只有 `upload.ownerUserId === ownerUserId` 的 `attachmentUploadOutbox` 才会恢复
- 缺 `operationId`、`blobKey`、`fileName`、`mimeType`、`blobBase64` 的记录不会恢复

这意味着：

- 跨账号恢复时，不应期待“另一个人的待上传附件队列”被带回来；
- 如果用户只拿普通 JSON 导出做恢复，附件二进制和待上传 outbox 本来就不在那条链路里。

### 当前仓库没有提供什么

当前 `supabase/functions` 目录里实际存在的是：

- `cleanup-attachments`
- `transcribe`
- `virus-scan`
- 若干 widget 函数
- `_shared/backup-utils.ts`

但当前并不存在已实现的 `backup-full`、`backup-incremental`、`backup-cleanup` 这类服务端备份函数目录；`supabase/functions/backup-alert/index.ts` 还是一个长度为 `0` 的空文件。

所以这页手册必须把边界写清楚：

- 当前仓库没有一条“已实现并可直接运维”的服务端全量/增量备份流水线；
- 当前仓库没有可用的备份告警实现；
- 平台级数据库备份、PITR、Storage 快照和跨项目恢复属于 Supabase 平台或你自建基础设施的职责，不属于这个仓库自动提供的能力。

如果你要承诺“这个私有实例有服务端自动备份和告警”，那是额外基础设施项目，不是照着当前仓库直接打开开关就能成立。

## 安全诊断顺序

Supabase 相关问题不要一上来就写 SQL、删缓存或改 policy。先按下面顺序缩小范围。

### 1. 先确认是不是接错项目

先看两件事：

- 前端 `NG_APP_SUPABASE_URL` / `NG_APP_SUPABASE_ANON_KEY` 是否来自同一项目；
- `npm run supabase:status` 指向的是否就是当前实例背后的项目。

如果这里不一致，后面所有排障都会是在错项目上做正确动作。

### 2. 再判断是配置错误、权限错误还是用户数据问题

| 现象 | 先看什么 | 用户影响 |
| --- | --- | --- |
| 应用进入本地离线回退，出现配置帮助或 “Supabase 未配置” | 前端环境变量、敏感 key 误用 | 当前浏览器还能本地写，但跨设备同步不可信 |
| 登录正常，但项目/任务不同步 | RLS、目标项目、双设备写入路径 | 一端可能只写本地，另一端看不到 |
| 附件上传失败或另一端打不开 | `attachments` 桶、Storage policy、签名 URL 路径 | 结构能同步，附件不能 |
| 软删除附件长期不回收 | `cleanup-attachments` 是否部署、secret 是否配置、函数返回是否有 `hasMore` / `storageErrors` | Storage 增长，陈旧对象保留 |
| 恢复后结构回来了，但待上传附件没回来 | 是否用了本地增强备份、owner 校验是否匹配 | 结构恢复成功，但本机待同步状态不完整 |

### 3. 先做只读确认，再做最小修复

推荐顺序：

1. 只读 SQL 查 RLS / policy / bucket 状态。
2. 用一个最小测试项目复现。
3. 只在确认根因后，做一类改动：
   - 改环境；
   - 或推 migration；
   - 或部署 / 修 Edge Function；
   - 或执行用户数据恢复。

不要同时改这四类，不然你很难证明到底是哪一类修好了问题。

### 4. 任何可能扩大损失的动作前，先让用户导出

当前 handbook 其他页面已经把这条规则写得很清楚：出现同步、恢复或存储异常时，先让用户导出当前 JSON；如果有重要附件，再导出 ZIP；桌面端可用时，再做一次本地增强备份。

对运维来说，这条规则同样成立。先保全当前状态，再动实例。

## 不要做什么

- 不要把 `service_role`、`secret`、`private`、`admin` 类 key 放进前端的 `NG_APP_SUPABASE_ANON_KEY`。
- 不要为了“先让附件能开”把 `attachments` 桶改成 public。
- 不要为了“先让同步通”关闭 RLS 或删掉 `FORCE ROW LEVEL SECURITY`。
- 不要把 `tasks.user_id` 当成当前 ownership 审计依据；当前任务权限走 project helper。
- 不要在真实数据实例上运行 `npm run supabase:db:reset`。
- 不要把 `cleanup-attachments` 的 HTTP Bearer 当成 service-role key；它要求的是维护 secret。
- 不要把普通 JSON 导出说成“已经包含附件本体和待上传 outbox”；那只对本地增强备份或附件 ZIP 成立。
- 不要告诉用户“仓库已经自带服务端自动备份/告警”；当前树里没有可用的 backup-full / incremental 流水线，`backup-alert/index.ts` 还是空文件。
- 不要在没导出当前数据前，让用户清浏览器数据、切换多个设备同时恢复，或手工在生产库改大量记录。

## 下一步

- 部署和环境变量边界：读 [私有部署](01-private-deployment.md)。
- 处理函数故障和线上症状：读 [生产排障](04-production-troubleshooting.md#edge-function-功能失败)。
- 面向用户的数据恢复入口和限制：读 [备份与恢复](../03-data-sync-safety/03-backup-and-restore.md)。
