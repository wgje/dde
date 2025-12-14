# "操作失败，请稍后重试" 错误深入分析

## 🔍 问题现象

用户在登录后立即看到阻断性错误提示框：
```
出错了
操作失败，请稍后重试
```

## 📊 错误流程追踪

### 1. 错误消息来源

该消息在以下3个地方定义：

1. **`global-error-handler.service.ts:353`**
   ```typescript
   private getUserMessage(errorMessage: string): string {
     // ... 匹配规则 ...
     return '操作失败，请稍后重试';  // 默认fallback
   }
   ```

2. **`utils/result.ts:182` 和 `result.ts:204`**
   ```typescript
   export function humanizeErrorMessage(errorMessage: string): string {
     if (!errorMessage) {
       return '操作失败，请稍后重试';
     }
     // ... 其他转换逻辑 ...
     if (looksLikeTechnical) {
       return '操作失败，请稍后重试';
     }
   }
   ```

### 2. 错误显示触发条件

在 `app.component.html:7` 中：
```html
@if (bootstrapFailed() && !isCheckingSession()) {
  <!-- 显示错误提示框 -->
}
```

只有当 `bootstrapFailed === true` 时才显示。

### 3. `bootstrapFailed` 设置位置

在 `app.component.ts` 的 `bootstrapSession()` 方法中：

```typescript
private async bootstrapSession() {
  try {
    const result = await this.auth.checkSession();
    if (result.userId) {
      await this.store.setCurrentUser(result.userId);
    }
  } catch (e: any) {
    // 唯一设置 bootstrapFailed 的地方
    this.bootstrapFailed.set(true);
    this.bootstrapErrorMessage.set(errorMsg);
  }
}
```

## 🎯 关键发现

### 发现 1: `checkSession` 不会抛出异常

```typescript
// auth.service.ts
async checkSession(): Promise<{ userId: string | null; email: string | null }> {
  try {
    // ... 
    if (error) {
      throw error;  // ← 这里抛出
    }
    // ...
  } catch (e: any) {
    // ← 但这里会捕获
    console.error('[Auth] checkSession 异常:', e?.message ?? e);
    return { userId: null, email: null };  // ← 返回 null 而不是抛出
  }
}
```

**结论**: `checkSession()` 内部捕获了所有异常并返回 `{ userId: null, email: null }`，**不会向上抛出异常**。

### 发现 2: `setCurrentUser` 不会抛出异常

```typescript
// user-session.service.ts  
async setCurrentUser(userId: string | null): Promise<void> {
  // 清理操作有独立 try-catch
  if (isUserChange) {
    try { /* 清理 */ } 
    catch (cleanupError) { /* 捕获 */ }
  }
  
  // 数据加载有独立 try-catch
  if (userId) {
    try { await this.loadUserData(userId); }
    catch (error) { 
      try { this.loadFromCacheOrSeed(); }
      catch (fallbackError) { /* 捕获 */ }
      // 不重新抛出 ✓
    }
  }
}
```

**结论**: `setCurrentUser()` 内部完全处理了所有异常，**不会向上抛出异常**。

### 🚨 问题结论

**理论上，`bootstrapSession` 的 catch 块永远不应该被触发！**

因为：
1. `checkSession()` 不抛出异常
2. `setCurrentUser()` 不抛出异常

那么问题在哪里？

## 🔬 可能的原因分析

### 原因 1: 代码未部署/未生效

可能修复代码还未部署到 Vercel，用户看到的是旧版本代码。

### 原因 2: 其他未知异常

可能在以下位置抛出异常：
- `result.userId` 的访问（如果 result 是 undefined）
- `this.sessionEmail.set()` 调用
- `this.store.setCurrentUser()` 调用本身（不是内部）

### 原因 3: 同步vs异步时机问题

可能在某些竞态条件下，异常在不同的时机抛出。

### 原因 4: 之前的错误状态未清除

如果之前设置了 `bootstrapFailed = true`，而没有被重置。

## 🛠️ 诊断增强

已添加详细日志：

1. **`bootstrapSession`**: 分步骤记录，包含耗时
2. **`checkSession`**: 详细的调用链追踪
3. **错误详情**: 完整的 stack、message、cause

## 📋 下一步行动

1. ✅ 添加详细日志（已完成）
2. ⏳ 部署并观察浏览器控制台
3. ⏳ 确认实际的错误堆栈
4. ⏳ 根据日志确定真正的异常来源

## 🔑 关键代码路径

```
用户刷新页面
  ↓
AppComponent.constructor()
  ↓
this.bootstrapSession()
  ↓
[try块开始]
  ↓
auth.checkSession()  ← 不抛出异常，返回 {userId, email}
  ↓
if (result.userId) {
  ↓
  store.setCurrentUser(userId)  ← 不抛出异常
}
  ↓
[try块结束]
  ↓
[catch块] ← 理论上不会执行
  ↓
bootstrapFailed.set(true)  ← 不应该执行
```

## 📝 待验证假设

1. **假设1**: 错误在 `checkSession()` 返回后、访问 `result.userId` 之前抛出
2. **假设2**: 错误在 Supabase 客户端库内部抛出，绕过了 try-catch
3. **假设3**: 错误是由于未捕获的 Promise rejection
4. **假设4**: 环境配置问题导致 Supabase 初始化失败

## 🎯 预期日志输出

正常情况下应该看到：
```
[Bootstrap] ========== 启动会话检查 ==========
[Bootstrap] 步骤 1/3: 调用 auth.checkSession()...
[Auth] ========== checkSession 开始 ==========
[Auth] 正在调用 supabase.getSession()...
[Auth] getSession() 返回 (耗时 XXms)
[Auth] 会话状态: ✓ 存在
[Auth] 用户已登录: { userId: "xxx...", email: "..." }
[Auth] ========== checkSession 成功 ==========
[Bootstrap] 步骤 1/3: checkSession 完成 (耗时 XXms)
[Bootstrap] 步骤 2/3: 用户已登录，开始加载数据...
[Session] setCurrentUser ...
[Session] loadUserData ...
[Bootstrap] 步骤 2/3: 数据加载完成 (耗时 XXms)
[Bootstrap] ========== 启动成功 ==========
```

错误情况应该看到具体的异常信息和堆栈。
