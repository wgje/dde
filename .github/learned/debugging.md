# Debugging Knowledge

> 调试技巧和诊断方法
> 来源：[everything-claude-code Continuous Learning](https://github.com/affaan-m/everything-claude-code)

## 常用调试命令

### 查看 TypeScript 错误
```bash
npm run build 2>&1 | head -50
```

### 运行特定测试
```bash
npm test -- --filter="ServiceName"
npm test -- --run src/services/task.service.spec.ts
```

### 检查 ESLint 错误
```bash
npm run lint 2>&1 | grep -A 2 "error"
```

### 查看 Angular 编译错误
```bash
ng build --configuration=development 2>&1 | grep -E "Error:|error NG"
```

---

## Supabase 调试

### 检查 RLS 策略
```sql
-- 列出表的所有 RLS 策略
SELECT * FROM pg_policies WHERE tablename = 'tasks';

-- 测试当前用户权限
SELECT * FROM tasks LIMIT 1;
```

### 查看 Edge Function 日志
```bash
supabase functions logs transcribe --tail
```

### 检查数据库连接
```bash
supabase db status
```

---

## GoJS 调试

### 启用调试模式
```typescript
// 在 diagram 配置中
diagram.isEnabled = true;
diagram.allowSelect = true;

// 日志所有事件
diagram.addDiagramListener('ChangedSelection', (e) => {
  console.log('Selection:', e.diagram.selection.toArray());
});
```

### 检查节点数据
```typescript
diagram.nodes.each((node) => {
  console.log('Node:', node.key, node.data);
});
```

---

## Angular 调试

### 检查变更检测
```typescript
// 临时启用变更检测日志
import { enableProdMode } from '@angular/core';
// 注释掉 enableProdMode() 查看变更检测信息
```

### Signal 调试
```typescript
// 使用 effect 观察 Signal 变化
effect(() => {
  console.log('Tasks changed:', this.tasks());
});
```

### 组件状态检查
```typescript
// 在浏览器控制台
ng.getComponent(document.querySelector('app-flow-view'));
```

---

## 网络调试

### 检查同步状态
```typescript
// 在 SimpleSyncService 中添加日志
console.log('Sync state:', {
  pending: this.pendingActions.length,
  lastSync: this.lastSyncTime,
  online: navigator.onLine,
});
```

### 模拟离线
```javascript
// 浏览器控制台
navigator.onLine = false;
window.dispatchEvent(new Event('offline'));
```

---

## 性能调试

### 查看 Angular 性能
```typescript
// main.ts 中启用
import { enableProdMode } from '@angular/core';
enableProdMode();

// 或使用 Angular DevTools 浏览器扩展
```

### GoJS 性能
```typescript
// 禁用动画提升性能
diagram.animationManager.isEnabled = false;

// 批量更新
diagram.startTransaction('batch');
// ... 多次更新
diagram.commitTransaction('batch');
```

---

## 常见问题诊断

### 问题：任务不显示
1. 检查 IndexedDB 数据：`indexedDB.open('nanoflow-db')`
2. 检查 tasksMap Signal：控制台查看
3. 检查组件是否正确订阅

### 问题：同步失败
1. 检查网络状态：`navigator.onLine`
2. 检查 Supabase 认证：`supabase.auth.getUser()`
3. 查看 RetryQueue 状态

### 问题：GoJS 不渲染
1. 确认容器 div 存在
2. 检查 diagram.div 绑定
3. 确认数据模型格式正确

---

## 如何添加新调试知识

```markdown
### 标题

描述或命令
```
