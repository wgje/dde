# Supabase 真实库 Migration 对账说明（2026-04-03）

## 背景与目标

- 本次通过 Supabase MCP 直接在真实数据库执行了 3 个前向修复 migration。
- 目标不是追求 `schema_migrations.version` 与仓库文件时间戳完全一致，而是确保真实库的最终函数、RLS policy 与删除墓碑语义已经收敛到仓库最新安全状态。
- 由于 MCP 落库时，远端 `schema_migrations.version` 可能使用执行时生成的时间戳，后续如果再用 CLI/CI 仅按版本号比对，容易把这次变更误判为 drift。

## 关键约束

- 当前产品是个人单用户、owner-only、offline-first 模型，数据库优化优先保证同步正确性和写入成本可控。
- 本次对账以“语义最终态”优先，不以“版本字符串完全相等”作为唯一正确性标准。
- 下次正式执行 schema 发布前，必须先核对本文件中的映射关系，避免重复执行已落库的修复 migration。

## 本次真实库执行映射

| 仓库 migration 文件 | 真实库 `schema_migrations.version` | 真实库 `schema_migrations.name` | 说明 |
| --- | --- | --- | --- |
| `supabase/migrations/20260401100000_owner_only_batch_upsert_tasks.sql` | `20260403050835` | `20260401100000_owner_only_batch_upsert_tasks` | owner-only batch upsert、附件 RPC、连接墓碑探测与策略收口 |
| `supabase/migrations/20260403110000_purge_connection_tombstone_hardening.sql` | `20260403050931` | `20260403110000_purge_connection_tombstone_hardening` | purge 前写 connection tombstone，补齐物理删除触发器路径 |
| `supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql` | `20260403051156` | `20260403113000_cleanup_duplicate_owner_only_policies` | 清理与优化版 owner-only policy 重叠的旧 permissive policy |

## 实施后验证

### 本地合同测试

- `npx vitest run src/tests/contracts/sql-security-hardening.contract.spec.ts --config vitest.minimal-node.config.mts`
- `npx vitest run src/tests/contracts/purge-task-connection-tombstones.contract.spec.ts --config vitest.minimal-node.config.mts`

### 真实库验证结论

- `batch_upsert_tasks` 已变为 owner-only，且不再接受客户端批量写入 `attachments`。
- `append_task_attachment` 与 `remove_task_attachment` 已补 owner 校验。
- `is_connection_tombstoned` 已收口为 owner-only。
- `purge_tasks_v2` / `purge_tasks_v3` 已在删除连接前写入 `connection_tombstones`，并限制在当前项目作用域内刷新墓碑。
- `record_connection_tombstone()` 已覆盖物理删除路径。
- 重复 permissive policy 已清理，performance advisor 中对应告警已消失。

## 当前保留项

- performance advisor 仍有 4 个未建索引的外键提示：
  - `black_box_entries_project_id_fkey`
  - `connection_tombstones_deleted_by_fkey`
  - `routine_completions_routine_id_fkey`
  - `task_tombstones_deleted_by_fkey`
- 结合真实库当前行数很小，以及仓库已有 `20260323120000_free_tier_index_cleanup.sql` 明确移除这些低扫描索引的历史，这 4 项暂时视为有意接受的写入成本权衡，不作为当前落库目标。

## 下次发布前检查项

1. 先按 migration `name` 和真实库对象最终态核对，不要只按 `version` 时间戳判断 drift。
2. 如果 CLI/CI 流程要求严格版本一致，先做一次映射登记或 metadata repair，再继续后续 DDL 发布。
3. 如果未来 `black_box_entries` 或 `routine_completions` 数据量明显增长，再重新评估是否需要补回对应外键索引。

## 回滚或故障处理

- 如果后续发布流程报告 migration drift，先确认是否只是本次 MCP 生成的远端版本号与仓库文件时间戳不同。
- 如果真实库函数、policy 与本文件记录的最终态一致，不要直接重复执行同名修复 migration。
- 必须调整 metadata 时，优先单独处理版本对账，再执行新的 schema 变更，避免把 metadata 问题和 DDL 问题混在一次发布中。