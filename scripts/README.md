# scripts/ — 数据库与工具脚本

## 编码基线（必须遵守）

- 中文 Windows 默认控制台代码页 `CP936`（GBK），**UTF-8 文件在终端中显示为乱码**（如 "打开设置" → "鎵撳紑璁剧疆"）。
- **VS Code 终端**（根源修复）：`.vscode/settings.json` 已配置 `PowerShell UTF-8` profile，新开终端自动执行 `chcp 65001` 并设置 `$OutputEncoding = UTF8`。
- **外部终端**：运行任何 npm 命令前先执行 `chcp 65001`（cmd）或 `$OutputEncoding = [System.Text.Encoding]::UTF8`（PowerShell）。
- **PowerShell 5.1 脚本**：读取文本必须 `Get-Content -Encoding UTF8`，写入必须 `Set-Content -Encoding UTF8` / `Add-Content -Encoding UTF8`。
- **Playwright E2E**：`playwright.config.ts` 已配置 `locale: 'zh-CN'`，确保浏览器上下文中文渲染一致。
- **CI（ubuntu-latest）**：系统默认 UTF-8，无需额外配置。
- CI 与本地门禁统一通过 `npm run quality:guard:encoding` 检查工作区活跃文本文件中的 UTF-8 BOM、无效 UTF-8、`U+FFFD`、PUA、断裂问号与高置信 mojibake 片段。
- 归档取证样本 `docs/archive/*.corrupted*` 与构建/报告目录按白名单排除，不参与正常门禁。

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
| `init-supabase.sql` | **唯一权威初始化脚本**（v3.9.0，最后验证 2026-02-15）。包含全部表、RLS、RPC、触发器、索引、视图、Realtime、Storage 策略、Resume 水位 RPC。新增/修改任何数据库对象后，必须同步到此文件 |

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

### 测试执行与维护

| 文件 | 用途 |
|------|------|
| `run-test-matrix.cjs` | **测试矩阵核心**：Lane 分片 + Quarantine 隔离 + LPT 调度，所有 `test:run:*` 命令的底层驱动 |
| `update-test-duration-baseline.cjs` | 刷新 `scripts/test-duration-baseline.json`（`test:baseline:update`） |
| `update-test-quarantine.cjs` | 按 p95/失败率规则自动维护 `scripts/test-quarantine.json`（`test:quarantine:update`） |
| `run-full-tests.cjs` | 全量测试辅助脚本 |
| `stress/run-repeat.cjs` | 重复运行指定次数（稳定性验证，`test:run:stress`） |
| `stress/run-contention-pair.cjs` | 并发竞争对测试（`test:run:contention`） |
| `contracts/check-encoding-corruption.cjs` | 编码污染门禁：扫描工作区活跃文本文件中的 BOM/无效 UTF-8/`U+FFFD`/PUA/断裂问号/高置信 mojibake 片段（`quality:guard:encoding`） |
| `contracts/check-flow-current-userid.cjs` | 契约检查：flow 组件中 currentUserId 引用合规性（`test:contracts`） |

### 性能门禁

| 文件 | 用途 |
|------|------|
| `perf-startup-guard.cjs` | 启动时间门禁（`perf:guard:startup`） |
| `perf-no-regression-guard.cjs` | 与 baseline 对比，阻断性能回归（`perf:guard:no-regression`） |
| `run-perf-audit-batch.cjs` | 批量性能审计（`perf:audit:batch`） |
| `check-main-no-jit.cjs` | 断言主包中无 JIT 编译器（`perf:guard:nojit`） |
| `check-font-subset-contract.cjs` | 字体子集契约验证（`quality:guard:font-contract`） |
| `check-supabase-ready-contract.cjs` | Supabase 就绪契约验证（`quality:guard:supabase-ready`） |

### 环境与构建

| 文件 | 用途 |
|------|------|
| `set-env.cjs` | 写入环境变量（`npm run config`） |
| `validate-env.cjs` | 校验环境变量完整性 |
| `run-ng.cjs` | Angular CLI 启动辅助 |
| `patch-esbuild.cjs` | esbuild 补丁（`postinstall`） |
| `inject-modulepreload.cjs` | 构建后注入 modulepreload |

### 数据与工具

| 文件 | 用途 |
|------|------|
| `seed-supabase.js` | 填充测试数据（开发用） |
| `setup-storage-bucket.cjs` | 脚本方式创建 Storage 桶 |
| `analyze-bundle.sh` | 分析打包体积 |
| `analyze-performance.sh` | Lighthouse 性能分析 |
| `performance-benchmark.sh` | 性能基准测试 |
| `verify-transcribe-setup.sh` | 诊断语音转写配置 |
| `diagnose-transcribe-401.sh` | 排查转写 401 错误 |
| `verify-cleanup.sh` | 验证清理结果 |
| `cleanup-sensitive-files.sh` | 清理敏感文件 |
| `scan-placeholder-interactions.sh` | 扫描未实现的占位交互 |
| `start-chrome-debug.sh` | 启动 Chrome 调试实例 |

## 测试策略（本地反馈优先）

| 命令 | 用途 |
|------|------|
| `npm run test:run:fast` | 本地默认阻塞门禁（排除 quarantine，优先反馈速度） |
| `npm run test:run:full` | 本地全量测试（包含 quarantine） |
| `npm run test:run:ci` | CI 分片全量（weighted + include-quarantine） |
| `npm run test:baseline:update` | 基于 shard timing/vitest 报告刷新时长 baseline |
| `npm run test:quarantine:update` | 根据 p95/失败率规则自动维护 quarantine 列表 |

### 回滚指令

如需立即恢复旧分片策略，可使用：

```bash
node scripts/run-test-matrix.cjs --strategy=mod --max-procs=2 --include-quarantine
```

## 改了数据库怎么办？

```
改了表/RLS/RPC/触发器/索引/视图
  → 更新 init-supabase.sql
  → npm run db:types（重新生成 src/types/supabase.ts）
  → 手动同步 src/models/supabase-types.ts
```
