# 语音转写功能故障排查指南

## 🔍 深度诊断清单

### 1️⃣ Supabase Edge Function 部署检查

#### 检查 Edge Function 是否已部署
```bash
# 登录 Supabase CLI
supabase login

# 列出已部署的 Edge Functions
supabase functions list

# 应该看到 'transcribe' 在列表中
```

#### 检查 GROQ_API_KEY 是否已设置
```bash
# 查看已设置的 secrets
supabase secrets list

# 应该看到 GROQ_API_KEY 在列表中
```

#### 重新部署（如果需要）
```bash
# 重新设置密钥
supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here

# 重新部署函数
supabase functions deploy transcribe --no-verify-jwt

# ⚠️ 注意：生产环境建议移除 --no-verify-jwt，确保安全
```

---

### 2️⃣ 数据库表检查

#### 检查 transcription_usage 表是否存在
在 Supabase Dashboard → SQL Editor 执行：

```sql
-- 检查表是否存在
SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE table_schema = 'public' 
  AND table_name = 'transcription_usage'
);

-- 检查表结构
\d+ public.transcription_usage;

-- 检查 RLS 策略
SELECT * FROM pg_policies WHERE tablename = 'transcription_usage';
```

#### 如果表不存在，执行以下 SQL：
```sql
-- 创建转写使用量表
CREATE TABLE IF NOT EXISTS public.transcription_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  audio_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_transcription_usage_user_date 
  ON public.transcription_usage(user_id, date);

-- 启用 RLS
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;

-- 创建策略
CREATE POLICY "transcription_usage_select_policy" ON public.transcription_usage 
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "transcription_usage_insert_policy" ON public.transcription_usage 
  FOR INSERT WITH CHECK (auth.uid() = user_id);
```

---

### 3️⃣ 网络与跨域检查

#### 浏览器开发者工具检查
打开浏览器开发者工具（F12）→ Network 标签页：

1. **查找 transcribe 请求**
   - 筛选 XHR/Fetch 请求
   - 查找 `/functions/v1/transcribe`

2. **检查请求状态码**
   - ✅ 200: 成功
   - 🔴 401: 认证失败（Token 问题）
   - 🔴 403: 权限不足
   - 🔴 404: Edge Function 未找到
   - 🔴 429: 配额超限
   - 🔴 500: 服务器错误
   - 🔴 502/503: Groq API 不可用

3. **检查请求 Headers**
   ```
   Authorization: Bearer <your-access-token>
   Content-Type: multipart/form-data
   ```

4. **检查响应内容**
   - 成功：`{ text: "转写后的文本", duration: 5.2, language: "zh" }`
   - 失败：`{ error: "错误消息", code: "ERROR_CODE" }`

---

### 4️⃣ 认证与权限检查

#### 检查用户是否已登录
```typescript
// 在浏览器控制台执行
const { data: { user } } = await supabase.auth.getUser();
console.log('Current user:', user);
```

#### 检查 Access Token 是否有效
```typescript
// 在浏览器控制台执行
const { data: { session } } = await supabase.auth.getSession();
console.log('Session:', session);
console.log('Access Token:', session?.access_token);
```

#### 如果 Token 过期，刷新 Token
```typescript
// 在浏览器控制台执行
const { data, error } = await supabase.auth.refreshSession();
console.log('Refresh result:', data, error);
```

---

### 5️⃣ Edge Function 日志检查

#### 查看 Edge Function 实时日志
```bash
# 方法 1: 使用 Supabase CLI
supabase functions logs transcribe

# 方法 2: Supabase Dashboard
# → Edge Functions → transcribe → Logs 标签页
```

#### 常见错误日志分析

**错误 1: GROQ_API_KEY not configured**
```
解决：supabase secrets set GROQ_API_KEY=gsk_xxx
```

**错误 2: Groq Error: 401**
```
原因：Groq API Key 无效或已过期
解决：
1. 访问 https://console.groq.com
2. 生成新的 API Key
3. 重新设置 secret
```

**错误 3: Groq Error: 429**
```
原因：Groq API 请求频率超限
解决：
1. 等待一段时间后重试
2. 升级 Groq 账户以提高配额
```

**错误 4: Quota check error**
```
原因：无法访问 transcription_usage 表
解决：检查数据库表和 RLS 策略是否正确
```

---

### 6️⃣ 前端代码检查

#### 检查 environment.ts 配置
确保生产环境正确配置：

```typescript
// src/environments/environment.ts
export const environment = {
  production: true,
  supabaseUrl: 'https://your-project.supabase.co',  // ✅ 正确的项目 URL
  supabaseAnonKey: 'eyJhbGc...',                      // ✅ ANON KEY（不是 SERVICE_ROLE_KEY！）
  // ...
};
```

#### 检查 Edge Function 名称配置
```typescript
// src/config/focus.config.ts
export const FOCUS_CONFIG = {
  SPEECH_TO_TEXT: {
    EDGE_FUNCTION_NAME: 'transcribe',  // ✅ 必须与部署的函数名一致
    // ...
  }
};
```

