# 生产环境语音转写问题排查清单

## 🚨 快速诊断（5分钟定位问题）

### Step 1: 浏览器开发者工具检查（最重要！）

打开你的生产环境网站 → F12 开发者工具

#### ✅ Network 标签页
1. 筛选 Fetch/XHR 请求
2. 点击录音按钮，查找 `/functions/v1/transcribe` 请求
3. 查看请求状态：

| 状态码 | 含义 | 解决方案 |
|--------|------|---------|
| **200** | ✅ 成功 | 功能正常，检查为何前端没显示结果 |
| **401** | 🔴 **认证失败** | **Token 过期/无效**（最常见）→ **重新登录** |
| **404** | 🔴 函数不存在 | Edge Function 未部署：`supabase functions deploy transcribe` |
| **429** | 🔴 配额超限 | Groq 或应用配额用完，检查 `transcription_usage` 表 |
| **503** | 🔴 服务未配置 | `GROQ_API_KEY` 未设置：`supabase secrets set GROQ_API_KEY=xxx` |
| **502** | 🔴 上游失败 | Groq API 不可用或 Key 无效 |

> 💡 **看到 401？** → 这是 JWT Token 过期，**直接重新登录即可解决 90% 的情况**！详见：[401-jwt-error-solution.md](docs/401-jwt-error-solution.md)

#### ✅ Console 标签页
查找错误信息，关键词：
- `SpeechToText`
- `transcribe`
- `GROQ`
- `FormData`

---

### Step 2: 验证 Edge Function 部署

```bash
# 检查函数是否已部署
supabase functions list

# 预期输出：
# ┌────────────┬─────────┬─────────┐
# │ Name       │ Status  │ Version │
# ├────────────┼─────────┼─────────┤
# │ transcribe │ ACTIVE  │ 1+      │
# └────────────┴─────────┴─────────┘

# 如果没有看到 transcribe，重新部署：
supabase functions deploy transcribe
```

---

### Step 3: 验证 Groq API Key

```bash
# 检查 Secret 是否已设置
supabase secrets list

# 预期输出应包含：
# GROQ_API_KEY

# 如果没有，设置密钥：
supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here

# ⚠️ 确保 Key 来自 https://console.groq.com
# ⚠️ 确保 Key 没有多余的空格或换行符
```

**验证 Groq Key 是否有效**：
```bash
# 使用 curl 直接测试 Groq API
curl https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer gsk_your_actual_key_here"

# 如果返回模型列表，Key 有效
# 如果返回 401，Key 无效或已过期
```

---

### Step 4: 查看 Edge Function 日志

```bash
# 实时查看日志
supabase functions logs transcribe --tail 50

# 查找关键错误信息：
# ❌ "GROQ_API_KEY not configured" → 密钥未设置
# ❌ "Groq Error: 401" → Groq API Key 无效
# ❌ "Groq Error: 429" → Groq 请求频率超限
# ❌ "Quota check error" → 无法访问 transcription_usage 表
# ❌ "Invalid token" → 用户认证失败
```

---

### Step 5: 验证数据库表

在 Supabase Dashboard → SQL Editor 执行：

```sql
-- 检查表是否存在
SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE table_schema = 'public' 
  AND table_name = 'transcription_usage'
);

-- 应该返回 true

-- 检查 RLS 策略
SELECT policyname, cmd, qual 
FROM pg_policies 
WHERE tablename = 'transcription_usage';

-- 应该至少有 2 个策略：
-- - transcription_usage_select_policy
-- - transcription_usage_insert_policy
```

如果表不存在，执行：
```sql
-- 复制 scripts/init-supabase.sql 中的相关部分
-- 或完整执行整个脚本
```

---

## 🔍 深度诊断工具

### 方法 1: 使用 HTML 诊断工具（推荐）

1. 打开 `docs/transcribe-diagnostic-tool.html` 文件
2. 在浏览器中打开（可以是本地文件）
3. 按照步骤逐项测试：
   - 配置信息
   - 连接测试
   - 用户认证
   - 数据库检查
   - Edge Function 测试
   - 完整录音转写

