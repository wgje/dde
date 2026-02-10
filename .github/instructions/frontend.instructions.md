---
description: "前端实现规范（Angular + GoJS + Offline-first）"
applyTo: "src/**/*.ts,src/**/*.html,src/**/*.scss,src/**/*.css"
---

# Frontend Development Standards (NanoFlow)

## 组件与状态
- 组件默认 `standalone: true` + `OnPush`。
- 使用 Signals 管理状态，不引入 RxJS Store 门面。
- 新代码直接注入子服务，禁止 `inject(StoreService)`。

## Offline-first 交互
- 用户操作优先本地落地并立即更新 UI。
- 后台异步同步，失败进入重试队列。
- 避免“点击后必须等远端返回”的阻塞式体验。

## GoJS 专项
- 手机默认 Text 视图，Flow 图按需 `@defer`。
- 切换视图时必须 `diagram.clear()` 并解绑监听。
- 禁止通过 `visibility:hidden` 持有图实例。

## 性能与可访问性
- 避免模板中的高频计算。
- 大列表考虑虚拟化或分段渲染。
- 交互元素提供语义标签与键盘可达性。

## 样式约定
- 优先组件内聚样式，避免全局污染。
- 响应式采用 mobile-first。
- 复杂视觉效果需评估渲染开销与可维护性。
