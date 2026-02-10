# scripts/ — 数据库与工具脚本

## 新项目初始化（3 步）

```
1. Supabase Dashboard → Storage → 创建 attachments 私有桶
2. SQL Editor → 执行 init-supabase.sql（全部数据库对象一次到位）
3. 可选：SQL Editor → 执行 cleanup-cron-setup.sql（配置定时清理）
```

## SQL 文件分类

### 必须的（改了数据库结构就要同步更新）

| 文件 | 定位 |
|------|------|
| `init-supabase.sql` | **唯一权威初始化脚本**（v3.8.0）。包含全部表、RLS、RPC、触发器、索引、视图、Realtime、Storage 策略。新增/修改任何数据库对象后，必须同步到此文件 |

### 独立执行的（不合并进 init-supabase.sql）

| 文件 | 何时用 | 原因 |
|------|--------|------|
| `cleanup-cron-setup.sql` | 需要定时清理软删除数据时 | 依赖 pg_cron 扩展，非所有实例可用。init-supabase.sql 会自动尝试，失败时用此脚本重试 |
| `backup-setup.sql` | 需要服务端备份功能时 | 创建备份元数据表和 Storage 桶，独立于核心业务 |
| `backup-cron-setup.sql` | 需要定时自动备份时 | 依赖 pg_cron + pg_net + Edge Functions 已部署 |

### 老用户迁移专用（新项目忽略）

| 文件 | 说明 |
|------|------|
| `migrate-to-v2.sql` | JSONB → 独立表迁移，仅老项目升级时用 |
| `cleanup-v1-data.sql` | 迁移验证通过后清理 v1 遗留数据 |
| `purge-deleted-tasks.sql` | 早期版本的软删除清理（功能已整合进 init-supabase.sql） |

### legacy/ — 已废弃，仅供考古

全部内容已整合进 `init-supabase.sql`，不要执行。

## 非 SQL 工具脚本

| 文件 | 用途 |
|------|------|
| `seed-supabase.js` | 填充测试数据（开发用） |
| `set-env.cjs` | 写入环境变量 |
| `validate-env.cjs` | 校验环境变量完整性 |
| `setup-storage-bucket.cjs` | 脚本方式创建 Storage 桶 |
| `run-ng.cjs` | Angular CLI 启动辅助 |
| `patch-esbuild.cjs` | esbuild 补丁 |
| `inject-modulepreload.cjs` | 构建后注入 modulepreload |
| `analyze-bundle.sh` | 分析打包体积 |
| `analyze-performance.sh` | Lighthouse 性能分析 |
| `performance-benchmark.sh` | 性能基准测试 |
| `verify-transcribe-setup.sh` | 诊断语音转写配置 |
| `diagnose-transcribe-401.sh` | 排查转写 401 错误 |
| `verify-cleanup.sh` | 验证清理结果 |
| `cleanup-sensitive-files.sh` | 清理敏感文件 |
| `scan-placeholder-interactions.sh` | 扫描未实现的占位交互 |
| `start-chrome-debug.sh` | 启动 Chrome 调试实例 |

## 改了数据库怎么办？

```
改了表/RLS/RPC/触发器/索引/视图
  → 更新 init-supabase.sql
  → npm run db:types（重新生成 src/types/supabase.ts）
  → 手动同步 src/models/supabase-types.ts
```
