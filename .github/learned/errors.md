# Error Resolutions

> 记录常见错误及其解决方案
> 来源：[everything-claude-code Continuous Learning](https://github.com/affaan-m/everything-claude-code)

## TypeScript 错误

### TS2345: Argument type not assignable

**场景**: Supabase 查询结果类型不匹配

**解决方案**:
```typescript
// 问题
const { data } = await supabase.from('tasks').select('*');
processTask(data); // TS2345: data 可能是 null

// 解决
const { data, error } = await supabase.from('tasks').select('*');
if (error || !data) return failure(ErrorCodes.DATA_NOT_FOUND);
processTask(data); // ✅ 类型安全
```

### TS2322: Type is not assignable

**场景**: Signal 类型推断问题

**解决方案**:
```typescript
// 问题
const tasks = signal([]); // Signal<never[]>

// 解决
const tasks = signal<Task[]>([]); // Signal<Task[]>
```

---

## Angular 错误

### NG0100: ExpressionChangedAfterItHasBeenChecked

**场景**: 在 ngAfterViewInit 中修改绑定值

**解决方案**:
```typescript
// 使用 setTimeout 或 ChangeDetectorRef
ngAfterViewInit() {
  setTimeout(() => {
    this.value = newValue;
  });
  // 或
  this.cdr.detectChanges();
}
```

### NG0200: Circular dependency

**场景**: 服务间循环依赖

**解决方案**:
1. 使用 `inject()` 延迟注入
2. 拆分服务职责
3. 引入中间服务

---

## Supabase 错误

### PGRST301: JWT expired

**场景**: 认证 token 过期

**解决方案**:
```typescript
// 在 auth.service.ts 中监听认证状态变化
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED') {
    // Token 已自动刷新
  }
  if (event === 'SIGNED_OUT') {
    // 重定向到登录页
  }
});
```

### 42501: RLS policy violation

**场景**: Row Level Security 阻止操作

**解决方案**:
1. 检查 RLS 策略是否正确
2. 确保 user_id 匹配
3. 使用 `supabase.auth.getUser()` 确认当前用户

---

## GoJS 错误

### Maximum call stack size exceeded

**场景**: 递归布局计算

**解决方案**:
```typescript
// 使用迭代算法替代递归
const MAX_DEPTH = 100;
let depth = 0;
const stack = [rootNode];

while (stack.length > 0 && depth < MAX_DEPTH) {
  const node = stack.pop();
  // 处理节点
  stack.push(...node.children);
  depth++;
}
```

---

## 如何添加新错误

```markdown
### 错误代码或名称

**场景**: 何时发生

**解决方案**:
代码示例或步骤
```
