---
name: backend-patterns
description: Supabase 后端开发的最佳实践和模式
version: 1.0.0
triggers:
  - "@architect"
  - "@implementation"
  - "@database-reviewer"
---

# 后端模式技能

NanoFlow 项目的 Supabase 后端开发最佳实践。

## 核心原则

1. **Offline-first**: IndexedDB 优先，后台增量同步
2. **客户端生成 ID**: 所有实体使用 `crypto.randomUUID()`
3. **LWW 冲突解决**: Last-Write-Wins 策略
4. **Edge Function 安全**: API Key 永不暴露在前端

## 数据库设计模式

### 1. 软删除模式

```sql
-- 所有表都使用 deleted_at 软删除
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  content TEXT,
  deleted_at TIMESTAMPTZ,  -- NULL = 未删除
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 默认过滤已删除记录
CREATE VIEW active_tasks AS
SELECT * FROM tasks WHERE deleted_at IS NULL;
```

### 2. 增量同步模式

```sql
-- 使用 updated_at 进行增量拉取
SELECT * FROM tasks 
WHERE updated_at > $last_sync_time
  AND (deleted_at IS NULL OR deleted_at > $last_sync_time);
```

### 3. RLS 策略模式

```sql
-- 用户只能访问自己的数据
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access own tasks"
  ON tasks FOR ALL
  USING (user_id = auth.uid());
```

## Edge Function 模式

### 1. 安全代理模式

```typescript
// supabase/functions/transcribe/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  // 验证认证
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 使用环境变量中的 API Key
  const apiKey = Deno.env.get('GROQ_API_KEY');
  
  // 代理请求到第三方服务
  const response = await fetch('https://api.groq.com/...', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  return response;
});
```

### 2. 错误处理模式

```typescript
try {
  const result = await operation();
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
} catch (error) {
  console.error('Operation failed:', error);
  return new Response(
    JSON.stringify({ error: 'Internal error' }),
    { status: 500 }
  );
}
```

## 同步架构

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Angular 前端    │     │      Supabase            │     │   PostgreSQL    │
│  ─────────────  │ ◄─► │  ──────────────────────  │ ◄─► │  ─────────────  │
│  IndexedDB      │     │  Realtime + PostgREST    │     │   持久化存储    │
│  本地缓存       │     │  认证 + RLS              │     │   RLS 策略      │
└─────────────────┘     └──────────────────────────┘     └─────────────────┘
```

## 常见模式

### 批量操作

```typescript
// 使用 upsert 进行批量同步
const { error } = await supabase
  .from('tasks')
  .upsert(tasks, { 
    onConflict: 'id',
    ignoreDuplicates: false 
  });
```

### 乐观更新

```typescript
// 1. 立即更新本地状态
updateLocalState(newData);

// 2. 后台推送到服务器
syncToServer(newData).catch(error => {
  // 3. 失败时加入重试队列
  retryQueue.add(newData);
});
```

### 冲突检测

```typescript
// LWW: 比较 updated_at
if (remoteData.updated_at > localData.updated_at) {
  // 服务器数据更新
  useRemoteData();
} else {
  // 本地数据更新，推送
  pushLocalData();
}
```

## 与 everything-claude-code 的映射

| 概念 | everything-claude-code | 本项目实现 |
|------|------------------------|------------|
| 后端规则 | `rules/backend.md` | `.github/instructions/backend.instructions.md` |
| 数据库审查 | 自定义 agent | `@database-reviewer` |
| 安全审计 | security skill | `.github/skills/security-review/` |

## 注意事项

1. **永远不要硬编码 API Key**: 使用 `supabase secrets set`
2. **所有表都要 RLS**: 防止未授权访问
3. **使用事务**: 复杂操作使用数据库函数
4. **监控慢查询**: 使用 Supabase Dashboard
5. **定期备份**: 配置自动备份策略
