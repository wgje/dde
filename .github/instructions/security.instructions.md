---
applyTo: "**/auth/**,**/api/**,supabase/**,**/*.env*"
---
# Security Standards

## Secrets Management

### 禁止
```typescript
// ❌ 硬编码 secrets
const API_KEY = "sk-xxxxx";
const PASSWORD = "admin123";
```

### 正确方式
```typescript
// ✅ 环境变量
const apiKey = process.env.API_KEY;

// ✅ Supabase secrets
// supabase secrets set GROQ_API_KEY=xxx
const key = Deno.env.get("GROQ_API_KEY");
```

### .env 文件
- `.env.example` 提交（无真实值）
- `.env` / `.env.local` 不提交
- 生产环境用平台的 secrets 管理

## Authentication

### Supabase Auth
```typescript
// 验证用户
const { data: { user } } = await supabase.auth.getUser();
if (!user) throw new Error('Unauthorized');
```

### JWT 验证
- 检查过期时间
- 验证签名
- 验证 audience

## Input Validation

### 必须验证
- 所有用户输入
- URL 参数
- 请求体
- 文件上传

### 验证模式
```typescript
// ✅ 使用 schema 验证
import { z } from 'zod';

const TaskSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().max(50000),
});

const validated = TaskSchema.parse(input);
```

## OWASP Top 10 防护

### SQL 注入
```typescript
// ❌ 危险
db.query(`SELECT * FROM tasks WHERE id = '${id}'`);

// ✅ 参数化
db.query('SELECT * FROM tasks WHERE id = $1', [id]);
```

### XSS
```typescript
// ❌ 危险
element.innerHTML = userContent;

// ✅ 安全
element.textContent = userContent;
// 或使用 DOMPurify
```

### CSRF
- SameSite cookies
- CSRF tokens
- Origin 验证

## RLS (Row Level Security)

```sql
-- 所有表必须启用
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- 策略示例
CREATE POLICY "user_owns_task"
ON tasks FOR ALL
USING (auth.uid() = user_id);
```

## Logging

### 禁止记录
- 密码
- API keys
- Token
- 个人敏感信息

### 允许记录
- 用户 ID（脱敏）
- 操作类型
- 时间戳
- 错误代码

## 安全检查清单

- [ ] 无硬编码 secrets
- [ ] 所有输入已验证
- [ ] RLS 已启用
- [ ] HTTPS 强制
- [ ] 敏感数据已加密
- [ ] 日志已脱敏