### 方法 2: 使用命令行验证脚本

```bash
# 确保有执行权限
chmod +x scripts/verify-transcribe-setup.sh

# 运行验证
./scripts/verify-transcribe-setup.sh

# 脚本会检查：
# ✅ Supabase CLI 安装
# ✅ 项目链接状态
# ✅ Edge Functions 部署
# ✅ Secrets 配置
# ✅ 数据库表
# ✅ RLS 策略
```

### 方法 3: 浏览器控制台手动测试

在生产环境网站，打开浏览器控制台（F12）：

```javascript
// 1. 获取 Supabase 客户端（应用已初始化）
const client = window.__SUPABASE_CLIENT__; // 如果暴露了全局变量

// 或者重新创建
const { createClient } = supabase;
const client = createClient(
  'https://your-project.supabase.co',
  'your-anon-key'
);

// 2. 检查用户认证
const { data: { user } } = await client.auth.getUser();
console.log('User:', user);

// 3. 检查 Session
const { data: { session } } = await client.auth.getSession();
console.log('Session:', session);

// 4. 测试 Edge Function（需要真实音频 Blob）
// 先录音获取 audioBlob，然后：
const formData = new FormData();
formData.append('file', audioBlob, 'test.webm');

const { data, error } = await client.functions.invoke('transcribe', {
  body: formData
});

console.log('Result:', data, error);
```

---

## 🎯 常见问题及解决方案

### 问题 1: 点击录音按钮无反应

**可能原因**：
- 浏览器不支持 MediaRecorder API
- 麦克风权限被拒绝
- HTTPS 未启用（生产环境必须 HTTPS）

**解决方案**：
```javascript
// 检查浏览器支持
console.log('MediaRecorder supported:', typeof MediaRecorder !== 'undefined');
console.log('getUserMedia supported:', !!navigator.mediaDevices?.getUserMedia);

// 检查麦克风权限
const permissions = await navigator.permissions.query({ name: 'microphone' });
console.log('Microphone permission:', permissions.state);
```

---

### 问题 2: 录音成功但不转写

**可能原因**：
- Edge Function 未部署
- 网络请求被拦截（检查 CORS）
- Token 过期

**解决方案**：
1. 检查 Network 标签页是否有 `transcribe` 请求
2. 查看请求状态码和响应内容
3. 尝试刷新页面重新登录

---

### 问题 3: 返回 401 Unauthorized（最常见！）

**原因**：JWT Token 过期（这是正常现象，Token 设计就是会过期的）

**最快解决方案**：
1. **直接重新登录**（90% 情况立即解决）
2. 刷新页面，清除缓存
3. 重新尝试录音转写

**浏览器控制台诊断**：
```javascript
// 动态加载 Supabase SDK（如果页面没有暴露）
const script = document.createElement('script');
script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
document.head.appendChild(script);
await new Promise(resolve => setTimeout(resolve, 2000));

// 创建客户端
const { createClient } = window.supabase;
const supabase = createClient(
  'https://fkhihclpghmmtbbywvoj.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZraGloY2xwZ2htbXRiYnl3dm9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgwNDIyMTgsImV4cCI6MjA4MzYxODIxOH0.4Z5eylbmBA-YFiDRvDtom4lTHavHP3JfVmrU0yH9oVo'
);

// 检查 Token 是否过期
const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  console.error('❌ 没有 Session，需要重新登录');
} else {
  const timeLeft = Math.round((session.expires_at * 1000 - Date.now()) / 1000 / 60);
  console.log(`Token 剩余时间: ${timeLeft} 分钟`);
  if (timeLeft < 0) {
    console.error('❌ Token 已过期，需要刷新或重新登录');
    const { error } = await supabase.auth.refreshSession();
    if (error) {
      console.log('💡 刷新失败，请重新登录');
      await supabase.auth.signOut();
    }
  }
}
```

**详细解决方案**：参考 [docs/401-jwt-error-solution.md](docs/401-jwt-error-solution.md)

---

### 问题 4: 返回 503 Service Not Configured

**原因**：`GROQ_API_KEY` 未设置或设置错误

