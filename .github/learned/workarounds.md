# Workarounds

> 框架和库的特殊处理和变通方案
> 来源：[everything-claude-code Continuous Learning](https://github.com/affaan-m/everything-claude-code)

## GoJS

### 移动端 visibility:hidden 问题

**问题**: 使用 `visibility:hidden` 隐藏 GoJS 图表会导致内存泄漏

**变通方案**: 完全销毁并重建 GoJS 实例
```typescript
// ❌ 不要这样做
diagram.div.style.visibility = 'hidden';

// ✅ 正确做法
diagram.clear();
diagram.div = null;
// 需要时重新创建
```

### 触摸事件延迟

**问题**: GoJS 在移动端触摸事件有 300ms 延迟

**变通方案**: 配置 `doubleTapTime` 和 `holdDelay`
```typescript
diagram.toolManager.doubleTapTime = 100;
diagram.toolManager.holdDelay = 150;
```

---

## iOS Safari

### 录音 webm 不支持

**问题**: iOS Safari 不支持 webm 音频格式

**变通方案**: 动态检测并回退
```typescript
const mimeType = MediaRecorder.isTypeSupported('audio/webm')
  ? 'audio/webm'
  : 'audio/mp4';

const recorder = new MediaRecorder(stream, { mimeType });
```

### PWA 安装提示

**问题**: iOS Safari 不触发 `beforeinstallprompt` 事件

**变通方案**: 手动检测 iOS 并显示安装指引
```typescript
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

if (isIOS && !isStandalone) {
  showIOSInstallGuide();
}
```

---

## Angular

### Zone.js 与 IndexedDB

**问题**: IndexedDB 操作触发不必要的变更检测

**变通方案**: 在 NgZone 外执行 IndexedDB 操作
```typescript
constructor(private ngZone: NgZone) {}

async loadData() {
  return this.ngZone.runOutsideAngular(async () => {
    const db = await openDB('app-db', 1);
    return db.getAll('tasks');
  });
}
```

### Signals 与 Effects 循环

**问题**: Effect 中修改 Signal 导致无限循环

**变通方案**: 使用 `untracked` 或条件检查
```typescript
effect(() => {
  const value = this.sourceSignal();
  
  // 使用 untracked 避免循环
  if (value !== untracked(this.targetSignal)) {
    this.targetSignal.set(value);
  }
});
```

---

## Supabase

### 实时订阅断开重连

**问题**: 网络不稳定时实时订阅断开

**变通方案**: 实现重连逻辑
```typescript
const channel = supabase
  .channel('tasks')
  .on('postgres_changes', { event: '*', schema: 'public' }, handler)
  .subscribe((status) => {
    if (status === 'CHANNEL_ERROR') {
      setTimeout(() => channel.subscribe(), 5000);
    }
  });
```

### Edge Function 冷启动

**问题**: Edge Function 首次调用延迟高

**变通方案**: 预热请求或增加超时
```typescript
// 预热
fetch(`${SUPABASE_URL}/functions/v1/transcribe`, { method: 'OPTIONS' });

// 增加超时
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
```

---

## 如何添加新变通方案

```markdown
### 简短标题

**问题**: 描述问题

**变通方案**: 解决方案
代码示例
```