#### 调试前端调用
在浏览器控制台手动测试：

```javascript
// 1. 创建测试音频（需要真实录音 Blob）
const audioBlob = new Blob([/* 音频数据 */], { type: 'audio/webm' });

// 2. 构建 FormData
const formData = new FormData();
formData.append('file', audioBlob, 'test.webm');

// 3. 调用 Edge Function
const { data, error } = await supabase.functions.invoke('transcribe', {
  body: formData
});

console.log('Result:', data, error);
```

---

### 7️⃣ Groq API 配额检查

#### 检查 Groq 账户状态
1. 访问 https://console.groq.com
2. 查看 Dashboard → Usage
3. 确认：
   - ✅ API Key 是否有效
   - ✅ 是否有剩余配额
   - ✅ 请求频率是否在限制内

#### Groq 免费层参考限制
- 请求频率：30 requests/min
- 每日配额：14,400 requests/day
- 文件大小：每个文件最大 25MB（`FOCUS_CONFIG.SPEECH_TO_TEXT.MAX_FILE_SIZE`）
- 最新限制请查看：[console.groq.com/settings/limits](https://console.groq.com/settings/limits)

---

### 8️⃣ 常见问题速查表

| 症状 | 可能原因 | 解决方案 |
|------|---------|---------|
| 点击录音按钮无反应 | 浏览器不支持 | 检查 `MediaRecorder.isTypeSupported()` |
| 录音成功但不转写 | Edge Function 未部署 | `supabase functions deploy transcribe` |
| 返回 401 错误 | Token 无效 | 刷新 Session 或重新登录 |
| 返回 404 错误 | 函数名错误 | 检查 `EDGE_FUNCTION_NAME` 配置 |
| 返回 429 错误 | 配额超限 | 检查 Groq 或应用配额 |
| 返回 503 错误 | GROQ_API_KEY 未设置 | `supabase secrets set` |
| 转写结果为空 | 音频无声或格式问题 | 检查录音权限和音频数据 |
| 转写语言不对 | Groq 未识别为中文 | 已在 Edge Function 中设置 prompt |

---

## 🔧 完整测试流程

### Step 1: 准备工作
```bash
# 1. 确保已登录 Supabase CLI
supabase login

# 2. 链接到你的项目
supabase link --project-ref your-project-id

# 3. 设置 Groq API Key
supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here
```

### Step 2: 部署与验证
```bash
# 1. 部署 Edge Function
supabase functions deploy transcribe

# 2. 测试 Edge Function（使用真实音频文件）
curl -X POST https://your-project.supabase.co/functions/v1/transcribe \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -F "file=@test-audio.webm"

# 预期输出：
# { "text": "转写后的文本", "duration": 5.2, "language": "zh" }
```

### Step 3: 前端测试
1. 打开应用（专注模式 → 黑匣子）
2. 按住 🎙️ 按钮录音
3. 松开按钮，观察：
   - ✅ 录音时按钮应显示动画
   - ✅ 松开后应显示 "转写中..."
   - ✅ 转写完成后文本应出现在输入框
4. 检查浏览器开发者工具 Network 标签页
5. 检查 Console 是否有错误

---

## 🚨 紧急修复方案

如果以上都无效，执行完整重置：

```bash
# 1. 重新创建数据库表
# 在 Supabase SQL Editor 执行 scripts/init-supabase.sql

# 2. 重新设置 Groq API Key
supabase secrets set GROQ_API_KEY=gsk_new_key_here

# 3. 完全重新部署 Edge Function
supabase functions delete transcribe
supabase functions deploy transcribe

# 4. 清除浏览器缓存和 LocalStorage
# Chrome: F12 → Application → Clear storage

# 5. 重新登录应用
```

---

## 📞 获取帮助

如果问题仍未解决，请提供以下信息：

1. **浏览器开发者工具截图**
   - Network 标签页中的 transcribe 请求
   - Console 中的错误日志

2. **Edge Function 日志**
   ```bash
   supabase functions logs transcribe --tail 50
   ```

3. **环境信息**
   - 浏览器版本
   - 操作系统
   - Supabase 项目区域

4. **配置检查**
   - `supabase functions list` 输出
   - `supabase secrets list` 输出
   - `environment.ts` 中的 supabaseUrl

---

## ✅ 配置成功标志

当一切正常时，你应该看到：

1. **Supabase Functions 列表**
   ```
   $ supabase functions list
   ┌────────────┬─────────┬─────────┐
   │ Name       │ Status  │ Version │
   ├────────────┼─────────┼─────────┤
   │ transcribe │ ACTIVE  │ 1       │
   └────────────┴─────────┴─────────┘
   ```

2. **Secrets 列表**
   ```
   $ supabase secrets list
   GROQ_API_KEY
   ```

3. **浏览器 Network 请求**
   - Status: 200 OK
   - Response: `{ text: "...", duration: X, language: "zh" }`

4. **前端 UI**
   - 录音按钮正常工作
   - 转写结果正确显示
   - 剩余配额正确更新

完成这些检查后，转写功能应该能正常工作！🎉
