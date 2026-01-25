# 🚨 401 Invalid JWT - 快速修复（1分钟解决）

## 问题现象
```
Status: 401 Unauthorized
Response: {code: 401, message: "Invalid JWT"}
```

---

## ⚡ 最快解决方案（90% 有效）

### 步骤 1: 重新登录

1. 在应用中**退出登录**
2. **重新登录**
3. 再次尝试录音转写

✅ **完成！** 大多数情况下问题已解决。

---

## 🔄 备选方案：清除浏览器缓存

如果重新登录不起作用：

### Chrome/Edge
1. F12 → **Application** 标签页
2. 左侧：**Storage** → Clear storage
3. 点击 **Clear site data**
4. 刷新页面（F5）
5. 重新登录

### Firefox
1. F12 → **Storage** 标签页
2. 右键 Local Storage → Delete All
3. 右键 Session Storage → Delete All
4. 刷新页面（F5）
5. 重新登录

### Safari
1. 开发者菜单 → 清除缓存
2. 刷新页面
3. 重新登录

---

## 🤔 为什么会出现这个错误？

**JWT Token 过期了！**

- JWT Token 默认有效期：**1 小时**
- 长时间不操作就会过期（这是安全设计）
- 重新登录会获取新的 Token

**这是正常现象，不是 bug！** ✅

---

## 🔍 仍未解决？

### 方案 A: 浏览器控制台手动刷新

在网站打开控制台（F12），复制粘贴并执行：

```javascript
// 自动加载 SDK 并刷新 Token
(async () => {
  // 加载 Supabase SDK
  if (!window.supabase) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    document.head.appendChild(script);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // 配置（替换成你的）
  const url = 'https://fkhihclpghmmtbbywvoj.supabase.co';
  const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZraGloY2xwZ2htbXRiYnl3dm9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgwNDIyMTgsImV4cCI6MjA4MzYxODIxOH0.4Z5eylbmBA-YFiDRvDtom4lTHavHP3JfVmrU0yH9oVo';
  
  const sb = window.supabase.createClient(url, key);
  
  // 刷新 Token
  const { data, error } = await sb.auth.refreshSession();
  if (error) {
    console.error('❌ 刷新失败，请重新登录');
    await sb.auth.signOut();
    alert('请刷新页面并重新登录');
  } else {
    console.log('✅ Token 已刷新！');
    alert('Token 已刷新，请重新尝试录音');
  }
})();
```

### 方案 B: 隐私/无痕模式测试

1. 打开浏览器无痕窗口
2. 访问应用
3. 登录
4. 测试录音转写

如果无痕模式可以工作，说明是浏览器扩展或缓存问题。

---

## 📞 技术支持

如果以上方案都不起作用，提供以下信息以便诊断：

1. **浏览器信息**
   - 浏览器名称和版本
   - 操作系统

2. **错误详情**
   - F12 → Network → transcribe 请求的截图
   - F12 → Console 的完整错误日志

3. **尝试过的方案**
   - 哪些方案尝试过
   - 每个方案的结果

---

## ✅ 成功标志

问题解决后，你应该看到：

- Network 请求：Status **200 OK** ✅
- Response：`{"text":"转写后的文本",...}` ✅
- 前端 UI：转写结果正确显示 ✅

---

**记住**：401 错误 = Token 过期 = **重新登录** 👍
