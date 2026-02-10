---
description: "Supabase / Edge Functions / API 后端实现规范"
applyTo: "supabase/**,**/api/**,**/functions/**"
---

# Backend Development Standards (NanoFlow)

## 核心原则
- 优先复用现有 Supabase 表、函数、策略和错误转换工具。
- 与 Offline-first + LWW 同步模型保持一致。

## 数据与模型规则
- 业务实体 ID 以客户端 `crypto.randomUUID()` 生成的值为准。
- 数据库 `id` 列使用 UUID 类型；`gen_random_uuid()` 仅可用于兼容/运维脚本，不得改变应用主路径 ID 策略。
- 必备时间字段：`created_at`、`updated_at`；软删除使用 `deleted_at`。
- 与任务同步相关查询必须包含 `content` 字段。

## Supabase 与 Edge Functions
- Edge Functions 使用 Deno 运行时。
- API Key 仅通过 `supabase secrets set` 管理，禁止硬编码。
- 必须做来源与权限校验，返回正确 CORS 头。
- 敏感操作优先事务化，失败可回滚。

## 安全规则
- 所有业务表启用 RLS。
- 策略必须绑定 `auth.uid() = user_id` 或等效约束。
- 输入校验在服务端执行，不信任客户端。
- 禁止记录密钥、token、明文敏感信息。

## 错误与重试
- Supabase 错误统一转换：`supabaseErrorToError()`。
- 网络型失败应可进入重试队列，不应直接丢失写入。
- 错误响应统一结构：`error.code` + `error.message`。

## 迁移规范
- 命名：`YYYYMMDDHHMMSS_description.sql`。
- 每个迁移包含：结构变更、索引、RLS、策略、必要回填。
- 迁移脚本必须可重复执行或具备幂等保护。
