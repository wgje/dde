---
applyTo: "supabase/**,**/api/**,**/functions/**"
---
# Backend Development Standards

## Supabase Guidelines

### Edge Functions
- 使用 Deno 运行时
- 必须验证请求来源
- API Key 通过 `supabase secrets set` 管理，禁止硬编码
- 响应必须设置 CORS headers
- 使用 `Connection: keep-alive` 提高性能

### Database
- 所有表必须启用 RLS (Row Level Security)
- ID 使用 `gen_random_uuid()` 生成
- 必须有 `created_at`, `updated_at` 时间戳
- 软删除使用 `deleted_at` 字段
- 敏感操作使用事务

### Migrations
```sql
-- 迁移命名: YYYYMMDDHHMMSS_description.sql
-- 结构:
-- 1. 创建表
-- 2. 创建索引
-- 3. 启用 RLS
-- 4. 创建策略
-- 5. 创建触发器
```

### RLS Policies
```sql
-- 基本模板
CREATE POLICY "Users can access own data"
ON table_name FOR ALL
USING (auth.uid() = user_id);
```

## API Design

### Conventions
- RESTful 资源命名
- 使用 HTTP 状态码语义化
- 错误响应包含 `error.code` 和 `error.message`
- 分页使用 `limit` + `offset` 或 cursor

### Security
- 所有端点需要认证（除非明确公开）
- 速率限制防止滥用
- 输入验证必须在服务端
- 敏感数据不记录日志

## Error Handling
- 使用 `supabaseErrorToError()` 统一转换
- 网络错误静默入队重试
- 业务错误 Toast 提示用户
