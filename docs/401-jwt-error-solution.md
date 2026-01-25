# 401 Invalid JWT 错误解决方案

## 🚨 问题现象

```
Request URL: https://fkhihclpghmmtbbywvoj.supabase.co/functions/v1/transcribe
Status Code: 401 Unauthorized
Response: {code: 401, message: "Invalid JWT"}
```

---

## ✅ 快速解决方案（按顺序尝试）

### 方案 1: 简单重新登录（成功率 90%）

1. 在应用中找到退出登录按钮
2. 点击退出
3. 重新登录
4. 再次尝试录音转写

✅ **如果这样就解决了，说明是 Token 过期问题，正常现象。**

---

### 方案 2: 清除浏览器存储

**步骤：**
1. 按 F12 打开开发者工具
2. 切换到 **Application** 标签页
3. 左侧菜单：
   - Storage → Local Storage → 选择你的域名 → 右键 → Clear
   - Session Storage → 选择你的域名 → 右键 → Clear
   - Cookies → 选择你的域名 → 右键 → Clear
4. 刷新页面（F5）
5. 重新登录

---

### 方案 3: 浏览器控制台刷新 Token

如果你想深入调试，在浏览器控制台（F12 → Console）执行：

```javascript
// 1. 动态加载 Supabase JS SDK
const script = document.createElement('script');
script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
document.head.appendChild(script);

// 等待加载完成（约 1-2 秒）
await new Promise(resolve => setTimeout(resolve, 2000));

// 2. 创建客户端
const { createClient } = window.supabase;
const supabaseUrl = 'https://fkhihclpghmmtbbywvoj.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZraGloY2xwZ2htbXRiYnl3dm9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgwNDIyMTgsImV4cCI6MjA4MzYxODIxOH0.4Z5eylbmBA-YFiDRvDtom4lTHavHP3JfVmrU0yH9oVo';

const supabase = createClient(supabaseUrl, supabaseKey);

// 3. 检查当前 Session
const { data: sessionData } = await supabase.auth.getSession();
console.log('📋 当前 Session:', sessionData.session);

if (!sessionData.session) {
  console.error('❌ 没有 Session，需要重新登录');
} else {
  console.log('✅ Session 存在');
  console.log('🔑 Access Token (前50字符):', sessionData.session.access_token.substring(0, 50) + '...');
  console.log('⏰ 过期时间:', new Date(sessionData.session.expires_at * 1000).toLocaleString());
  
  // 检查是否过期
  const now = Date.now() / 1000;
  const expiresAt = sessionData.session.expires_at;
  const timeLeft = Math.round((expiresAt - now) / 60);
  
  if (timeLeft < 0) {
    console.error(`❌ Token 已过期 ${Math.abs(timeLeft)} 分钟`);
    console.log('🔄 尝试刷新 Token...');
    
    // 4. 刷新 Token
    const { data: refreshData, error } = await supabase.auth.refreshSession();
    if (error) {
      console.error('❌ 刷新失败:', error.message);
      console.log('💡 解决方案: 重新登录');
      await supabase.auth.signOut();
    } else {
      console.log('✅ Token 刷新成功！');
      console.log('🆕 新 Token (前50字符):', refreshData.session.access_token.substring(0, 50) + '...');
      console.log('🔄 请刷新页面后重试');
    }
  } else {
    console.log(`⏳ Token 剩余有效时间: ${timeLeft} 分钟`);
    console.log('🤔 Token 没有过期，但仍返回 401，可能原因：');
    console.log('   1. Edge Function 的 JWT 验证配置问题');
    console.log('   2. Token 被浏览器扩展拦截/修改');
    console.log('   3. CORS 或网络代理问题');
  }
}

// 5. 测试用户认证
const { data: userData, error: userError } = await supabase.auth.getUser();
if (userError) {
  console.error('❌ 获取用户信息失败:', userError.message);
} else {
  console.log('✅ 用户信息:', userData.user);
}
```

---

## 🔍 深度诊断

### 检查 1: 验证 Edge Function 是否正确部署

