# NanoFlow 生产修复台账（2026-11-28）

## 当前状态

- 工作区：`D:\Code\dde-main-20261128`
- 基线：`origin/main` at `1614794fd0311a271f8968712c53acf0ec937448`
- 修复提交：`03a6222c` (`fix(sync): fence offline receipts and owner upserts`)
- 已推送：`origin/main` 已读回为 `03a6222c`
- 前端生产版本已读回 `version.json.gitSha=72006b7e0126eac927c9369f396ca1ce0064452d`。生产数据库已应用 owner-race DDL migration `20261128153245`；业务行、Auth 用户、Storage 对象和队列均未写入/删除（`productionBusinessWrites=0`）。收据 migration 已应用，migration ledger 版本为 `20261128154611`；完整 `productionProof=false` 仍保持，因为 connection stale、Auth、清理调度、双账号 smoke 和 rollback 读回尚未闭合。

## 已闭合的本地缺口

| 链路 | 修复/证据 |
| --- | --- |
| Focus/routine owner race | `20261128090000_atomic_focus_routine_owner_upsert.sql`；合成双连接 barrier 两轮均 `unauthorized`，对方 owner 行保持；同 owner 更新、新建和跨 owner 拒绝通过。显式事务回滚恢复 body MD5。 |
| Offline operation-ID collision | IndexedDB 同一 readwrite transaction 执行 identity check 与 projection/command/audit/conflictEvidence 写入；不同内容并发提交拒绝且原投影/审计保留；相同内容并发幂等。 |
| Offline remote receipt identity | `20261128100000_offline_command_receipt_identity.sql`；客户端 ACK/unknown reconciliation 与服务端 `command_digest` 同时绑定 owner/entity/command/intent/patch/clock/version；历史 NULL digest 保持 `reconciliation-pending`。合成碰撞、唯一键并发和回滚测试通过。 |
| Attachment signed-URL retry | 签名 URL 暂时失败后不立即发出硬删除；durable upload intent 保留，避免旧清理删除后续同 path 重试对象。`attachment.service` + cleanup focused tests 43 项通过。 |

## 验证为绿

- `npm run test:contracts`：114 文件 / 1118 项通过。
- focused sync/attachment/receipt tests：100 项通过。
- `npm run typecheck`：通过。
- `npm run build`：通过；有既有初始 bundle 预算警告（约 1.21 kB）和 dock-radar 样式预算警告，未作为失败隐藏。
- 定向 ESLint：0 errors；1 条既有 `max-lines-per-function` warning。
- `git diff --check`：通过。
- Ego Lite 生产只读验证：`https://nanoflow.pages.dev` 返回 `version.json.gitSha=1614794f...`（部署仍是旧 SHA）；主文本界面、Focus 懒加载、录音懒加载、Flow 懒加载均能进入。点击“立即同步”后仍显示 1 个失败操作及 207 个待核对记录，符合保留失败证据的 fail-closed 行为，未清除数据。

## 未闭合 / 生产门禁

- 前端新提交已部署到生产，线上 SHA 为 `be277cb4...`。GitHub Actions API 未返回对应 run，推测为 Pages 外部部署路径；GitHub CLI 未登录，不能把 workflow dispatch 说成已执行。
- 生产 `sync_upsert_focus_session` / `sync_upsert_routine_task` 已应用 `20261128153245`；读回分别为 body MD5 `8aa84012131ac841c57f6f1af308b5c7` / `c0907bd763a35c1d04827baf26c2a0f8`，owner predicate 与 zero-row guard 均为 true。
- 生产 `sync_apply_offline_command` 已应用 `20261128154611`；读回 body MD5 `aba5dc9e20471a2892592123c9ef9852`，`sync_get_offline_command_status` 为 `858902a0c4e78f2168ef8e586dea0103`，identity helper 为 `5535b3866ef2fc75b15cbf978c9a7777`。`sync_command_log` 当前 0 行，NULL digest 0 行；没有回填或改写历史收据。
- 生产 `sync_upsert_connection` 已应用 `20261128170000`；读回 body MD5 `d900a39d071de0e2f454dab0b2fe09e3`，stale guard/reason 均为 true；陈旧 payload 会在连接写入前返回 `remote-newer`。
- 过去 24 小时 bounded Auth/PostgREST/Function logs 未观察到 5xx 或 `confirmation_token` 错误；这是当前窗口的无观察结果，不是历史根因证明。Service Worker 冷启动/旧 chunk、双账号线上读回、Storage/Edge 清理调度仍未达到生产证据门槛；生产 Edge Function 列表与 cron 中均未发现 `cleanup-attachments`，调度状态保持 `UNVERIFIED`。
- 纯 PostgreSQL fresh-init 执行因缺少 Supabase 平台基线（`auth.users`、`storage`、`supabase_realtime` 等）中止；静态 fresh-init contract 通过，不能把裸 Postgres 执行失败描述成迁移 SQL 生产失败。

## 回滚/恢复

- 本地恢复快照：`%TEMP%\dde-workspace-recovery-20261128-171810`。
- 已执行一条目标绑定生产 DDL migration；没有执行 Auth 用户修改、业务行写入、Storage 删除、队列清除。生产 DDL receipt 与函数 readback 已记录在 Supabase migration ledger。
- 合成 PostgreSQL 容器：`nanoflow-db-chain-20261128`，精确 ID 记录在 `%TEMP%\nanoflow-db-chain-20261128\lifecycle.json`；结束时按生命周期合同停止并保留容器/卷（当前仍运行，尚未清理）。

## 下一步顺序

1. 通过已授权的 GitHub/GitHub Actions 入口 dispatch 生产 workflow，并等待 test/build/deploy 终态；未达到条件保持 `NO_RELEASE`。
2. 部署后读回 `/version.json`、`_headers`、冷/热启动和登录，再做有界同步、双账号隔离与 Flow/Focus/录音 smoke。
3. 目标项目应用两条前向迁移，读回 function/schema hash、migration ledger、owner isolation 和 rollback receipt。
4. 另行处理 connection stale RPC、cleanup cursor/job scheduler、Auth 500 与 Storage cleanup/restore 竞争。