**解决方案**：
```bash
# 1. 访问 https://console.groq.com 获取 API Key
# 2. 设置 Secret（注意不要有多余空格）
supabase secrets set GROQ_API_KEY=gsk_exact_key_here

# 3. 验证设置成功
supabase secrets list

# 4. 重新部署函数（有时需要）
supabase functions deploy transcribe
```

---

### 问题 5: 返回 429 Rate Limited

**可能原因**：
- Groq API 请求频率超限（30 req/min）
- 应用每日配额用完（50次/天）

**解决方案**：
```sql
-- 检查今日使用量
SELECT COUNT(*) as today_usage
FROM transcription_usage
WHERE user_id = 'your-user-id'
AND date = CURRENT_DATE;

-- 清理测试数据（慎用！）
DELETE FROM transcription_usage
WHERE user_id = 'your-user-id'
AND date = CURRENT_DATE;
```

---

### 问题 6: 音频数据为空或格式错误

**可能原因**：
- 录音时间太短（< 1秒）
- 麦克风无声
- 音频编码格式不支持

**解决方案**：
```javascript
// 检查录音 Blob 大小
console.log('Audio blob size:', audioBlob.size, 'bytes');
console.log('Audio blob type:', audioBlob.type);

// 测试播放录音
const url = URL.createObjectURL(audioBlob);
const audio = new Audio(url);
audio.play(); // 听听是否有声音
```

---

## 🔧 高级调试

### 启用详细日志

修改前端代码临时添加日志：

```typescript
// src/services/speech-to-text.service.ts
private async transcribeBlob(audioBlob: Blob): Promise<string> {
  console.log('[DEBUG] Transcribe blob:', {
    size: audioBlob.size,
    type: audioBlob.type,
    edgeFunctionName: this.config.EDGE_FUNCTION_NAME
  });
  
  const formData = new FormData();
  const ext = /* ... */;
  formData.append('file', audioBlob, `recording.${ext}`);
  
  console.log('[DEBUG] FormData prepared, calling Edge Function...');
  
  const { data, error } = await this.supabaseClient.client().functions.invoke(
    this.config.EDGE_FUNCTION_NAME, 
    { body: formData }
  );
  
  console.log('[DEBUG] Edge Function response:', { data, error });
  
  // ...
}
```

### 监控 Edge Function 性能

```bash
# 查看最近 100 条日志
supabase functions logs transcribe --tail 100

# 持续监控
supabase functions logs transcribe --tail 10 --follow
```

---

## ✅ 成功标志

当一切正常时，你应该看到：

### 1️⃣ Supabase Dashboard
- Edge Functions → transcribe → Status: **ACTIVE** ✅
- SQL Editor → `SELECT COUNT(*) FROM transcription_usage` → 有数据 ✅

### 2️⃣ 浏览器开发者工具
- Network → `/functions/v1/transcribe` → Status: **200 OK** ✅
- Response: `{ "text": "...", "duration": X, "language": "zh" }` ✅

### 3️⃣ 应用 UI
- 按住 🎙️ 按钮 → 显示录音动画 ✅
- 松开按钮 → 显示"转写中..." ✅
- 转写完成 → 文本出现在输入框 ✅
- 剩余配额正确更新 ✅

---

## 📞 仍未解决？

如果按照以上步骤仍无法解决，请提供以下信息：

1. **浏览器开发者工具截图**
   - Network 中的 `/functions/v1/transcribe` 请求详情
   - Console 中的完整错误日志

2. **Edge Function 日志**
   ```bash
   supabase functions logs transcribe --tail 50 > logs.txt
   ```

3. **环境信息**
   - 浏览器：Chrome / Safari / Firefox（版本号）
   - 操作系统：Windows / macOS / Linux
   - Supabase 项目区域（例：us-west-1）

4. **配置验证**
   ```bash
   supabase functions list
   supabase secrets list
   ```

5. **数据库检查**
   ```sql
   SELECT * FROM information_schema.tables 
   WHERE table_name = 'transcription_usage';
   ```

提供这些信息后，可以进行更精准的诊断！🔍
