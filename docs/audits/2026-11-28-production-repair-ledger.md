# NanoFlow 生产修复台账（2026-11-28）

## 当前状态

- 工作区：`D:\Code\dde-main-20261128`
- 基线：`origin/main` at `1614794fd0311a271f8968712c53acf0ec937448`
- 修复提交：`03a6222c` (`fix(sync): fence offline receipts and owner upserts`)
- 已推送：`origin/main` 已读回为 `03a6222c`
- `productionWrites=0`、`productionProof=false`、`NO_RELEASE`：本台账不把本地测试、远端函数只读查询或构建成功当作生产发布证明。

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

- 新提交尚未部署到生产；生产线上仍为 SHA `1614794fd...`。GitHub CLI 未登录，未能通过 CLI workflow dispatch；生产上传需要 `workflow_dispatch(target=production, deploy=true)` 和仓库 secrets/environment，不能用普通 Git push 冒充部署。
- 生产 `sync_upsert_focus_session` / `sync_upsert_routine_task` 当前 body MD5 仍为 reviewed preimage，未执行 `20261128090000`，不能声称线上 race 已修复。
- 生产 `sync_apply_offline_command` 当前 body MD5 为 `ec10ff...`，未执行 receipt identity migration，不能声称线上 receipt collision 已修复。
- 生产 `sync_upsert_connection` stale payload 仍是独立待修链路；本提交没有覆盖，须另做 forward migration 和生产 clone 证据。
- Auth/GoTrue、Service Worker 冷启动/旧 chunk、双账号线上读回、Storage/Edge 清理调度仍未达到生产证据门槛。
- 纯 PostgreSQL fresh-init 执行因缺少 Supabase 平台基线（`auth.users`、`storage`、`supabase_realtime` 等）中止；静态 fresh-init contract 通过，不能把裸 Postgres 执行失败描述成迁移 SQL 生产失败。

## 回滚/恢复

- 本地恢复快照：`%TEMP%\dde-workspace-recovery-20261128-171810`。
- 生产未写入；没有执行 Auth 用户修改、Storage 删除、队列清除或生产 DDL。
- 合成 PostgreSQL 容器：`nanoflow-db-chain-20261128`，精确 ID 记录在 `%TEMP%\nanoflow-db-chain-20261128\lifecycle.json`；结束时按生命周期合同停止并保留容器/卷（当前仍运行，尚未清理）。

## 下一步顺序

1. 通过已授权的 GitHub/GitHub Actions 入口 dispatch 生产 workflow，并等待 test/build/deploy 终态；未达到条件保持 `NO_RELEASE`。
2. 部署后读回 `/version.json`、`_headers`、冷/热启动和登录，再做有界同步、双账号隔离与 Flow/Focus/录音 smoke。
3. 目标项目应用两条前向迁移，读回 function/schema hash、migration ledger、owner isolation 和 rollback receipt。
4. 另行处理 connection stale RPC、cleanup cursor/job scheduler、Auth 500 与 Storage cleanup/restore 竞争。