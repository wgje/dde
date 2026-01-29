---
name: api-design
description: API 设计技能，包含 RESTful 规范和 Supabase 最佳实践
triggers:
  - "@architect"
  - "/design"
---

# API Design Skill

## 概述

此技能用于设计一致、可维护的 API，涵盖：
- RESTful API 设计规范
- Supabase Edge Function 模式
- 错误处理和响应格式
- 版本控制策略

## 使用方法

### 设计新 API
```
/design "用户认证 API"
@architect 设计语音转写 Edge Function
```

## RESTful 规范

### URL 命名
```
✅ 正确
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects
PATCH  /api/projects/:id
DELETE /api/projects/:id

❌ 错误
GET    /api/getProjects
POST   /api/createProject
```

### HTTP 方法语义
| 方法 | 用途 | 幂等性 |
|------|------|--------|
| GET | 读取资源 | 是 |
| POST | 创建资源 | 否 |
| PUT | 完整替换 | 是 |
| PATCH | 部分更新 | 是 |
| DELETE | 删除资源 | 是 |

### HTTP 状态码
| 状态码 | 含义 | 使用场景 |
|--------|------|----------|
| 200 | OK | 成功读取/更新 |
| 201 | Created | 成功创建 |
| 204 | No Content | 成功删除 |
| 400 | Bad Request | 请求格式错误 |
| 401 | Unauthorized | 未认证 |
| 403 | Forbidden | 无权限 |
| 404 | Not Found | 资源不存在 |
| 409 | Conflict | 资源冲突 |
| 422 | Unprocessable | 验证失败 |
| 500 | Server Error | 服务器错误 |

## 响应格式

### 成功响应
```json
{
  "data": {
    "id": "uuid",
    "title": "任务标题",
    "createdAt": "2026-01-28T10:00:00Z"
  }
}
```

### 列表响应
```json
{
  "data": [...],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 20
  }
}
```

### 错误响应
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "标题不能为空",
    "details": {
      "field": "title",
      "constraint": "required"
    }
  }
}
```

## Supabase Edge Function 模式

### 基本结构
```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  // CORS 处理
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      }
    });
  }

  try {
    // 认证验证
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '缺少认证' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 业务逻辑
    const body = await req.json();
    const result = await processRequest(body);

    return new Response(
      JSON.stringify({ data: result }),
      { 
        status: 200, 
        headers: { 
          'Content-Type': 'application/json',
          'Connection': 'keep-alive'
        } 
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: error.message } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
```

### 密钥管理
```bash
# 设置密钥（禁止硬编码）
supabase secrets set GROQ_API_KEY=xxx

# 在函数中使用
const apiKey = Deno.env.get("GROQ_API_KEY");
```

## 分页策略

### Offset 分页（简单场景）
```
GET /api/tasks?page=2&limit=20
```

### Cursor 分页（大数据集）
```
GET /api/tasks?cursor=eyJpZCI6IjEyMyJ9&limit=20
```

## 版本控制

### URL 版本
```
/api/v1/tasks
/api/v2/tasks
```

### Header 版本
```
Accept: application/vnd.nanoflow.v1+json
```

## 输出格式

```markdown
# API Design: [API 名称]

## 概述
[API 目的描述]

## 端点

### POST /api/[resource]
**描述**: [功能描述]

**请求**:
```json
{
  "field": "value"
}
```

**响应** (201):
```json
{
  "data": { ... }
}
```

**错误**:
- 400: 请求格式错误
- 401: 未认证

## 安全考虑
- [ ] 认证要求
- [ ] 速率限制
- [ ] 输入验证
```
