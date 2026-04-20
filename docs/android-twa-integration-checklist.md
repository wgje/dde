# Android TWA 集成检查清单

> 目标：确保 Android TWA 只承担“打开 NanoFlow Web 应用并协助完成 widget bootstrap”的职责，不再承担任何桌面端 widget 运行时兼容逻辑。
> 日期：2026-04-20

## 背景与目标

Android TWA 是手机端小组件方案的一部分，但它不是 widget 本体。它的职责只有三件事：

1. 打开 Web 应用。
2. 在已有登录会话下完成 widget bootstrap。
3. 把 bootstrap 结果通过 `nanoflow-widget://bootstrap` 回传给原生宿主。

## 关键约束

1. TWA 不保存 Supabase 用户会话副本给 widget 直接使用。
2. Web 侧 bootstrap consumer 不再写任何桌面端 widget token、本地 IndexedDB 运行时配置或 Service Worker 刷新消息。
3. `entry=widget|twa` 与 `intent=` 仍是启动协议信封，未知值必须安全降级。
4. `assetlinks.json` 必须按 release 包名与证书指纹验真。
5. PostMessage 只允许作为可选 fast path，不能成为唯一必经链路。

## 实施步骤

### 安装身份与域名信任

- [x] Manifest `id` 保持 `/launch.html`，避免安装身份漂移。
- [x] 主入口保持 `./`，不把 `launch.html` 作为常规打开页。
- [ ] `assetlinks.json` 已按 release 包名与证书指纹线上验真。

### 启动契约

- [x] Android 宿主能带着 `entry=twa` 或 `entry=widget` 打开 Web。
- [x] Web 侧能解析 `intent` 并路由到工作区 / Focus 工具 / 目标项目。
- [x] 无效 `intent`、失效 `projectId/taskId` 会降级到工作区。

### Bootstrap

- [x] Web 侧能读取 Android bootstrap hash 参数。
- [x] 已登录会话下调用 `widget-register`。
- [x] 成功后生成 `nanoflow-widget://bootstrap?...` 回调 URL。
- [x] Android 宿主能消费 `widgetToken`、`bindingGeneration`、`entryUrl`。
- [ ] 完整真人登录链路证据仍需补齐。

### 容错与降级

- [x] TWA 不可用时有浏览器 Custom Tabs 回退。
- [x] 登录失效时回到正常登录流程，而不是卡死在 widget bootstrap。
- [x] bootstrap 超时不会污染原生宿主已有 token。

### 安全与隐私

- [x] Widget token 仅通过回调 URL 传回原生宿主，不落入 Web 端持久化运行时存储。
- [x] TWA 打开应用后仍遵守当前 Web 会话鉴权。
- [x] 默认隐私模式由 Android 宿主消费 `widget-summary` 状态后执行。

## 验证方式

1. 真机验证 TWA 打开 Web、登录、回调原生宿主的完整链路。
2. 断网、登录失效、软删目标、换号后验证降级路径。
3. 验证 `assetlinks.json` 在 release 包上的线上关联。
4. 验证 callback 成功后 Android Widget 能读取新的 `widget-summary`。

## 回滚或故障处理

1. 停止 TWA 发布或关闭相关 launcher activity。
2. 移除 `assetlinks.json` 发布配置。
3. 保留普通浏览器打开 NanoFlow 的能力，不影响主应用入口。