```bash
# 列出所有 Edge Functions
supabase functions list

# 预期输出应包含：
# transcribe    ACTIVE    1+
```

### 检查 2: 查看 Edge Function 日志

```bash
# ✅ 正确命令
supabase functions logs transcribe --tail 50

# 查找关键错误：
# - "Invalid token" - Token 问题
# - "AUTH_INVALID" - 认证失败
# - "GROQ_API_KEY not configured" - 密钥未设置
```

### 检查 3: 测试 Edge Function（绕过前端）

使用 curl 直接测试（需要先获取有效 Token）：

```bash
# 1. 从浏览器控制台获取 Token
# 执行上面的脚本，复制 Access Token

# 2. 测试 Edge Function
curl -X POST "https://fkhihclpghmmtbbywvoj.supabase.co/functions/v1/transcribe" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE" \
  -F "file=@test-audio.webm"

# 如果返回 401，说明 Token 确实有问题
# 如果返回 200，说明是前端发送 Token 的逻辑有问题
```

---

## 🛠️ Edge Function JWT 验证问题排查

### 可能的配置问题

1. **Edge Function 部署时使用了 `--no-verify-jwt`**
   
   如果部署时用了这个选项，但代码中仍然验证 JWT，会导致问题：
   
   ```bash
   # ❌ 如果之前这样部署的
   supabase functions deploy transcribe --no-verify-jwt
   
   # ✅ 重新部署（移除该选项）
   supabase functions deploy transcribe
   ```

2. **JWT Secret 不匹配**
   
   Edge Function 使用的 JWT Secret 必须与 Supabase 项目一致。这是自动配置的，但如果手动修改过可能出问题。

---

## 📝 检查清单

完成以下检查，找出问题所在：

- [ ] **用户已登录** - 在应用界面确认显示用户信息
- [ ] **Token 未过期** - 执行上面的脚本查看剩余时间
- [ ] **Edge Function 已部署** - `supabase functions list` 显示 ACTIVE
- [ ] **GROQ_API_KEY 已设置** - `supabase secrets list` 显示密钥
- [ ] **浏览器时间正确** - 检查系统时间是否与实际时间一致
- [ ] **无浏览器扩展干扰** - 尝试隐私/无痕模式

---

## 💡 预防措施

### 1. 自动刷新 Token

确保前端代码正确配置了自动刷新：

```typescript
// src/services/supabase-client.service.ts
createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,  // ✅ 确保启用
    persistSession: true,     // ✅ 确保启用
  }
})
```

### 2. 监听 Token 过期事件

```typescript
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED') {
    console.log('Token 已刷新');
  }
  if (event === 'SIGNED_OUT') {
    console.log('用户已登出');
  }
});
```

### 3. 请求前验证 Token

```typescript
// 在发送转写请求前
const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  // 重新登录
  throw new Error('Session expired, please login again');
}

// 检查是否快要过期（剩余 < 5 分钟）
const timeLeft = (session.expires_at * 1000 - Date.now()) / 1000 / 60;
if (timeLeft < 5) {
  await supabase.auth.refreshSession();
}
```

---

## ✅ 解决后的验证

当问题解决后，你应该看到：

### 浏览器开发者工具 Network
```
Request URL: .../functions/v1/transcribe
Status: 200 OK ✅
Response: {"text":"转写后的文本","duration":5.2,"language":"zh"}
```

### 浏览器控制台
```javascript
✅ Session 存在
🔑 Access Token (前50字符): eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJh...
⏰ 过期时间: 2026-01-25 19:51:56
⏳ Token 剩余有效时间: 55 分钟
```

---

## 🎯 总结

**401 Invalid JWT 错误的本质**：
- 你的 Access Token 已过期或无效
- 这是**正常现象**，JWT Token 设计就是会过期的（安全考虑）

**最快的解决方案**：
1. 重新登录（90% 情况可以解决）
2. 如果频繁出现，检查前端是否启用了 `autoRefreshToken: true`

**如果重新登录也不行**：
- 检查 Edge Function 部署状态
- 查看 Edge Function 日志找具体错误
- 使用上面的诊断脚本深度排查
