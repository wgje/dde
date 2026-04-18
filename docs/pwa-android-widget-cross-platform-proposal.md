# NanoFlow 跨端桌面小组件（Widget）策划案

> 版本：v5.1（保留 v2.0-v5.0 历史层）  
> 日期：2026-04-12  
> 状态：持续扩展中，含 v5.1 结构化清理  
> 适用范围：Android Home Widget、Windows 11 Widgets Board、PWA 快捷入口  
> 结论一句话：可以做，但当前最需要先压平的已经不只是载体选型，而是 webhook 鉴权模型、时间语义、缓存语义、账号切换回收、以及多实例/多窗口下的假阳性预算。

---

## 0. 本版相对 v1.0 的关键纠偏

v1.0 的主要问题不是信息不够多，而是把若干“尚不存在的能力”写成了“现成功能”，这会直接制造后续实施阶段的假阳性。v2.0 的修订目标不是把文档写得更热闹，而是把真实边界、真实阻塞点、真实验证条件写清楚。

本版已明确纠偏的点：

- 当前应用没有独立的 `focus`、`dock`、`capture` 顶级路由，只有基于 `withHashLocation()` 的 `#/projects...` 路由体系。
- 当前云侧与 Dock / Focus 相关的主同步通路是 `focus_sessions.session_state`，不是把 `user_preferences.dock_snapshot` 当运行时权威源。
- 当前同步模型是 `本地先写 + 3s 防抖 + 后台重试 + 浏览器挂起延后`，因此“即时同步”必须写成带上限和降级条件的 SLA，而不是绝对表述。
- Windows PWA Widget 不是把现有 Web UI 塞进 Widget Board，而是要单独设计 Adaptive Cards 模板与 Service Worker 事件处理。
- Android Widget 不是“PWA 再包一层就行”，而是独立的原生 Android 工程能力，TWA 只负责打开 NanoFlow Web 应用，不负责替代原生 Widget。
- `launch.html` 当前是历史安装身份兼容入口，不是第二个正式启动入口；任何 Widget / 快捷入口方案都不能重新把它变成产品侧主入口。

### 0.1 v5.1 阅读说明

v5.1 的目标不是继续扩散方案，而是把前文仍可能误导实施的历史判断在原位显式标记清楚。

- 看到 `v5.1 覆盖说明` 时，表示该段落仍保留作历史推导、API 能力示意或阶段性分析，但实施时不得直接照抄。
- 若旧段落与后文冲突，以 `v5.0` / `v5.1` 章节及其引用的官方约束为准。
- 对于 `verify_jwt`、HTTP 缓存、“今日统计”、Windows 打开策略、TWA PostMessage 这五类问题，应优先查阅第 41-49 节及本次插入的原位覆盖标记。

### 0.2 实施与验收文档主从关系

为避免后续实施继续直接从这份长文档手工摘结论，自 v5.1 起补充两份派生文档：

- `docs/pwa-android-widget-cross-platform-implementation-checklist.md`：实施版 checklist，负责把本案约束反向收敛为可执行门禁。
- `docs/pwa-android-widget-cross-platform-execution.md`：执行与验收文档，后续阶段目标、证据记录和验收以该文档为准。

维护规则：

- 若后续实施过程中发现本文件存在纰漏、遗漏项或与真实实现不符之处，必须至少同步补充本文件和执行文档。
- 若新增信息改变了阶段动作项、门禁或验收边界，应同步更新实施版 checklist，避免 proposal、checklist、execution 三者漂移。

---

## 1. 研究依据与审计范围

本策划案基于三类证据源整理，而不是基于泛化经验判断。

### 1.1 仓库实现审计

已核对的核心实现包括但不限于：

- `public/manifest.webmanifest`
- `main.ts`
- `src/app.routes.ts`
- `src/services/sw-registration-strategy.ts`
- `ngsw-config.json`
- `src/config/sync.config.ts`
- `src/app/core/services/sync/focus-console-sync.service.ts`
- `src/services/dock-cloud-sync.service.ts`
- `src/services/dock-snapshot-persistence.service.ts`
- `src/services/black-box.service.ts`
- `src/models/parking.ts`
- `src/models/parking-dock.ts`
- `src/models/focus.ts`
- `src/models/supabase-types.ts`
- `supabase/migrations/20260315200000_consolidated_focus_console_and_security.sql`
- `src/tests/startup-contract.spec.ts`
- `src/app/core/services/sync/user-preferences-sync.service.spec.ts`
- `vercel.json`
- `netlify.toml`

### 1.2 官方文档研究

本轮研究核对了以下官方资料中的关键约束：

- Chrome Developers：Trusted Web Activity overview、TWA PostMessage
- Android Developers：App Widgets Overview、Jetpack Glance
- Microsoft Learn：Display a PWA widget in the Windows Widgets Board
- Supabase Docs：Database Webhooks、Push Notifications with Edge Functions

### 1.3 线上 Supabase 项目快照（2026-04-12 研究时点）

以下信息来自本次研究时点的 Supabase 实时查询结果，不属于仓库静态事实。进入正式实施前，应重新执行一次同等粒度的 live check，避免把时点快照误当长期真相。

本次研究时点核对到的项目基线：

- 项目 Ref：`fkhihclpghmmtbbywvoj`
- 状态：`ACTIVE_HEALTHY`
- Region：`ap-south-1`
- PostgreSQL：`17.6`
- 已部署 Edge Functions：`transcribe`、`backup-full`、`backup-restore`、`backup-incremental`、`backup-cleanup`
- 尚不存在任何 Widget 相关 Edge Function

本次研究时点观察到的 advisor 信息：

- Security Advisor：存在 mutable `search_path` 告警；本次快照指向 `public.cascade_soft_delete_connections`，正式实施前需重新核验告警对象是否仍存在
- Security Advisor：Auth 的 leaked password protection 当前关闭
- Performance Advisor：存在若干未覆盖索引的外键与重复 permissive RLS policy 警告，其中与本提案最相关的是 `black_box_entries.project_id` 与 `routine_completions.routine_id` 的未覆盖外键索引

这些告警并不直接否决 Widget 能力，但它们应被列为上线前门禁，并且在实施前重新验证，而不是被忽略或当成永久不变事实。

---

## 2. 执行结论

### 2.1 结论表

| 方向 | 结论 | 现在是否建议立项 | 备注 |
| --- | --- | --- | --- |
| PWA 快捷入口（manifest shortcuts） | 可做 | 建议立即纳入 P0 | 需要先补路由意图协议，不能直接指向不存在的页面 |
| Windows 11 PWA Widget | 可做，但必须先做 PoC | 建议条件性立项 | 核心阻塞是 Service Worker 组合与认证模型 |
| Android 原生 Widget | 可做，但不是纯 PWA 方案 | 暂不建议直接全量立项 | 需要原生 Android 工程、FCM、Glance、设备适配 |
| Android TWA 壳 | 可做 | 可作为 Android Widget 配套壳层 | TWA 不等于 Widget，本身不能解决 Widget 数据隔离 |
| 跨端“硬实时”同步 | 不建议承诺 | 不建议写进对外产品文案 | 当前架构只能做到近实时、最终一致 |
| Widget 直接写任务状态 | 当前不建议 | 不建议纳入 MVP | 会绕过现有 offline-first 与 RetryQueue 约束 |

### 2.2 推荐路线

推荐路线不是“先 Android、后补 Windows”，而是：

1. P0：先补 Web 快捷入口、深链协议、云侧摘要接口基础。
2. P1：建立统一的 `widget device + summary token + summary function` 基础设施。
3. P1.5：先做 Windows PWA Widget PoC，验证 Service Worker 组合、模板渲染、认证路径是否稳定。
4. P2：Windows PoC 通过后，再做 Android 原生 Widget + TWA 壳。
5. P3：最后才讨论 Widget 内部写操作，而不是一开始就设计“点击 Widget 直接改任务状态”。

### 2.3 为什么是这个顺序

- Windows 路线能先验证“摘要读模型、深链、认证、隐私、陈旧态 UI”这些跨平台共性问题，而不必一开始就背上 Android 原生工程与 OEM 兼容成本。
- Android 真正困难的部分不是打开 PWA，而是原生 Widget 的生命周期、后台限制、推送、缓存与凭证管理。
- 当前仓库已经有成熟的 offline-first Web 主干，但还没有 Widget 专属的认证与摘要通路。先补这层基础设施，能降低双端同时推进的返工风险。

---

## 3. NanoFlow 当前实现基线

这一节是本策划案最重要的现实约束。后续方案若与这里冲突，以这里为准。

### 3.1 启动身份与深链约束

当前已验证事实：

| 主题 | 当前事实 | 对 Widget / 快捷入口的影响 |
| --- | --- | --- |
| Manifest ID | `id = "/launch.html"` | 不能随意改，否则历史安装身份会漂移 |
| Start URL | `start_url = "./"` | 正式入口是根路径，不是 `launch.html` |
| `launch.html` | 历史兼容入口，只保留 alias 语义 | 任何新入口都不应把 `launch.html` 当产品主入口 |
| Router 模式 | `withHashLocation()` | 深链必须是 `/#/...` 风格，而不是 History 路由风格 |
| 当前顶级路由 | `#/projects`、`#/reset-password`、`#/error`、`#/not-found` | 当前不存在 `#/focus`、`#/dock`、`#/capture` |

设计含义：

- Widget / shortcut / TWA 深链不能写成 `/focus`、`/dock`、`/capture` 这种“看起来合理”的 URL，因为当前代码并不支持。
- 所有新入口都应复用当前工作区壳层，例如：`./#/projects?...`，再由壳层根据 `query` 或 `fragment` 做意图分发。
- `launch.html` 只能继续承担历史入口兼容与升级职责，不能再被做成一个看似独立的第二启动面。

### 3.2 当前与 Widget 相关的真实数据主干

当前真实主干不是单表，而是多条数据线并存：

| 数据项 | 当前主源 | 当前用途 | 说明 |
| --- | --- | --- | --- |
| 任务停泊状态 | `tasks.parking_meta` | 任务领域真值 | 任务级别语义权威源 |
| Dock / Focus 快照 | `focus_sessions.session_state` | 当前云侧 Focus Console 主同步通路 | 当前最接近“Widget 可直接消费的摘要读模型” |
| 日常任务定义 | `routine_tasks` | Focus Console 日常任务 | 可用于 Widget 统计 |
| 日常完成记录 | `routine_completions` | Focus Console 累计完成 | 可用于当日完成数 |
| Black Box 条目 | `black_box_entries` | 跨项目待处理内容 | 当前创建路径下 `projectId` 可为空，不应误判为项目绑定 |
| `dock_snapshot` | `user_preferences.dock_snapshot` | 历史或兼容字段 | 当前运行时用户偏好同步明确不走这条路径 |

特别说明：

- `src/app/core/services/sync/user-preferences-sync.service.spec.ts` 已显式约束：运行时的 user preferences 同步路径不读取、不持久化 `dock_snapshot`。
- `src/services/dock-cloud-sync.service.ts` 当前是通过 `focus_sessions` 同步 `DockSnapshot`，因此本提案必须把 `focus_sessions` 视为现阶段 Widget 云侧摘要的首要数据源，而不是把 `dock_snapshot` 当权威源。

> v5.1 覆盖说明：本表中“日常任务定义 / 日常完成记录可用于 Widget 统计”仅表示这些表在数据层可被后续方案利用，不代表它们已适合进入当前跨端 Widget MVP。关于“今日统计”为什么暂不应承诺，以第 44 节为准。

### 3.3 当前同步语义

当前同步关键参数：

| 参数 | 当前值 | 含义 |
| --- | --- | --- |
| `SYNC_CONFIG.DEBOUNCE_DELAY` | `3000ms` | 本地更新到云端写入至少有 3 秒防抖 |
| `SYNC_CONFIG.POLLING_ACTIVE_INTERVAL` | `120000ms` | 活跃轮询 2 分钟 |
| `SYNC_CONFIG.POLLING_INTERVAL` | `600000ms` | 后台轮询 10 分钟 |
| `SYNC_CONFIG.REALTIME_ENABLED` | `false` | 默认不依赖 Realtime |
| 浏览器挂起处理 | 已内置 defer / retry | 可见性恢复窗口内不会把挂起误判成真实失败 |

这意味着：

- 本地 UI 级即时，不等于云端立即可见。
- Widget 看到的永远只能是“已提交到云端的状态”或“设备本地原生缓存状态”，而不是 Web 进程里尚未 flush 的本地状态。
- 任何跨端同步文案都不能用“秒级绝对实时”描述，应改成“近实时云同步，带陈旧态提示”。

### 3.4 当前 Service Worker 与构建链约束

当前 Service Worker 不是自定义实现，而是标准 Angular NGSW：

- `main.ts` 当前注册：`provideServiceWorker('ngsw-worker.js', ...)`
- 注册时机：`createPostHandoffSwRegistrationStrategy()`，不是首包立刻注册
- 构建后存在多个与 `launch.html` / NGSW 相关的后处理脚本：
  - `generate-launch-html.cjs`
  - `inject-modulepreload.cjs`
  - `patch-ngsw-html-hashes.cjs`
  - `validate-launch-shared-markers.cjs`
  - `validate-launch-artifact-closure.cjs`

这直接带来一个关键判断：

- Windows Widget 不能粗暴地“直接改 NGSW 产物”作为长期方案。
- 更合理的方向是注册一个组合 Service Worker，例如 `sw-composed.js`，在其中 `importScripts('./ngsw-worker.js', './widgets/widget-runtime.js')`，而不是继续增加 build 后 patch 的复杂度。

### 3.5 当前部署侧约束

当前部署配置已验证：

- `vercel.json` 已对 `ngsw-worker.js` 和 `ngsw.json` 设置 `no-cache`
- `netlify.toml` 目前没有看到对 `ngsw-worker.js` 的显式 `no-cache` 头配置

实施含义：

- 如果引入 `sw-composed.js`，部署配置必须同步对 `sw-composed.js` 设置 `no-cache`。
- 如果未来在 Netlify 或私有部署中落地 Widget 能力，需要同步补齐 `ngsw-worker.js` / `sw-composed.js` 的缓存头，不然非常容易出现线上 SW 版本漂移，而这类漂移恰好会直接体现在 Widget 空白、旧模板、旧数据上。

### 3.6 当前线上安全与性能门禁

当前应在进入 Widget 项目前优先关注：

#### 安全门禁

以下门禁基于 2026-04-12 的 advisor 快照提出，进入实施阶段前必须重新跑一次 live advisor：

- 清零当前 mutable `search_path` 告警（研究时点快照指向 `public.cascade_soft_delete_connections`）
- 开启 Auth 的 leaked password protection
- 【已被 v5.0 §41 / v5.1 / 2026-04-13 live ES256 验证共同覆盖】“新增 Widget 相关 Edge Function 时默认 `verify_jwt = true`”仅保留为早期安全直觉；现在必须按函数职责拆分：`widget-register = false + 函数内 auth.getUser(token)`，`widget-summary = false`，`widget-notify` 仅在前置 trusted gateway / signer 时可为 `true`，direct webhook 默认按 `false + 自定义鉴权` 处理
- 任何 Widget 设备令牌、Push Token、摘要函数都不能走前端硬编码密钥

#### 性能门禁

- 为 `black_box_entries.project_id` 的外键补索引评估
- 为 `routine_completions.routine_id` 的外键补索引评估
- 如果 Widget 热路径大量读取 `tasks` / `connections`，要复核重复 permissive policy 对查询性能的影响

这些问题不是“与 Widget 无关”，而是“当前还没压平的底噪”。新功能越靠近认证、推送和高频查询，这些底噪越容易被放大。

---

## 4. 产品边界与成功标准

### 4.1 本提案的产品目标

本提案真正要解决的是三个目标，而不是“把桌面小组件做出来”这么宽泛：

1. 让用户在不打开 NanoFlow 主应用时，也能看到可信的 Focus / Dock / Black Box 摘要。
2. 让用户能从 Widget 或快捷入口稳定进入 NanoFlow 的正确上下文。
3. 在不破坏当前 offline-first 主干的前提下，引入一条 Widget 专属的读模型与凭证模型。

### 4.2 明确非目标

以下内容不应写入 MVP：

- Widget 内嵌完整 WebView 或完整 Web UI
- Widget 内直接进行复杂编辑、拖拽、流程图操作
- Widget 内直接进行语音录音与转写
- iOS Widget 支持
- “跨设备 1 秒内绝对一致”承诺
- 第一版就支持 Widget 直接改动任务领域状态

### 4.3 成功标准

只有同时满足以下条件，才算成功：

1. Widget 打开的 URL 与现有启动身份不冲突，不引发双启动、旧快捷方式漂移、`launch.html` 回归为第二入口等问题。
2. Widget 显示的是“云上已提交状态”或“设备本地原生缓存状态”，并且对陈旧态有明确标识。
3. 用户从 Widget 进入 NanoFlow 时，不会因错误路由、失效任务或已删除项目而白屏或进错页面。
4. Widget 凭证可撤销、可轮换、可按设备失效，而不是复用长期的全权限认证令牌。
5. 在浏览器挂起、设备后台被杀、推送延迟、旧版本 SW 仍在运行等情况下，系统能优雅降级，而不是给出错误的“已同步”暗示。

---

## 5. 平台可行性深度分析

## 5.1 Phase 0：先做 Web 快捷入口，而不是先做 Widget

这是最低风险、最高信息增益的第一步。

P0 只建议做“静态全局入口”这类 manifest 天然能表达的能力，不建议把它扩写成“任意项目 / 任意任务直达”。

可做内容：

- `manifest.webmanifest` 增加 `shortcuts`
- 统一新增壳层意图协议，例如 `entry=shortcut|widget|twa`
- 在 `#/projects` 路由壳层解析 `intent` 参数并执行安全降级
- `entry` / `intent` 作为一次性启动信封，执行后应消费掉 query，避免已运行壳层在热启动时被旧 URL 粘住
- 扩展现有启动契约测试，覆盖 shortcuts 与深链

必须明确的现实：

- 不能把 shortcuts 直接指向 `/#/focus`、`/#/dock`、`/#/capture`，因为这些路由当前不存在。
- Quick Capture 若要做，第一版应是“打开应用后弹出 recorder / overlay”，而不是“快捷入口本身就内建 capture 页面”。

建议的静态全局 shortcuts：

| 用途 | 建议 URL | 备注 |
| --- | --- | --- |
| 打开工作区 | `./#/projects?entry=shortcut&intent=open-workspace` | 可立即支持 |
| 打开 Focus 工具 | `./#/projects?entry=shortcut&intent=open-focus-tools` | 需新增壳层意图处理 |
| 打开 Black Box Recorder | `./#/projects?entry=shortcut&intent=open-blackbox-recorder` | 需新增壳层意图处理 |

补充说明：

- “打开某项目 / 某任务”的深链当然是后续需要支持的，但它不属于 P0 的静态 manifest shortcut 范畴。
- 这类按实体定向的入口应放到后续子阶段，通过运行时生成、分享链接、Pinned 目标或 Widget 自身上下文来实现。
- 第一阶段不建议新增多个顶级路由，而建议通过当前工作区壳层接收意图。这样更符合当前启动链路与 `launch.html` 兼容策略，也更容易做统一降级。

## 5.2 Windows 11 PWA Widget

### 官方能力结论

官方文档已明确：

- Windows 11 的 PWA Widget 需要单独设计 Custom Widget Experience。
- 其渲染载体是 Adaptive Cards，不是 HTML / CSS 页面。
- 生命周期与交互入口主要在 PWA 的 Service Worker 中，通过 `widgetinstall`、`widgetresume`、`widgetclick`、`widgetuninstall`、`periodicsync` 等事件驱动。

这意味着：

- 现有 NanoFlow 页面不能被“原样塞进 Widget Board”。
- 这不是视觉适配问题，而是运行时模型变化。

### Windows 方向的真实优势

- 与 NanoFlow 当前 Web 技术栈最接近，不需要引入 Kotlin / Android 工程。
- 适合作为 Widget 读模型、深链、凭证、陈旧态显示的先验证平台。
- 可以直接复用当前 PWA 安装流，不需要应用商店签名与多 ROM 验证。

### Windows 方向的真实阻塞点

#### 阻塞点 A：Service Worker 组合

当前 NanoFlow 不是自定义 SW，而是 Angular NGSW。Windows Widget 需要 SW 处理 widget 事件，因此必须决定：

1. 继续 patch 生成后的 `ngsw-worker.js`
2. 改成组合 SW
3. 放弃 NGSW，重写为 Workbox / 自定义 SW

推荐结论：

- 不建议继续把 Widget 逻辑硬 patch 到 `ngsw-worker.js`
- 也不建议为了 Widget 直接放弃 NGSW
- 推荐先走“组合 SW” PoC

示意代码如下，仅代表建议方向，不是现成实现：

```javascript
// sw-composed.js
// 设计示意：用组合 SW 方式复用 Angular NGSW，同时挂接 widget runtime。
importScripts('./ngsw-worker.js');
importScripts('./widgets/widget-runtime.js');
```

随后将 `main.ts` 中的注册目标从 `ngsw-worker.js` 切换为 `sw-composed.js`，并在部署头中对 `sw-composed.js` 追加 `no-cache`。

#### 阻塞点 B：认证模型

Windows Widget 的数据获取在 Service Worker 中发生，而当前 NanoFlow 并没有同源后端 API 层。现有主应用的浏览器端认证上下文不能被 Service Worker 理所当然地“直接拿来调用 Supabase 用户态接口”。

因此，Windows Widget 不能默认假设：

- 只要 PWA 已登录，Widget 就天然有用户态查询能力
- 只要在 manifest 里写 `auth: true`，就自动解决用户作用域鉴权

推荐结论：

- Windows Widget 也要走独立的 Widget Token 模型
- Service Worker 只持有只读 scope 的 Widget Token
- 由 Service Worker 去调用受控的 `widget-summary` Edge Function，而不是直接拼 Supabase REST 调用

#### 阻塞点 C：刷新语义

Windows Widget 没有 Android FCM 那样的天然推送路径，第一阶段应采用混合刷新策略：

- `widgetinstall`：首次渲染
- `widgetresume`：宿主恢复时刷新
- `activate`：SW 升级时刷新，防止模板空白或旧数据残留
- `periodicsync`：后台定期刷新
- 应用前台可见且发生业务变化时：由主应用 `postMessage` 给 SW 请求刷新

结论：

- Windows MVP 可以做到“同设备较准、后台近实时、离线可优雅退化”
- 但不建议承诺“应用关闭时依然与云端秒级同步”

### Windows MVP 范围建议

第一版建议严格限制为只读摘要 + 打开应用：

- 显示当前 Focus 概览
- 显示 Dock 数量与前 1 到 3 个条目摘要
- 显示 Black Box 未处理计数
- 提供“打开 NanoFlow”“打开当前项目 / 任务”两类动作

不建议第一版支持：

- 直接在 Widget 中完成任务
- 直接切换 Focus 主任务
- 直接录音或提交 Black Box

这些能力一旦做进去，就会绕开当前的 offline-first 主路径与队列语义。

## 5.3 Android：TWA 壳 + 原生 Widget

### 官方能力结论

官方文档已确认：

- TWA 宿主 App 不能直接访问 Web 侧的 `localStorage`、Cookie 或其他 Web 状态
- Android Widget 的交互能力受限，主要是 touch 与 vertical swipe
- `updatePeriodMillis` 的高频刷新并不适合做近实时，真正高频要依赖 WorkManager、前台事件或推送
- Jetpack Glance 是当前推荐的原生 Widget UI 路线
- TWA PostMessage 可用，但要求额外的 Digital Asset Links 关系与 Chrome 版本条件

这意味着：

- Android Widget 不能把 PWA IndexedDB 当数据源
- TWA 不是 Widget 数据层，只是打开 NanoFlow 的壳层
- 即便接入 PostMessage，它也只适合同设备快速协同，不适合作为跨设备权威同步链路
- 原生宿主不能直接复用 Web 登录态，因此 `widget-register` 的 correctness path 必须仍由已登录 Web 会话完成，再通过回调把 `widgetToken` 交回原生宿主

### Android 方向的真实成本

Android 方向不是一层“打包”，而是完整的第二运行时：

- Kotlin / Android Gradle 工程
- 原生 Widget 生命周期
- 设备端缓存
- FCM 令牌管理
- 后台任务与电量策略
- 多 ROM 兼容测试
- 数字资产链接与商店签名

这和 NanoFlow 当前以 Angular / TypeScript 为主的团队技能栈并不一致，因此 Android 方向的风险高于 Windows。

### Android 方向的核心隐患

#### 隐患 A：OEM 后台限制

国产 ROM 对后台任务和高优先级推送的干预，是 Android Widget 最大的不确定性之一。即便架构正确，也可能出现：

- Push 到达不稳定
- WorkManager 调度明显延后
- Widget 刷新被系统延迟或合并

因此 Android 方案必须把“渐进式降级”写进设计，不应假定所有设备都能获得相同体验。

#### 隐患 B：凭证与敏感数据

Android Widget 需要一个设备本地缓存，但该缓存不能等价于完整任务镜像。推荐只缓存 Widget 摘要所需的最小字段，并且默认不展示 Black Box 正文等敏感内容。

#### 隐患 C：TWA 只解决打开应用，不解决 Widget 权威源

TWA 很适合作为 Android 的正式壳层与安装载体，但它不会替原生 Widget 解决：

- 摘要拉取
- 推送刷新
- 凭证管理
- 锁屏隐私
- 小组件尺寸适配

### Android MVP 范围建议

第一版建议只做：

- Focus / Dock 摘要展示
- Black Box 未处理计数
- 点击打开 NanoFlow 对应上下文
- FCM dirty ping + 拉取摘要
- WorkManager 兜底刷新

第一版不建议做：

- Widget 直接创建 Black Box 条目
- Widget 内部直接改任务状态
- Widget 内部直接语音录制

这些都应延后到 P3 以后评估。

## 5.4 iOS 不纳入本提案

iOS Widget 需要 Swift / SwiftUI / App Group / 系统级数据共享模型，不与当前 Android / Windows / Web 技术路径共享大部分实现。当前阶段不应把 iOS 作为顺带支持项。

---

## 6. 推荐的总体架构

推荐架构的核心思想是：**不要让 Widget 直接碰业务真表，而要让它消费受控摘要读模型。**

### 6.1 权威源与读模型分层

推荐采用如下分层：

```text
领域真值层
  tasks.parking_meta
  focus_sessions.session_state
  routine_tasks
  routine_completions
  black_box_entries

        ↓ 受控汇总

Widget 摘要层
  Edge Function: widget-summary
  输出稳定 JSON 契约

        ↓ 平台运行时消费

Windows PWA Widget Runtime
Android Native Widget Runtime
```

### 6.2 每个字段的推荐来源

| Widget 数据项 | 推荐主源 | 次源 / 修复源 | 说明 |
| --- | --- | --- | --- |
| 当前 Focus 标题 | 最新一条 `focus_sessions.session_state` | `tasks` 中 `parking_meta.state='focused'` | 优先读当前云侧快照，任务表仅做校验或恢复 |
| Dock 数量 | 最新一条 `focus_sessions.session_state` | `tasks.parking_meta` | 避免每次直接聚合任务表 |
| Dock 摘要列表 | 最新一条 `focus_sessions.session_state` | `tasks` | 以快照为主，防止 UI 读模型与当前同步路径脱节 |
| Black Box 未处理数 | `black_box_entries` | 无 | 应直接基于条目表统计 |
| 日常任务完成数 | `routine_tasks` + `routine_completions` | 快照内衍生值 | 统计口径应由云端统一定义 |
| 项目 / 任务深链目标 | `projects` + `tasks` | 无 | 必须过滤软删除目标 |
| `dock_snapshot` | 不作为主源 | 仅保留兼容 / 回收价值 | 当前不建议用于 Widget 主流程 |

> v5.1 覆盖说明：这里的“日常任务完成数”属于后续可演进读模型，不应再被理解为当前跨端 Widget MVP 的默认输出字段。若没有统一 `logicalDateKey` / timezone 语义，以第 44 节为准，默认不纳入 MVP。

### 6.3 为什么不建议让 Widget 直接读 `tasks` + `black_box_entries`

因为这会带来三个问题：

1. 与当前 Focus / Dock 云同步主路径脱节。当前实际同步到云侧的是 `focus_sessions.session_state`。
2. 容易把“任务领域状态”和“Widget 展示态”混成一套逻辑，后续演进成本高。
3. 会把高频摘要查询直接压到热表与 RLS 路径上，放大当前性能告警。

因此推荐：

- 当前阶段由 `widget-summary` 统一聚合并输出只读摘要
- 等 Widget 真正跑起来后，再根据监控决定是否需要演化为专用投影表

### 6.4 统一 Widget 设备注册模型

推荐新增 `widget_devices` 表，统一管理 Windows PWA Widget 与 Android Widget 的安装实例。

以下 SQL 为设计示意。注意：NanoFlow 当前硬规则要求实体 ID 由客户端生成，因此这里的 `id` 不应使用数据库默认生成值，而应由注册侧客户端先生成再提交。

```sql
create table public.widget_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('windows-pwa', 'android-widget')),
  installation_id text not null,
  push_token text null,
  secret_hash text not null,
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, installation_id)
);
```

设计要求：

- `id` 由客户端在注册前生成，例如 `crypto.randomUUID()`
- `secret_hash` 只存 hash，不存明文
- `push_token` 仅 service role / 内部函数可读
- 主应用通过 `widget-register` Edge Function 注册设备，而不是直接写表
- Windows 与 Android 都用同一套“只读摘要 Token”思路，而不是一端特殊化

### 6.5 统一摘要接口

推荐新增 `widget-summary` Edge Function，而不是让 Widget 直接拼 Supabase 查询。

原因：

- 统一做设备令牌校验
- 统一做字段裁剪与隐私策略
- 统一做项目 / 任务软删除清洗
- 统一做版本号、时间戳和陈旧态判断
- 明确把 `focus_sessions.session_state` 投影成稳定的 Widget DTO，而不是把 `FocusTaskSlot` 或其他会话态原始结构直接当展示契约

建议输出契约：

```json
{
  "schemaVersion": 1,
  "summaryVersion": "2026-04-12T09:15:00.000Z|session-123",
  "cloudUpdatedAt": "2026-04-12T09:15:00.000Z",
  "sourceSavedAt": "2026-04-12T09:14:58.000Z",
  "freshnessState": "fresh",
  "entryUrl": "./#/projects?entry=widget&intent=open-workspace",
  "focus": {
    "active": true,
    "taskId": "task-1",
    "projectId": "project-1",
    "title": "撰写组件文档",
    "remainingMinutes": 24
  },
  "dock": {
    "count": 3,
    "items": [
      { "taskId": "task-2", "projectId": "project-1", "title": "整理测试矩阵" }
    ]
  },
  "blackBox": {
    "pendingCount": 2
  },
  "warnings": ["cloud-state-only"]
}
```

### 6.6 推送策略：推脏信号，不推正文

Android 侧不建议把完整摘要塞进 FCM data payload。推荐只推“dirty signal”：

```json
{
  "type": "widget_dirty",
  "installationId": "android-abc",
  "summaryVersion": "2026-04-12T09:15:00.000Z|session-123"
}
```

收到 dirty signal 后，Android Widget 再去调用 `widget-summary` 拉取最新摘要。

这样做的优点：

- 避免推送负载超限
- 避免在推送链路中携带敏感正文
- 能用 `summaryVersion` 处理乱序到达

### 6.7 Windows 侧运行时建议

Windows 推荐通过 Service Worker 对 Widget 所需的数据 URL 做动态响应，例如：

- manifest 中 `data` 指向 `/widgets/focus-data.json`
- Service Worker 拦截该 URL
- Service Worker 读取本地可访问的 Widget Token
- Service Worker 调用 `widget-summary` Edge Function
- Service Worker 把 JSON 作为 `focus-data.json` 的响应返回

这样可以避免要求静态站点本身具备同源后端，同时保留官方 Widget 所需的数据 URL 形态。

### 6.8 Android 侧运行时建议

Android 侧推荐：

- Glance 负责 UI
- 本地只缓存最小摘要字段
- FCM data message 触发拉取
- WorkManager 作为兜底刷新
- TWA 负责“打开 NanoFlow”，不承担 Widget 数据层职责

TWA PostMessage 可以作为未来增强项，仅用于同设备快速协同，不能作为跨设备权威同步路径。

### 6.9 深链协议建议

当前建议的统一规则：

- 所有入口都走 `./#/projects...`
- 所有 Widget / shortcut / TWA 入口都追加 `entry=widget|shortcut|twa`
- 所有“打开某个工具”的请求都以 `intent=` 参数表达
- `entry` / `intent` 必须作为显式启动信封，优先级高于持久化的 `launch snapshot` / 上次路由恢复状态
- `entry` / `intent` 处理完成后应通过 `replaceUrl` 或等价方式消费，避免同一 shortcut 的热重入被旧 query 阻断
- 壳层必须对未知 `intent` 做安全降级，而不是白屏或报错

建议的兜底逻辑：

1. 如果 `projectId` 或 `taskId` 无效，降级打开 `./#/projects`。
2. 如果 `intent` 无法执行，降级只打开工作区。
3. 不允许任何新入口直接落到 `launch.html`。

---

## 7. 认证、安全与隐私设计

## 7.1 推荐认证模型

不建议让 Widget 直接复用主应用的高权限用户态认证令牌。推荐模型：

- 主应用登录后，通过 `widget-register` Function 为某个安装实例申请只读 Widget Token
- Widget Token 仅具备 `widget:summary.read` 之类的最小 scope
- Token 可吊销、可轮换、可按设备失效
- Android Push Token 与 Widget Token 不绑定为一物，而是分开管理

这样做的好处：

- Service Worker / 原生 Widget 不需要持有完整用户会话
- 设备丢失或退出登录时能单独失效某一安装实例
- 后续如果增加 Widget Action，也能细化成单独 scope

## 7.2 为什么不建议 MVP 直接开放写操作

当前 NanoFlow 的核心价值在于 offline-first 和一致性。若 Widget 直接写任务状态，会引入这些新问题：

- 绕过当前 Web 侧 ActionQueue / RetryQueue 设计
- 原生写路径与 Web 写路径语义不一致
- 成功 UI 与云端提交时刻脱节，更容易制造“我明明点了为什么桌面没变”的假阳性
- 安全范围从“只读摘要”扩张到“跨设备变更核心业务数据”

所以 MVP 推荐：

- Widget 只读
- Widget 的按钮只做“打开 NanoFlow 到正确上下文”
- 真正的领域变更仍在主应用中发生

## 7.3 敏感内容策略

以下内容不应默认出现在 Widget 上：

- Black Box 正文内容
- 可能在锁屏或公开环境泄漏的敏感任务标题
- 私密项目名称

推荐默认策略：

- Widget 默认展示计数与简化标题
- 仅在用户显式开启“显示详细标题”时展示更详细信息
- Android 侧本地缓存只保留最小摘要字段

## 7.4 新增 Function 的安全要求

> v5.1 覆盖说明：本节的接口分工继续有效，但其中 `widget-notify` 的 direct webhook 鉴权前提已被第 41 节重新定义；不要再把“内部触发”直接等价成“可以继续 `verify_jwt = true`”。

新建的 Widget 相关 Edge Functions 应满足：

- `widget-register`：验证主用户会话，生成设备级只读令牌
- `widget-summary`：验证设备级只读令牌，仅返回摘要字段
- 【已被 v5.0 §41 / v5.1 结构化清理覆盖】早期写法为“`widget-notify` 仅接受内部触发，`verify_jwt = true`”；现应改读为：仅在 trusted gateway / signer 前置时成立，若 direct webhook 则默认按 `verify_jwt = false + 自定义鉴权（HMAC 绑定 event_id + timestamp + body）/ 重放防护 / 幂等去重` 处理
- 所有 Function 统一最小日志脱敏，不打印明文 token

---

## 8. 同步语义与“假阳性”防护

这一节专门回答“以后会不会看起来像成功、实际上没成功”的问题。

## 8.1 诚实的时效性 SLA

建议不要在任何产品文案里使用“实时同步”四个字，而改用以下更诚实的表述。

| 场景 | 建议 SLA 表述 | 现实依据 |
| --- | --- | --- |
| 同一 Web 会话本地 UI | 立即更新 | 当前本地先写模型已具备 |
| 云端提交可见 | 通常 3 到 8 秒 | `3s debounce + 网络 RTT + 队列` |
| Android Widget 刷新 | 通常 4 到 15 秒，弱网更慢 | `webhook + FCM + 再次拉取摘要` |
| Windows Widget 刷新 | 应用活动时更快，后台依赖 resume / periodic sync | 无 Android 同级推送路径 |
| 离线跨端一致 | 不承诺 | 当前架构本质上做不到 |

## 8.2 Widget UI 必须暴露 freshness 状态

推荐 Widget 使用如下状态机，而不是单纯展示数据：

| 状态 | 条件 | UI 行为 |
| --- | --- | --- |
| `fresh` | `cloudUpdatedAt` 距今较短 | 正常展示 |
| `aging` | 数据开始变旧但仍可接受 | 显示“最近同步”时间 |
| `stale` | 超过阈值或多次刷新失败 | 强调“显示的是旧的云状态” |
| `auth-required` | 设备令牌失效或被撤销 | 引导重新打开 NanoFlow |
| `untrusted` | 数据版本回退、目标失效或校验失败 | 降级只显示入口与提醒 |

## 8.3 必须写进实现约束的防错规则

1. Push 到达不等于数据已可信。必须先重新拉取 `widget-summary`，并按 `summaryVersion` 比较后再落缓存。
2. Widget 永远不显示“已同步”这类绝对措辞，只显示“最近同步于 ...”。
3. 如果目标项目或任务已软删除，Widget 入口必须降级打开工作区，而不是跳无效深链。
4. 如果浏览器 / 系统后台挂起导致刷新失败，不应把失败计入永久性错误状态，而应显示延后恢复中的提示。
5. 当 `summaryVersion` 小于本地缓存版本时，必须拒绝覆盖，防止乱序推送或旧 SW 回写旧数据。

## 8.4 为什么浏览器挂起必须作为一等公民

NanoFlow 当前已经在同步主链路里明确处理 Browser Suspension。这个经验必须进入 Widget 设计：

- 对 Web 主应用而言，挂起窗口内不是“真正离线失败”，而是“应延后的恢复期”
- 对 Windows Widget 而言，`widgetresume` 正是对应的恢复时机
- 对 Android 而言，FCM 到达与本地刷新之间也可能因为系统后台策略而延迟

所以，Widget 方案不能把“刷新失败”简单当成“服务端坏了”或“用户未登录”，而要保留挂起 / 恢复语义。

---

## 9. 隐性问题矩阵

下表列出最容易在立项后被忽略、但一旦上线就会造成大量返工的问题。

| 风险 | 现象 | 根因 | 解决方向 |
| --- | --- | --- | --- |
| 路由假设错误 | 点击 Widget 进入错误页面或仅打开项目列表 | 当前没有 `#/focus`、`#/dock` 等现成路由 | 统一使用 `#/projects` + `intent` 协议 |
| 启动身份漂移 | 老安装快捷方式失效、双开、白屏 | `launch.html` 再次被误当产品入口 | 固定 `id=/launch.html`，新入口只走根路径 + hash |
| NGSW 与 Widget 运行时冲突 | Widget 事件收不到，或升级后空白 | 当前使用 Angular NGSW，未预留 widget 事件钩子 | 先做组合 SW PoC，不直接 patch 产物 |
| SW 无法安全取用户态凭证 | Windows Widget 无法拉私有摘要 | 当前无同源后端，SW 不应依赖主线程会话 | 引入 Widget Token + Edge Function 摘要接口 |
| 离线假阳性 | Web 已改，Widget 仍旧显示旧数据 | 本地先写未提交到云 | Widget 明确标注 cloud state + freshness |
| 浏览器挂起误判 | 用户恢复网络后短时状态异常 | 挂起窗口被错误记成失败 | 挂起应延后，不消耗永久错误预算 |
| Android OEM 杀后台 | Android Widget 刷新不稳定 | 厂商电量策略 | FCM + WorkManager + 手动刷新降级 |
| 乱序刷新覆盖 | 新状态被旧推送或旧缓存回滚 | 无 `summaryVersion` 比较 | 所有平台都按版本比较拒绝旧数据 |
| 软删除目标失效 | Widget 点开无效任务 / 已删除项目 | 深链未校验目标存活 | 摘要接口统一过滤软删除目标 |
| 锁屏隐私泄漏 | 旁人看到私密任务或 Black Box 内容 | 摘要字段裁剪不严 | 默认只展示计数与简化标题 |
| 多实例配置混乱 | 多个 Widget 同时展示相同或互相覆盖状态 | 未做 instance 范围配置 | MVP 先只支持全局摘要；多实例配置延后 |
| 部署缓存头缺失 | 新版 SW / Widget 模板不生效 | `sw-composed.js`、`ngsw-worker.js` 缓存策略错误 | 部署头纳入发布门禁 |
| Advisor 底噪放大 | Widget 高频查询后数据库抖动 | 缺失索引、RLS 重复 policy | Phase 1 前先做查询热路径审计 |

---

## 10. 分阶段实施路线图

本路线图强调“每一阶段都必须可停、可回滚、可独立验收”。

## 10.1 P0：Web 入口与契约准备

### 目标

把 Widget 所需的深链、入口、启动兼容问题先在 Web 侧打平。

### 交付物

- `manifest.webmanifest` 增加 `shortcuts`
- 新增 `entry` / `intent` 深链协议
- 工作区壳层支持解析并安全执行 `intent`
- 启动后消费一次性 `entry` / `intent` query，避免 shortcut 热重入失效
- 启动契约测试扩展：覆盖 shortcuts 与新深链
- 文档与测试里明确：新入口不得直接使用 `launch.html`

### 验证方式

- 浏览器中直接访问快捷入口 URL，不白屏、不双开、不误路由
- 已安装 PWA 在更新后旧入口仍可正常工作
- `launch.html` 仍只承担兼容入口职责
- 2026-04-12 更新：真实 Edge 安装态 profile 已验证 shortcut 点击链会把 `entry=shortcut&intent=open-workspace` 送进 app shell，并在消费后回到 `#/projects`；先前 Chromium `--app=...` surrogate 已被确认会丢失 shortcut hash，不能再作为安装态验收替身。

### 回滚点

- 删掉 manifest shortcuts
- 保留 `intent` 解析逻辑但让未知 intent 退化为普通打开工作区

## 10.2 P1：云侧摘要与设备认证基础设施

### 目标

建立平台无关的 Widget 读模型基础层。

### 交付物

- `widget_devices` / `widget_instances` / `widget_request_rate_limits` 表、`consume_widget_rate_limit()` RPC 与最小管理逻辑
- `widget-register` Edge Function
- `widget-summary` Edge Function
- `widget-notify` Edge Function
- `summaryVersion` / `freshnessState` / `trustState` / `sourceState` 摘要协议
- 设备吊销 / 令牌轮换流程

### 验证方式

- 新设备可注册，可拿到只读摘要令牌
- 设备吊销后旧令牌不可继续获取摘要
- 摘要接口能正确过滤已删除项目 / 任务
- 推送 dirty signal 后，客户端拉取到的 `summaryVersion` 单调前进

### 回滚点

- 停用 `widget-register` 与 `widget-summary`
- 清理 `widget_devices` 中的活跃凭证
- 保留现有 Web 主链路，不影响主应用使用

### 2026-04-13 当前实现状态

- 已在仓库与生产同步落地：
  - `widget_devices`、`widget_instances`、`widget_request_rate_limits`、`widget_notify_events`、`widget_notify_throttle`、`consume_widget_rate_limit()`、`widget_capabilities` / `widget_limits` 已 apply 到生产 Supabase，并同步到 migration、init SQL 与 Supabase 类型文件。
  - `widget-register` 已支持 `register / rotate / revoke / revoke-all`，并落定 `device_id / installation_id / widget_instance_id` 边界、`binding_generation` 校验、同账号跨安装冲突拒绝、revoke 清空 push token；在 2026-04-13 live ES256 access token 验证后，配置已纠偏为 `verify_jwt = false + 函数内 auth.getUser(token)`，避免 Supabase Functions gateway 对真实用户 session 误报 `Invalid JWT`。
  - `widget-summary` 已采用 `POST + device token` 自定义鉴权，包含预鉴权 IP 限流、device/user 限流、实例校验、`DockSnapshot.focusSessionState` 与 legacy 快照兼容投影、软删除降级、unread-only black box 计数、聚合 `summaryVersion`、`freshnessState + trustState + sourceState` 与 `private + no-store` 缓存头；生产 metadata 已确认 `verify_jwt = false`。
  - 2026-04-13 live probe 进一步确认：真实用户态 `register -> rotate -> summary -> revoke-all` 已跑通，`widget-summary` 在无 JWT 但有 device token 时返回 `200 verified/cloud-confirmed`，旧 token 在 rotate 后返回 `401 BINDING_MISMATCH`、在 revoke-all 后返回 `401 DEVICE_REVOKED`，`clientSchemaVersion` mismatch 返回 `409 SCHEMA_MISMATCH`，受控 drill 已复现 `401 -> 429 RATE_LIMITED`、`503 WIDGET_REFRESH_DISABLED` 与 `soft-delete-target` 降级。
  - 2026-04-13 live probe 暴露并修复了跨端点限流串桶：`widget-register` 与 `widget-summary` 现分别使用 `widget-register-*` / `widget-summary-*` scope key，避免 summary 流量误伤 revoke/register。
  - `widget-notify` 已采用 direct webhook + `verify_jwt = false`，实现 `standardwebhooks` 与自定义 HMAC 头双栈验真；自定义签名绑定 `event_id + timestamp + body`，并在生产通过合法 HMAC `202 push-disabled` / 伪造签名 `401 INVALID_SIGNATURE` 实测。
  - `focus_sessions` 与 `black_box_entries` 已通过 `public.invoke_widget_notify_webhook()` + `pg_net` 触发链连接到 `widget-notify`，并使用 Vault secrets 提供 base URL 与 HMAC secret。
- 仍待补齐：
	- 2026-04-13 随后已通过 Vercel 将当前前端 redeploy 到 `https://dde-eight.vercel.app`；重新扫描 `ngsw.json` 列出的 110 个 JS 资产后，已在 `/chunk-HZMSDGMX.js` 命中 `widget-register` / `WIDGET_REFRESH` / `nanoflow-widget` / `revoke-all` / `bindingGeneration` 等签名。随后使用两名临时确认用户对生产 UI 执行 logout / A->B 换号复核：A 登出先发 `widget-register {"action":"revoke-all"}` `200`，再发 `auth/v1/logout` `204`；A 登出后 B 登录，`user-menu` 已切换为 B 邮箱，说明 deployment drift 与 `G-43` 的 production UI blocker 均已关闭。
  - `widget-notify` 当前仍在 `pushAllowed = false` / `deliveryMode = dry-run`，尚未接通真实 Android push provider。

## 10.3 P1.5：Windows PWA Widget PoC

### 目标

验证 Windows 方向的关键技术假设，而不是直接追求完整上线。

### 交付物

- `sw-composed.js` PoC
- `widgets/widget-runtime.js`
- 一套最小 Adaptive Cards 模板
- `widgetinstall` / `widgetresume` / `widgetclick` / `periodicsync` 路径打通
- 只读摘要 Widget

### 验证方式

- Edge 安装的 PWA 可在 Windows 11 Widgets Board 添加 Widget
- 应用升级后 Widget 不空白、不回退到旧模板
- 设备令牌失效时 Widget 进入 `auth-required` 态
- 关闭应用后，Widget 仍能通过 periodic sync 或 resume 获取合理更新

### Kill Criteria

满足任一条件就停止 Windows 方向继续扩展：

1. 组合 SW 在 Angular 升级或构建链下持续不稳定。
2. Widget 认证路径无法做成比主应用会话更安全的独立模型。
3. 更新与缓存行为在目标环境中不可预测，难以建立发布门禁。

### 回滚点

- `main.ts` 恢复注册 `ngsw-worker.js`
- 移除 `widgets` manifest 字段
- 下线 `sw-composed.js`

## 10.4 P2：Android 原生 Widget + TWA 壳

### 目标

在已验证的摘要与认证基础上，补 Android 原生承载层。

### 交付物

- Android 工程（TWA 壳 + Glance Widget）
- Authenticated Web bootstrap / token handoff
- FCM dirty ping 接收
- WorkManager 兜底刷新
- 最小本地摘要缓存
- TWA 深链承接与统一 `intent` 协议

### 验证方式

- Android 13 / 14 实机可稳定展示摘要
- 推送可触发近实时刷新
- 弱网 / 后台 / 恢复后可优雅降级
- 锁屏隐私默认不泄漏正文

### Kill Criteria

满足任一条件就暂停 Android 方向：

1. 核心目标设备上的 Push / 刷新到达率长期不达标。
2. 多 ROM 兼容成本超出当前团队维护能力。
3. 同一份摘要逻辑在 Android 原生端需要大量平台特有分叉，失去统一基础设施价值。

### 回滚点

- 停止发布 Android 原生壳
- 撤销 Android Widget 设备令牌
- 保留 Web 快捷入口与 Windows 方向成果

## 10.5 P3：交互式 Widget Action（后置）

只有在 P1 / P1.5 / P2 稳定后，才考虑：

- 标记任务完成
- 切换 Focus 主任务
- 快速创建 Black Box

此阶段需要额外设计“Widget Action Queue”，不能直接写主业务表。

---

## 11. 测试、验证与观测要求

## 11.1 必须新增的测试类型

### 合约测试

- Manifest：`id`、`start_url`、`shortcuts`、后续 `widgets` 配置
- 路由：`entry` / `intent` 深链协议
- SW：`sw-composed.js` 注册目标与缓存头
- 摘要：`widget-summary` 返回字段与 `summaryVersion` 规则

### 集成测试

- `widget-register` 注册 / 吊销
- `widget-summary` 的软删除过滤
- dirty signal 到摘要拉取的乱序处理
- 设备令牌轮换与旧令牌失效

### 平台验证

- Windows 11 + Edge 已安装 PWA
- Android 实机，不只模拟器
- 至少覆盖一个“后台限制明显”的 Android 设备

## 11.2 必须增加的观测指标

建议记录：

- `widget_summary_fetch_success`
- `widget_summary_fetch_failure`
- `widget_summary_stale_render`
- `widget_token_revoked`
- `widget_push_dirty_sent`
- `widget_push_dirty_delivered`
- `widget_resume_refresh`
- `widget_click_open_app`

目标不是“埋点越多越好”，而是能回答这几个关键问题：

- Widget 是没收到更新，还是收到后没成功拉取摘要？
- 数据慢，是云端慢，还是平台刷新被延后？
- 是认证失效，还是目标已经被软删除？

## 11.3 上线前门禁

Widget 相关阶段正式上线前，应满足：

1. 启动身份与深链测试通过。
2. 安全 advisor 中与新暴露面直接相关的问题已处理。
3. 至少一轮真实设备验证完成。
4. 摘要接口已证明不会泄漏敏感内容。
5. 乱序 / 挂起 / 恢复场景已通过故障演练。

---

## 12. 回滚与故障处理

## 12.1 回滚原则

本项目必须允许“只回滚 Widget 层，不回滚主应用同步主干”。

因此推荐所有变更保持层次化：

- `shortcuts` 可单独移除
- `widgets` 可单独移除
- `sw-composed.js` 可单独撤回
- `widget-*` Functions 可单独停用
- `widget_devices` 令牌可批量吊销

## 12.2 常见故障处理

### 场景 A：Widget 显示旧数据

处理顺序：

1. 看 `freshnessState`
2. 看最近一次 `widget_summary_fetch_failure`
3. 看 `cloudUpdatedAt` 是否实际停滞
4. Windows 检查 SW 版本与 `widgetresume` 路径
5. Android 检查 push dirty 是否送达，以及设备是否被后台限制

### 场景 B：Widget 点击后打开错误页面

处理顺序：

1. 检查是否误用了非 hash 深链
2. 检查 `intent` 是否已实现
3. 检查目标 `projectId` / `taskId` 是否已软删除
4. 降级打开 `./#/projects`

### 场景 C：升级后 Widget 空白

处理顺序：

1. 检查 `sw-composed.js` 与 `ngsw-worker.js` 的缓存头
2. 检查 `activate` 时是否触发 widget refresh
3. 检查模板 URL 与 data URL 是否仍有效
4. 必要时先回滚到无 Widget manifest 的版本

---

## 13. 最终决策建议

### 13.1 建议现在就做的事

建议立即批准：

1. P0：快捷入口与深链协议整理
2. P1：Widget 设备与摘要基础设施设计
3. Windows PWA Widget 的技术 PoC 预研

### 13.2 建议延后决策的事

建议暂不批准：

1. Android 原生 Widget 的完整排期承诺
2. Widget 内直接写任务状态
3. Widget 内语音录制或 Black Box 正文编辑

### 13.3 最终推荐语句

如果只能给一个明确建议，那么建议是：

**先把 NanoFlow 的“Widget 读模型、设备认证、深链协议、陈旧态表达”做成平台无关基础设施，再决定 Windows 和 Android 的载体层。**

这比直接冲 Android 原生 Widget 更稳，也比只在文档里写“技术上可行”更接近真实可交付状态。

---

## 14. 附：官方与仓库依据清单

### 14.1 官方资料

- Chrome Developers: Trusted Web Activity overview  
  https://developer.chrome.com/docs/android/trusted-web-activity/overview
- Chrome Developers: PostMessage for TWA  
  https://developer.chrome.com/docs/android/post-message-twa
- Android Developers: App widgets overview  
  https://developer.android.com/develop/ui/views/appwidgets/overview
- Android Developers: Jetpack Glance  
  https://developer.android.com/develop/ui/compose/glance
- Microsoft Learn: Display a PWA widget in the Windows Widgets Board  
  https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps-chromium/how-to/widgets
- Supabase Docs: Database Webhooks  
  https://supabase.com/docs/guides/database/webhooks
- Supabase Docs: Sending Push Notifications with Edge Functions  
  https://supabase.com/docs/guides/functions/examples/push-notifications

### 14.2 仓库依据

- `public/manifest.webmanifest`
- `main.ts`
- `src/app.routes.ts`
- `src/services/sw-registration-strategy.ts`
- `ngsw-config.json`
- `src/config/sync.config.ts`
- `src/app/core/services/sync/focus-console-sync.service.ts`
- `src/services/dock-cloud-sync.service.ts`
- `src/app/core/services/sync/user-preferences-sync.service.spec.ts`
- `supabase/migrations/20260315200000_consolidated_focus_console_and_security.sql`
- `src/tests/startup-contract.spec.ts`
- `vercel.json`
- `netlify.toml`

### 14.3 本提案最关键的现实判断摘要

- 当前 NanoFlow 已具备做 Widget 的业务核心数据，但尚未具备 Widget 专属的认证与摘要通路。
- 当前最接近 Widget 云侧读模型的不是 `dock_snapshot`，而是 `focus_sessions.session_state`。
- 当前启动身份、hash 路由、NGSW 构建链都是硬约束，不是实现细节。
- 真正要先解决的是“摘要可信、入口可信、凭证可信”，而不是先把小组件摆上桌面。

---

# v3.0 深度扩展：批判性分析、隐性问题发掘与解决方案

> 版本：v3.0 扩展层
> 日期：2026-04-12
> 状态：深度研究完成
> 方法论：基于仓库实现审计 + Supabase 线上项目实时查询 + 官方文档交叉验证 + 上游想法批判性吸收
> 目标：在 v2.0 基础上，发掘所有未考虑到的隐性问题、假阳性风险、实现后可能出现的故障场景，并给出每个问题的具体解决方案。

---

## 15. 深度代码审计发现：v2.0 未覆盖的仓库实现细节

本节基于 2026-04-12 对仓库源码和线上 Supabase 项目的实时审计，补充 v2.0 未深入分析的关键实现细节。

### 15.1 Angular NGSW 组合 SW 模式已有官方支持

v2.0 建议了"组合 SW"方向但未确认可行性。经 Angular 官方文档验证：

Angular 文档（`angular.dev/ecosystem/service-workers/custom-service-worker-scripts`）已明确提供了组合 SW 的标准模式：

`javascript
// 官方推荐的组合 SW 模式
importScripts('./ngsw-worker.js');

(function () {
  'use strict';
  // 自定义事件处理器在这里注册
  self.addEventListener('notificationclick', (event) => { /* ... */ });
  self.addEventListener('sync', (event) => { /* ... */ });
})();
`

**对 Widget 的直接影响：**

- 组合 SW 方案不再是"推测可行"，而是"官方已验证的标准做法"。
- NanoFlow 的 `sw-composed.js` 可以在 `importScripts('./ngsw-worker.js')` 之后，追加 Widget 运行时事件处理器（`widgetinstall`、`widgetresume`、`widgetclick`、`periodicsync`），这与 NGSW 的缓存策略不会冲突。
- `main.ts` 中的 `provideServiceWorker('ngsw-worker.js', ...)` 需要改为 `provideServiceWorker('sw-composed.js', ...)`。
- 当前 SW 注册策略 `createPostHandoffSwRegistrationStrategy({ delayMs: 300, fallbackMs: 4_000 })` 可以保持不变——Widget 事件监听只是在 SW 安装后被动触发，不影响注册时序。

**新增风险点：**

- NGSW 升级时会生成新的 `ngsw-worker.js`，如果 `sw-composed.js` 没有同步更新缓存 hash，可能导致 SW 升级循环。
- 解决方案：构建脚本中新增一步：在 `ngsw-worker.js` 生成后，自动重新组装 `sw-composed.js` 并计算新的缓存 hash。需要在现有的 `patch-ngsw-html-hashes.cjs` 之后追加。

### 15.2 RLS 策略重复问题的精确诊断

v2.0 提到了"重复 permissive RLS policy"但未给出精确范围。本次线上查询结果如下：

**`tasks` 表存在双重 permissive SELECT 策略：**

| Policy 名称 | 类型 | 条件函数 |
| --- | --- | --- |
| `tasks owner select` | PERMISSIVE | `user_has_project_access(project_id)` |
| `tasks_select_optimized` | PERMISSIVE | `user_is_project_owner(project_id)` |

这两个策略都是 PERMISSIVE（PostgreSQL 中多个 PERMISSIVE 策略是 OR 关系），且 `user_has_project_access` 很可能是 `user_is_project_owner` 的超集。这意味着：

- 每次 SELECT 查询，PostgreSQL 必须评估**两个** RLS 函数调用。
- 对 Widget 摘要查询（高频、跨表聚合）来说，这个双重评估的成本会被放大。

**同样的双重策略存在于 `tasks` 表的 INSERT、UPDATE、DELETE 操作。**

**Widget 特定影响：**

- `widget-summary` Edge Function 如果直接查询 `tasks` 表（即使只是 `COUNT(*) WHERE parking_meta IS NOT NULL`），也会触发双重 RLS 评估。
- 解决方案：`widget-summary` 应使用 `service_role` key 绕过 RLS，在函数内部手动做 `user_id` 过滤。这既避免了 RLS 双重评估开销，也确保了 Widget Token 不需要持有完整的用户态 JWT。

**其他表的 RLS 状态（对 Widget 安全）：**

| 表 | SELECT RLS | 重复问题 | Widget 影响 |
| --- | --- | --- | --- |
| `focus_sessions` | `auth.uid() = user_id`（仅 `authenticated` 角色） | 无重复 | Widget Token 不是 `authenticated`，无法直接查询 |
| `black_box_entries` | `user_id = current_user_id() OR project_id IN (...)` | 无重复，但 OR 条件增加查询成本 | Widget 不需要 project access 分支，可简化 |
| `routine_tasks` | `auth.uid() = user_id`（仅 `authenticated` 角色） | 无重复 | Widget Token 无法直接查询 |
| `routine_completions` | `auth.uid() = user_id`（仅 `authenticated` 角色） | 无重复 | Widget Token 无法直接查询 |

**关键结论：** 所有 Widget 需要读取的表都要求 `authenticated` 角色。Widget Token 作为设备级只读令牌，不应具备 `authenticated` 角色。因此 `widget-summary` Edge Function 必须使用 `service_role` 访问数据，Widget Token 只用于验证设备身份。

### 15.3 数据库触发器对 Widget 数据流的影响

线上查询发现以下触发器，对 Widget 数据的新鲜度和一致性有直接影响：

| 触发器 | 表 | 时机 | Widget 影响 |
| --- | --- | --- | --- |
| `trg_focus_sessions_updated_at` | `focus_sessions` | BEFORE UPDATE | `updated_at` 自动更新，可用作 Widget 摘要版本号 |
| `trigger_black_box_updated_at` | `black_box_entries` | BEFORE UPDATE | `updated_at` 自动更新，可用于增量拉取 |
| `trg_cascade_soft_delete_connections` | `tasks` | AFTER UPDATE（`deleted_at`） | 软删除级联可能改变 Widget 摘要中的任务计数 |
| `trg_prevent_tombstoned_task_writes` | `tasks` | BEFORE INSERT/UPDATE | 已墓碑化的 task 不可写回，Widget 无需额外防御 |
| `trg_validate_task_data` | `tasks` | BEFORE INSERT/UPDATE | 数据验证在写入层做完，Widget 读到的数据已通过验证 |

**新发现的隐性问题：**

`trg_cascade_soft_delete_connections` 是 v2.0 中安全 advisor 标记的 `mutable search_path` 函数。如果 Widget 摘要查询涉及到 connections 计数，而这个触发器在并发软删除场景下因为 search_path 问题执行了错误的级联，会导致 Widget 显示的连接数与实际不符。

**解决方案：** 在 P1 阶段之前，修复 `cascade_soft_delete_connections` 函数的 `search_path`（设置为 `SET search_path = public`）。这不仅是安全门禁，也直接影响 Widget 数据准确性。

### 15.4 缺失索引的精确影响评估

线上查询确认以下缺失索引：

| 表 | 缺失索引 | Widget 受影响的查询 | 优先级 |
| --- | --- | --- | --- |
| `black_box_entries` | `project_id` 外键无覆盖索引 | `COUNT(*) WHERE deleted_at IS NULL AND user_id = ?` | **中**——Widget 摘要查询走 `user_id` 索引，不走 `project_id`，但级联删除时缺失索引会锁扫 |
| `routine_completions` | `routine_id` 外键无覆盖索引 | `WHERE user_id = ? AND date_key = ?` 当日完成统计 | **中**——当前有 `(user_id, routine_id, date_key)` 复合索引，routine_id 外键单独缺索引影响的是 FK cascade，不是 Widget 查询 |
| `connection_tombstones` | `deleted_by` 外键无覆盖索引 | Widget 不直接查询此表 | **低** |
| `task_tombstones` | `deleted_by` 外键无覆盖索引 | Widget 不直接查询此表 | **低** |

**经确认存在的覆盖索引：**

- `focus_sessions`：`(user_id, updated_at DESC)` —— 完全覆盖 Widget 摘要的核心查询
- `black_box_entries`：`(user_id, updated_at DESC)` —— 覆盖增量拉取
- `routine_tasks`：`(user_id, updated_at DESC)` —— 覆盖增量拉取
- `tasks`：`(project_id, updated_at DESC)` + `parking_meta IS NOT NULL` 部分索引 —— 部分覆盖 Widget 停泊任务统计

**结论：** 当前索引状态对 Widget 读模型的核心查询路径影响有限，但 `black_box_entries.project_id` 和 `routine_completions.routine_id` 的外键索引应在 P1 之前补上，因为 Widget 引入后这些表的写入频率可能因为 webhook 触发链而间接增加。

### 15.5 现有 Edge Functions 与 Widget 的兼容性

线上查询确认当前 5 个已部署的 Edge Functions：

| Function | `verify_jwt` | Widget 可复用性 |
| --- | --- | --- |
| `transcribe` | `false` | 不可复用——语音转写与 Widget 无关 |
| `backup-full` | `true` | 不可复用——备份逻辑 |
| `backup-restore` | `true` | 不可复用 |
| `backup-incremental` | `true` | 不可复用 |
| `backup-cleanup` | `true` | 不可复用 |

> v5.1 覆盖说明：本节开头保留了一个已经被证伪的早期假设，用于展示推导过程。关于 Widget Functions 的最终 `verify_jwt` 拆分，以第 41 节为准。

**关键发现（早期判断，已被 v5.0 §41 / v5.1 / 2026-04-13 live ES256 验证共同覆盖）：** `transcribe` 不是唯一必须关闭 gateway JWT 校验的函数。生产项目当前签发 ES256 用户 session token，而 Functions gateway 会把 `widget-register.verify_jwt = true` 的真实用户请求拦成 `401 Invalid JWT`。因此 `widget-register` 也必须改为 `verify_jwt = false`，再在函数内用 `auth.getUser(token)` 做显式用户认证。

**`widget-summary` 的认证链路设计：**

`
Widget runtime（SW / Android）
  -> 构造 HTTP 请求，Header: Authorization: Bearer <widget-device-token>
  -> widget-summary Edge Function（早期假设：verify_jwt = true）
    -> 但不使用 JWT 解析 user_id
    -> 而是从 Header 中提取 widget-device-token
    -> 用 service_role client 查询 widget_devices 表验证 token hash
    -> 如果有效，以 service_role 查询 focus_sessions + tasks + black_box_entries
    -> 返回摘要 JSON
`

**等一下，这里有一个矛盾：** 如果 `verify_jwt = true`，那么没有合法 JWT 的请求会被 Supabase API Gateway 直接拒绝，根本到不了函数代码。Widget Token 不是 JWT，所以请求会被网关拦截。

**纠正方案：** `widget-summary` 和 `widget-register` 需要采用混合认证模型：
- `widget-register`：`verify_jwt = false + auth.getUser(token)`（用户必须已登录，但认证要在函数内完成，不能继续依赖 gateway）
- `widget-summary`：`verify_jwt = false`（设备 Token 不是 JWT，必须在函数内部手动验证）
- `widget-notify`：`verify_jwt = true`（仅在前置 trusted gateway / signer 时成立；若 direct webhook，则已被 v5.0 §41 改写为 `verify_jwt = false + 自定义鉴权`）

这里 `widget-summary` 的 `verify_jwt = false` 意味着它暴露在公网上，任何人都可以发请求。因此函数内部的 Widget Token 验证和 rate limiting 变得至关重要。

### 15.6 `FocusSessionStateV2` 实际结构对 Widget 摘要的映射

经源码审计，`FocusSessionStateV2`（存储在 `focus_sessions.session_state` JSONB 中）的实际结构为：

`	ypescript
interface FocusSessionStateV2 {
  schemaVersion: 2;
  sessionId: string;
  sessionStartedAt: number;          // epoch ms
  isActive: boolean;
  isFocusOverlayOn: boolean;
  commandCenterTasks: FocusTaskSlot[];  // zone: 'command'
  comboSelectTasks: FocusTaskSlot[];    // zone: 'combo-select'
  backupTasks: FocusTaskSlot[];         // zone: 'backup'
  hasFirstBatchSelected: boolean;
  routineSlotsShownToday: string[];
  highLoadCounter: { count: number; windowStartAt: number };
  burnoutTriggeredAt: number | null;
}

interface FocusTaskSlot {
  taskId: string;
  projectId: string;
  title: string;
  detail: string | null;
  lane: 'combo-select' | 'backup';
  expectedMinutes?: number;
  waitMinutes?: number;
  cognitiveLoad: 'high' | 'low';
}
`

**Widget 摘要映射表（v2.0 未给出的精确字段映射）：**

| Widget 显示元素 | `FocusSessionStateV2` 来源 | 降级策略 |
| --- | --- | --- |
| 当前 Focus 标题 | `commandCenterTasks[0].title` | 若数组为空显示"无活跃任务" |
| Focus 状态 | `isActive` + `isFocusOverlayOn` | `false` 时显示"已暂停" |
| 剩余时间估算 | `commandCenterTasks[0].expectedMinutes` | 无值时不显示时间 |
| Dock 数量 | `comboSelectTasks.length + backupTasks.length` | 0 时显示"停泊坞为空" |
| Dock 前 3 条目 | `comboSelectTasks.slice(0, 3).map(t => t.title)` | 不足 3 条时按实际数量展示 |
| 认知负荷指示 | `commandCenterTasks[0].cognitiveLoad` | 缺失时不显示 |
| 燃尽预警 | `burnoutTriggeredAt !== null` | 显示"建议休息" |
| Session 持续时间 | `Date.now() - sessionStartedAt` | 非活跃时显示"未开始" |

**新发现的隐性问题：**

`FocusSessionStateV2` 没有 `savedAt` 字段，但 v2.0 的摘要协议假设了 `sourceSavedAt` 的存在。实际上 `savedAt` 是在 `DockSnapshot` 外层包装的，不是 `FocusSessionStateV2` 内部的。`widget-summary` 必须从 `focus_sessions.updated_at`（数据库列）获取时间戳，而不是从 JSONB 内部取。

### 15.7 `TaskParkingMeta` 结构与 Widget 的停泊坞统计

`	ypescript
interface TaskParkingMeta {
  state: 'focused' | 'parked';
  parkedAt: string | null;          // ISO timestamp
  lastVisitedAt: string | null;
  contextSnapshot: ParkingSnapshot | null;
  reminder: ParkingReminder | null;
  pinned: boolean;
}
`

**Widget 停泊坞统计查询的两条路径对比：**

| 路径 | 数据源 | 准确性 | 性能 | 推荐 |
| --- | --- | --- | --- | --- |
| A：从 `focus_sessions.session_state` 读 | `comboSelectTasks` + `backupTasks` 数组 | 可能滞后于最新写入（3s debounce） | 极快（单行 JSONB 读取） | **MVP 推荐** |
| B：从 `tasks` 表聚合 | `WHERE parking_meta IS NOT NULL AND deleted_at IS NULL` | 实时准确 | 较慢（需遍历 + 双重 RLS 评估） | 后续作为校验源 |

**解决方案：** MVP 阶段使用路径 A，同时在 `widget-summary` 中可选返回一个 `dockCountFromTasks` 校验值（路径 B），供客户端检测偏差。偏差超过阈值时，Widget 显示"数据同步中..."而非错误数字。

---

## 16. 离线优先 vs Widget 状态的核心悖论深度分析

这是 v2.0 点到但未彻底解决的最大架构矛盾。

### 16.1 悖论本质

NanoFlow 的核心价值是"离线优先"——本地写入立即生效，云端异步补同步。但 Widget 只能消费云端数据（Windows SW 拉云端；Android 原生无法访问 PWA IndexedDB）。这产生了一个不可消除的"状态裂缝"：

`
用户在 PWA 中将任务拖入停泊坞
  -> PWA IndexedDB 立即更新（UI 反映新状态）
  -> 3s debounce 后才推到云端
  -> Widget 只能看到云端写入前的旧状态
  -> 用户切到桌面看 Widget，发现"刚拖的任务没出现"
  -> 用户产生"数据丢了"的认知错觉
`

### 16.2 状态裂缝的量化分析

| 场景 | 裂缝持续时间 | 用户感知 |
| --- | --- | --- |
| 正常网络 + PWA 前台 | 3-8 秒（debounce + RTT） | 可接受 |
| 正常网络 + PWA 后台/关闭 | 3s-无限（取决于后台存活） | 高风险 |
| 弱网 / 高铁 | 数分钟到数小时 | 极高风险 |
| 完全离线 | 无限期 | 用户必须被明确告知 |
| 浏览器挂起后恢复 | 挂起期 + 300-1000ms 恢复窗口 + 3s debounce | 中等风险 |

### 16.3 v2.0 方案的不足与 v3.0 补充

v2.0 建议"Widget 标注 cloud state + freshness"，但这只解决了"告知用户"，没有解决"缩短裂缝"。

**v3.0 新增方案：同设备 PWA->Widget 快速通道**

**Windows 方向：利用 `postMessage` 主线程->SW 通道**

当 PWA 主线程完成本地写入后（不等 debounce），立即通过 `navigator.serviceWorker.controller.postMessage()` 将摘要变更推送给 SW。SW 收到后，如果 Widget 已安装，立即调用 `self.widgets.updateByTag()` 刷新。

`javascript
// PWA 主线程（Angular service 中）
function notifyWidgetOfLocalChange(summary) {
  navigator.serviceWorker.controller?.postMessage({
    type: 'widget-local-update',
    payload: summary
  });
}

// sw-composed.js（Widget runtime 中）
self.addEventListener('message', (event) => {
  if (event.data?.type === 'widget-local-update') {
    const widget = await self.widgets.getByTag('nanoflow-focus');
    if (widget) {
      const data = JSON.stringify({
        ...event.data.payload,
        freshnessState: 'local-pending',
        warnings: ['local-state-only']
      });
      await self.widgets.updateByTag('nanoflow-focus', { template, data });
    }
  }
});
`

**Windows 方向的新 freshness 状态扩展：**

| 状态 | 含义 | UI 行为 |
| --- | --- | --- |
| `fresh` | 云端已确认的最新状态 | 正常显示 |
| `local-pending` | 本地已变更，云端尚未确认 | 显示数据 + 小型"同步中"图标 |
| `aging` | 数据开始变旧 | 显示上次同步时间 |
| `stale` | 超过阈值 | 强调旧数据提示 |
| `auth-required` | 设备令牌失效 | 引导重新打开 |
| `untrusted` | 数据版本回退 | 只显示入口 |

**这解决了"同设备"的裂缝问题。但跨设备（电脑操作->手机 Widget）的裂缝仍然存在。**

**Android 方向（跨设备）：Supabase Webhook -> Edge Function -> FCM 链路**

v2.0 建议了 "dirty signal" 推送但未给出完整链路实现。v3.0 补充完整链路：

`
用户在电脑 PWA 写入 -> Supabase focus_sessions 表 UPDATE
  -> 数据库触发器 trg_focus_sessions_updated_at 自动更新 updated_at
  -> Database Webhook（新增）监听 focus_sessions UPDATE 事件
  -> Webhook 调用 widget-notify Edge Function
  -> widget-notify 查询 widget_devices 表找到该 user 的所有设备
  -> 对 Android 设备：发送 FCM data message（非 notification message）
  -> 对 Windows 设备：无直接推送能力，依赖 periodicsync
  -> Android 收到 FCM data message -> onMessageReceived
  -> 触发 widget-summary 拉取 -> Glance Widget 刷新
`

**关键设计决策：FCM data message vs notification message**

| 类型 | 用户感知 | 适用场景 |
| --- | --- | --- |
| Notification Message | 状态栏弹出通知，有声音和视觉提示 | 不适用——Widget 刷新不应打扰用户 |
| Data Message | 完全静默，用户无感知 | **Widget 刷新的正确选择** |

FCM data message 格式：

`json
{
  "to": "<device-fcm-token>",
  "data": {
    "type": "widget_dirty",
    "summaryVersion": "2026-04-12T09:15:00.000Z|session-123",
    "changeType": "focus_session_update"
  },
  "priority": "normal"
}
`

**为什么用 `priority: normal` 而不是 `high`？**

- 高优先级配额有限（Google 限制每日每应用约 10 万条高优先级消息），且会显著影响设备电量。NanoFlow 不是即时通讯工具，Widget 摘要延迟几分钟完全可以接受。
- 普通优先级在 Doze 模式下会被延迟到下一个维护窗口（通常几分钟内），这与 NanoFlow 的"近实时"SLA 完全匹配。
- 只有在 Focus Session 结束（超时提醒）等真正紧急场景下，才考虑 `priority: high`。

### 16.4 跨设备裂缝的不可消除部分

即使实现了完整的 Webhook->FCM 链路，以下场景的裂缝仍然不可消除：

| 场景 | 裂缝原因 | 是否可解 | 正确做法 |
| --- | --- | --- | --- |
| 电脑离线写入 -> 手机 Widget | 数据未到云端 | 不可解 | Widget 保持上次已知状态 |
| 手机 Doze 模式 | FCM 延迟到达 | 不可解（系统限制） | Widget 接受分钟级延迟 |
| 国产 ROM 杀后台 | FCM 根本收不到 | 不可解（OEM 限制） | WorkManager 兜底 + 用户引导白名单 |
| PWA debounce 窗口内 | 3s 未推送 | 设计如此 | postMessage 同设备快通 |

**核心结论：** 不要试图消除这些裂缝，而是让 Widget 诚实地表达自己的数据来源和新鲜度。

---

## 17. Webhook 到推送的完整实现链路设计

### 17.1 Supabase Database Webhook 配置

当前项目已安装 `pg_net` 扩展（版本 0.19.5），但尚未创建任何 Webhook。

以下是 Widget 推送所需的数据库 Webhook 设计：

`sql
-- Widget 推送触发器：监听 focus_sessions 的 UPDATE
CREATE TRIGGER widget_notify_focus_session_change
  AFTER UPDATE ON public.focus_sessions
  FOR EACH ROW
  EXECUTE FUNCTION supabase_functions.http_request(
    'https://fkhihclpghmmtbbywvoj.supabase.co/functions/v1/widget-notify',
    'POST',
    '{"Content-Type":"application/json","Authorization":"Bearer <service-role-key>"}',
    '{}',
    '5000'
  );
`

**设计约束：**

- Webhook 的 Authorization header 中需要包含 `service_role` key，但不能硬编码在触发器定义中。
- 解决方案：使用 Supabase Vault（`supabase secrets`）存储 key，在 Edge Function 侧通过 `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` 读取。
- Webhook payload 由 `pg_net` 自动生成，包含 `record`（新数据）和 `old_record`（旧数据），无需手动构造。

**为什么不监听 `tasks` 表？**

- `tasks` 表的写入频率远高于 `focus_sessions`（每次编辑标题/内容都 UPDATE）。
- 如果 Webhook 触发 FCM 推送，会产生大量无意义的推送风暴。
- Widget 关心的是"Focus 状态变化"和"停泊坞变化"，这些都通过 `focus_sessions.session_state` 的 JSONB 汇总更新来反映。
- 对于 `black_box_entries` 的新增（用户记录了新想法），可以单独添加 INSERT 触发的 Webhook，因为频率较低。

### 17.2 `widget-notify` Edge Function 设计

`	ypescript
// supabase/functions/widget-notify/index.ts（设计骨架）

import { createClient } from '@supabase/supabase-js';

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: Record<string, unknown>;
  old_record: Record<string, unknown> | null;
}

Deno.serve(async (req: Request) => {
  // 1. 验证请求来源（只接受来自数据库 webhook 的 service_role 调用）
  const authHeader = req.headers.get('Authorization');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!authHeader?.includes(serviceRoleKey)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 2. 解析 webhook payload
  const payload: WebhookPayload = await req.json();
  const userId = payload.record?.user_id as string;
  if (!userId) return new Response('No user_id', { status: 400 });

  // 3. 查询该用户的所有活跃 Widget 设备
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    serviceRoleKey!
  );
  const { data: devices } = await supabase
    .from('widget_devices')
    .select('id, platform, push_token, installation_id')
    .eq('user_id', userId)
    .is('revoked_at', null);

  if (!devices?.length) return new Response('No devices', { status: 200 });

  // 4. 为每个 Android 设备发送 FCM data message
  const androidDevices = devices.filter(
    d => d.platform === 'android-widget' && d.push_token
  );
  const fcmKey = Deno.env.get('FCM_SERVER_KEY');

  const fcmPromises = androidDevices.map(device =>
    fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'key=' + fcmKey
      },
      body: JSON.stringify({
        to: device.push_token,
        data: {
          type: 'widget_dirty',
          installationId: device.installation_id,
          summaryVersion: payload.record.updated_at + '|' + payload.record.id,
          changeType: payload.table + '_' + payload.type.toLowerCase()
        },
        priority: 'normal'
      })
    })
  );

  // 5. Windows PWA 设备：无 FCM 通道，通过 periodicsync 拉取
  await Promise.allSettled(fcmPromises);

  return new Response('OK', { status: 200 });
});
`

**安全注意事项：**

- `FCM_SERVER_KEY` 必须通过 `supabase secrets set FCM_SERVER_KEY=...` 存储，绝对不能硬编码。
- 函数不应在日志中打印 `push_token` 或 `FCM_SERVER_KEY`。
- Google 正在将 FCM Legacy API 迁移到 FCM v1 API（基于 OAuth2），实施时应直接使用 v1 API 避免未来迁移。

### 17.3 推送风暴防护

如果用户在 5 分钟内快速操作 Focus Console 50 次，每次都触发 `focus_sessions` UPDATE，Webhook 就会触发 50 次 `widget-notify` 调用，产生 50 条 FCM 消息。

**解决方案：在 `widget-notify` 中实现窗口去重**

`sql
-- 新增表：记录最近推送时间，用于去重
CREATE TABLE IF NOT EXISTS public.widget_notify_throttle (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_summary_version TEXT
);
`

在 `widget-notify` 中：
- 查询 `widget_notify_throttle`，如果 `last_notified_at` 距今不足 10 秒，跳过本次推送。
- 这样即使 Webhook 高频触发，实际 FCM 推送也被限制在每 10 秒最多 1 次。
- 10 秒的阈值可配置，平衡实时性与推送配额。

---

## 18. Windows PWA Widget：Manifest 声明与模板实现

### 18.1 manifest.webmanifest 的 Widget 声明

当前 NanoFlow 的 `manifest.webmanifest` 中没有任何 Widget 相关字段。Windows PWA Widget 要求在 manifest 中声明 `widgets` 数组：

```json
{
  "widgets": [
    {
      "name": "NanoFlow Focus",
      "tag": "nanoflow-focus",
      "ms_ac_template": "widgets/focus-template.json",
      "data": "widgets/focus-data.json",
      "type": "application/json",
      "screenshots": [
        { "src": "widgets/screenshots/focus-light.png", "sizes": "300x120", "label": "Focus Widget 浅色" }
      ],
      "description": "专注模式状态速览",
      "auth": false,
      "update": 900
    }
  ]
}
```

> v5.1 覆盖说明：上方 manifest 仅用于展示 Windows Widgets 的声明形态，不应被直接当作 NanoFlow 最终配置。对 NanoFlow 而言，`data` URL 不应被理解为可长期缓存的个性化静态 JSON；MVP 也应按第 46 节收敛为 `multiple=false`。

**关键细节：**

- `tag` 是 Widget 的唯一标识，Service Worker 通过 `widgets.getByTag('nanoflow-focus')` 获取。
- `ms_ac_template` 指向 Adaptive Cards JSON 模板。
- `auth: false` 意味着初始状态可以在未登录时展示（显示"请先登录"引导）。
- `update: 900` 表示建议的更新间隔为 900 秒（15 分钟），但 Windows 不保证精确遵守。

### 18.2 Adaptive Cards 模板设计

`widgets/focus-template.json` 的核心结构：

```json
{
  "type": "AdaptiveCard",
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.6",
  "body": [
    {
      "type": "TextBlock",
      "text": "${focusTitle}",
      "weight": "bolder",
      "size": "medium",
      "wrap": true
    },
    {
      "type": "FactSet",
      "facts": [
        { "title": "Dock", "value": "${dockCount} 任务" },
        { "title": "Black Box", "value": "${blackBoxCount} 条记录" }
      ]
    },
    {
      "type": "TextBlock",
      "text": "${freshnessLabel}",
      "size": "small",
      "color": "${freshnessColor}",
      "isSubtle": true
    }
  ],
  "actions": [
    {
      "type": "Action.Execute",
      "title": "打开 NanoFlow",
      "verb": "open-app"
    }
  ]
}
```

**模板绑定变量说明：**

| 变量名 | 来源 | 备注 |
| --- | --- | --- |
| `focusTitle` | `focus_sessions.session_state.label` 或候选 `taskSlots[0].taskTitle` | focus_sessions 不存在时显示"未在专注" |
| `dockCount` | `widget-summary` 返回的 `dock.count` | COUNT 查询，不含实际内容 |
| `blackBoxCount` | `widget-summary` 返回的 `blackBox.count` | 同上 |
| `freshnessLabel` | 客户端计算 `generatedAt` 与 `now()` 的差值 | "刚刚" / "5 分钟前" / "数据较旧" |
| `freshnessColor` | < 5 min = "good", < 30 min = "default", > 30 min = "warning" | Adaptive Cards 内置颜色枚举 |

### 18.3 Service Worker Widget 事件处理

`widgets/widget-runtime.js`（将通过 `importScripts` 组合到主 SW 中）的核心事件：

> v5.1 覆盖说明：下方代码块保留为 v3.0 PoC 级 runtime 示意。其 `clients.openWindow()` 单路径写法已被第 45 节覆盖；其 `cache.match('/widget-summary-cache')` / `cache.put(...)` 写法也已被第 42 节覆盖，不能再被当成 NanoFlow 生产态的权威缓存策略。

```javascript
// widget-runtime.js
// 通过 compose-service-worker.cjs 注入到 NGSW 输出中

self.addEventListener('widgetinstall', async (event) => {
  const widget = event.widget;
  // 初始安装：推送默认模板数据
  const defaultData = {
    focusTitle: '加载中…',
    dockCount: '-',
    blackBoxCount: '-',
    freshnessLabel: '正在同步',
    freshnessColor: 'default'
  };
  event.waitUntil(
    self.widgets.updateByTag(widget.tag, { data: JSON.stringify(defaultData) })
  );
});

self.addEventListener('widgetresume', async (event) => {
  // Widget Board 打开时触发，最佳刷新时机
  event.waitUntil(refreshWidgetData(event.widget.tag));
});

self.addEventListener('widgetclick', async (event) => {
  if (event.action === 'open-app') {
    event.waitUntil(
      // v5.1 覆盖：NanoFlow 实际应优先复用现有窗口，仅在无可复用窗口时 openWindow，见 §45。
      clients.openWindow('/#/projects')
    );
  }
});

self.addEventListener('activate', (event) => {
  // SW 升级后，刷新所有已安装的 Widget 以避免空白
  event.waitUntil(
    (async () => {
      if (!self.widgets) return;
      const widgetList = await self.widgets.getByTag('nanoflow-focus');
      if (widgetList) {
        await refreshWidgetData('nanoflow-focus');
      }
    })()
  );
});

async function refreshWidgetData(tag) {
  try {
    const cache = await caches.open('widget-cache-v1');
    // v5.1 覆盖：此处 cache.match/cache.put 仅保留为早期 PoC 示意；生产态不得把 widget-summary 结果作为共享 Cache API 权威缓存层，见 §42。
    const cachedResponse = await cache.match('/widget-summary-cache');
    let data;
    
    try {
      const response = await fetch('/functions/v1/widget-summary', {
        headers: { 'X-Widget-Token': await getWidgetToken() },
        signal: AbortSignal.timeout(10000) // TIMEOUT_CONFIG.STANDARD
      });
      if (response.ok) {
        data = await response.json();
        // 缓存最新数据
        await cache.put('/widget-summary-cache', new Response(JSON.stringify(data)));
      }
    } catch {
      // 网络失败，使用缓存
      if (cachedResponse) {
        data = await cachedResponse.json();
      }
    }
    
    if (data) {
      await self.widgets.updateByTag(tag, {
        data: JSON.stringify(mapToTemplateData(data))
      });
    }
  } catch (err) {
    // 静默失败，Widget 保持上一次状态
  }
}
```

### 18.4 Manifest Identity 影响评估

当前 NanoFlow 的 manifest `id` 字段为 `"/launch.html"`。添加 `widgets` 数组不会改变 manifest identity，因此：

- 已安装的 PWA 不会被浏览器视为"新应用"。
- 但添加 Widget 后，用户需要 **手动将 Widget 添加到 Widget Board**，不会自动出现。
- 如果在后续版本中修改 `widgets` 数组的 `tag` 值，已添加的 Widget 实例将失效。

### 18.5 部署配置更新

Widget 相关的静态资源需要正确的缓存策略：

**`vercel.json` 需新增：**

```json
{
  "headers": [
    {
      "source": "/widgets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=3600, stale-while-revalidate=86400" }
      ]
    }
  ]
}
```

**`netlify.toml` 需新增：**

```toml
[[headers]]
  for = "/widgets/*"
  [headers.values]
    Cache-Control = "public, max-age=3600, stale-while-revalidate=86400"
```

Widget 模板不应设置过长的缓存（不超过 1 小时），因为模板更新后需要能及时生效。但可以使用 `stale-while-revalidate` 让旧模板在后台更新时仍然可用。

---

## 19. Android Widget 的深水区分析

### 19.1 OEM 后台限制的精确清单

基于 2026 年 Android 生态的实测经验，以下是对 Widget 刷新影响最大的 OEM 限制：

| OEM / ROM | 限制行为 | 对 Widget 的影响 | 缓解措施 |
| --- | --- | --- | --- |
| 小米 / HyperOS | 后台进程 5-10 分钟后杀死 | WorkManager 延迟执行、FCM data message 延迟到达 | 引导用户在电池设置中选择"无限制" |
| OPPO / realme / ColorOS | 后台冻结 + 高优先级 FCM 有配额限制 | Widget 刷新不稳定 | WorkManager + 用户手动刷新降级 |
| vivo / OriginOS | "超级省电"模式下完全冻结后台 | Widget 可能长时间不更新 | 检测电量模式，提示用户切换 |
| 三星 / OneUI | 默认"睡眠应用"列表 | 被列入后 WorkManager 和 FCM 均受限 | 引导从"睡眠应用"中移除 |
| 华为 / HarmonyOS | 自研推送通道（非 GMS） | FCM 完全不可用 | 需要集成华为 Push Kit 或放弃华为设备 Widget 推送 |
| Pixel / 原生 Android | 标准 Doze 模式 | WorkManager 和 FCM 按文档行为运行 | 基线设备，无需额外处理 |

**新增非目标决策：** 华为 HarmonyOS 设备由于不支持 GMS/FCM，在 MVP 阶段不纳入 Android Widget 的目标设备。后续如果用户需求明确，再专门评估华为 Push Kit 集成。

### 19.2 Jetpack Glance Widget 的实际尺寸约束

Android Widget 的视觉呈现受限于桌面网格系统。基于不同手机屏幕，实际可用的尺寸范围：

| 网格尺寸 | 典型宽度 (dp) | 典型高度 (dp) | 适合的 NanoFlow 内容 |
| --- | --- | --- | --- |
| 2x2 | 164-192 | 164-192 | Focus 当前任务标题 + 状态指示 |
| 4x2 | 340-400 | 164-192 | Focus 任务 + Dock 计数 + Black Box 计数 |
| 4x3 | 340-400 | 256-300 | Focus 任务 + Dock 列表前 3 项 + Black Box |
| 4x1 | 340-400 | 72-96 | 快捷入口条：打开 NanoFlow + 快速捕获按钮 |

**设计建议：** MVP 只实现 4x2 和 2x2 两个尺寸。4x3 延后到用户反馈后再评估是否值得增加。4x1 可作为"快捷入口条"单独实现，不依赖摘要数据。

### 19.3 TWA 打开 NanoFlow 的深链路径精确设计

TWA 打开 PWA 的 URL 必须精确匹配当前的 hash 路由体系：

`kotlin
// Android Widget 点击事件处理
fun onWidgetClick(context: Context, intent: String) {
    val baseUrl = "https://your-nanoflow-domain.com"
    val targetUrl = when (intent) {
        "open-workspace" -> "`$`baseUrl/#/projects?entry=widget&intent=open-workspace"
        "open-focus-tools" -> "`$`baseUrl/#/projects?entry=widget&intent=open-focus-tools"
        "open-blackbox" -> "`$`baseUrl/#/projects?entry=widget&intent=open-blackbox-recorder"
        else -> "`$`baseUrl/#/projects?entry=widget"
    }
    val customTabsIntent = CustomTabsIntent.Builder().build()
    customTabsIntent.launchUrl(context, Uri.parse(targetUrl))
}
`

**Digital Asset Links 要求：**

TWA 正常运行（无地址栏、全屏模式）需要 `assetlinks.json` 部署在 `https://your-domain/.well-known/assetlinks.json`。当前仓库已补 build-time 生成链：`scripts/generate-assetlinks.cjs` 会在存在 `ANDROID_TWA_PACKAGE_NAME` 与 `ANDROID_TWA_SHA256_CERT_FINGERPRINTS` 时生成 `public/.well-known/assetlinks.json`，并同步给 Vercel / Netlify 配置静态头；但 release 证书指纹、线上可访问性与实机验真仍属于 `P2` 阶段必须闭合的门禁，不能因为“仓库已能生成文件”就提前宣称 TWA 已完成。

### 19.4 Android Widget 本地缓存策略

Android Widget 不能访问 PWA 的 IndexedDB，需要自己的本地缓存。推荐使用 Jetpack DataStore（轻量、Kotlin Coroutines 友好）：

`kotlin
data class WidgetCacheData(
    val focusTitle: String = "",
    val focusActive: Boolean = false,
    val dockCount: Int = 0,
    val blackBoxPendingCount: Int = 0,
    val summaryVersion: String = "",
    val cachedAt: Long = 0L,
    val freshnessState: String = "stale"
)
`

**缓存更新策略：**

1. FCM data message 到达 -> 立即调用 `widget-summary` 更新缓存 -> 刷新 Widget
2. WorkManager 定期执行 -> 每 30 分钟检查并更新（兜底）
3. Widget 被点击时 -> 在返回结果后顺便刷新缓存
4. 应用从后台恢复 -> 立即刷新缓存

**缓存的最大保留时间：24 小时。** 超过后，Widget 显示"数据已过期，请打开 NanoFlow"。

---

## 20. Widget Token 生命周期与安全深度分析

### 20.1 Token 类型对比

| 属性 | 用户 JWT（当前） | Widget Device Token（新增） |
| --- | --- | --- |
| 签发方 | Supabase Auth | `widget-register` Edge Function |
| 有效期 | 1 小时（Supabase 默认） | 30 天（建议） |
| 刷新机制 | Refresh Token 自动续期 | 主应用登录时自动续期 |
| 作用域 | 全部数据操作 | `widget:summary.read` 只读摘要 |
| 存储位置 | 浏览器 localStorage / memory | Windows: IDB in SW; Android: EncryptedSharedPreferences |
| 吊销粒度 | 按用户全局吊销 | 按设备单独吊销 |
| 泄漏影响 | 可读写全部用户数据 | 只能读摘要（标题+计数） |

### 20.2 Token 生成与验证流程

`
主应用登录成功 -> 检查设备是否已注册 Widget
  |-- 未注册 -> 生成 device_id = crypto.randomUUID()
  |          -> 生成 device_secret = crypto.randomUUID()（明文，仅此时使用）
  |          -> 调用 widget-register：
  |            -> 携带 JWT + { device_id, platform, secret: device_secret }
  |            -> Edge Function 用 SHA-256 hash(device_secret) 存入 widget_devices.secret_hash
  |            -> 返回 widget_token = base64(device_id + ':' + device_secret)
  |          -> 存储 widget_token 到 IDB（Windows）或通过 Intent 传给 Android
  |
  +-- 已注册 -> 检查 token 是否即将过期（< 7 天）
             -> 是 -> 调用 widget-register（rotate）获取新 token
             -> 否 -> 保持现有 token
`

**widget-summary 验证流程：**

`
收到请求 -> 提取 Authorization: Bearer <widget_token>
  -> base64 解码得到 device_id + device_secret
  -> 用 service_role 查询 widget_devices WHERE id = device_id AND revoked_at IS NULL
  -> 比较 SHA-256(device_secret) === secret_hash
  -> 检查 last_seen_at 是否在有效期内（30 天）
  -> 验证通过 -> 更新 last_seen_at -> 执行摘要查询
  -> 验证失败 -> 返回 401
`

### 20.3 设备注销与令牌吊销

用户退出登录时：

`
主应用退出登录
  -> 列出当前设备的 widget_devices 记录
  -> 调用 widget-register（revoke）-> 设置 revoked_at = now()
  -> 清除本地存储的 widget_token
  -> Windows: SW 收到 'widget-token-revoked' message -> Widget 进入 auth-required 态
  -> Android: 清除 EncryptedSharedPreferences 中的 token -> Widget 进入"请登录"态
`

### 20.4 Token 泄漏的影响范围分析

如果 Widget Token 被泄漏：

| 攻击者能做的 | 攻击者不能做的 |
| --- | --- |
| 读取用户的 Focus 任务标题 | 读取任务完整内容（content） |
| 读取 Dock 数量和前 3 个标题 | 创建、修改或删除任何任务 |
| 读取 Black Box 未处理数量 | 读取 Black Box 正文内容 |
| 知道用户正在哪个项目工作 | 访问项目详细数据或附件 |
| 调用 widget-summary 接口 | 调用任何其他 Supabase 接口 |

**风险评级：中。** 泄漏的数据主要是"用户正在做什么"级别的元信息。虽然不涉及核心业务数据，但对于隐私敏感的用户来说仍然不可接受。

**缓解措施：**
- Token 仅存储在安全存储中（IDB 在 SW 上下文中、EncryptedSharedPreferences 在 Android 中）
- Token 有效期 30 天自动过期
- 用户可在设置页面查看和吊销所有已注册设备
- `widget-summary` 对单个 Token 实施 rate limiting（每分钟最多 30 次调用）

---

## 21. 边缘场景与故障模式全覆盖

### 21.1 Widget 生命周期边缘场景

| 场景 | 发生时机 | 预期行为 | 如果不处理的后果 |
| --- | --- | --- | --- |
| SW 升级过程中 Widget 请求 | Angular 发新版 | 新 SW 的 `activate` 事件应刷新 Widget | Widget 可能显示空白直到用户手动刷新 |
| 用户清除浏览器缓存 | 手动操作或存储压力 | Widget Token 从 IDB 丢失 | Widget 进入 auth-required 但没有错误提示 |
| 多 Tab 打开 NanoFlow | 常见使用模式 | 多个 Tab 可能同时 postMessage 给 SW | SW 中需要去重处理，取最新的 postMessage |
| 用户删除了 Focus 对应的项目 | 项目软删除 | Widget 显示的任务链接失效 | 点击 Widget 后白屏或进入空项目 |
| 用户切换账号 | 退出 A 登录 B | Widget Token 对应旧账号 | **Widget 显示 A 的数据给 B 看——严重隐私泄漏** |
| NGSW 进入 unrecoverable state | 版本冲突导致 | SW 重新安装，Widget 事件监听丢失 | Widget 停止更新直到下次 PWA 打开 |
| Widget Board 被系统进程杀死 | Windows 内存压力 | `widgetresume` 不被触发 | Widget 保持旧数据直到下次恢复 |

**账号切换场景（最危险的边缘情况）：**

`
用户退出账号 A
  -> 立即吊销所有 A 的 Widget Token
  -> 清除 SW 中的 IDB Widget 缓存
  -> Widget 进入 auth-required 态

用户登录账号 B
  -> 重新执行设备注册流程
  -> 获取 B 的 Widget Token
  -> Widget 用 B 的 Token 拉取 B 的摘要
`

如果不处理：用户 B 会在 Widget 上看到用户 A 的 Focus 任务——这是严重的隐私泄漏。

**项目软删除场景：**

`widget-summary` Edge Function 必须对 `FocusTaskSlot` 中引用的 `projectId` 和 `taskId` 做存活性校验：

`sql
SELECT id FROM tasks
WHERE id = ANY(task_ids_array) AND deleted_at IS NULL;

SELECT id FROM projects
WHERE id = ANY(project_ids_array) AND deleted_at IS NULL;
`

如果任务或项目已软删除，摘要中应将其标记为 `{ valid: false }`，Widget 不为其生成点击链接。

### 21.2 网络与同步的边缘场景

| 场景 | Widget 应做的 | Widget 禁止做的 |
| --- | --- | --- |
| `widget-summary` 返回 500 | 保持上次缓存数据，标注 `stale` | 显示错误堆栈或空白 |
| `widget-summary` 超时（>10s） | 使用缓存数据 | 无限重试 |
| `widget-summary` 返回 `schemaVersion` 不匹配 | 降级显示入口按钮 | 尝试解析未知格式 |
| 云端 `focus_sessions` 为空（新用户） | 显示引导文案"从 NanoFlow 开始..." | 显示"无数据"错误 |
| 云端有数据但 `session_state` 为 null | 显示"请在 NanoFlow 中开启 Focus" | 崩溃或显示 undefined |
| FCM Token 过期（Android） | 下次 Token 续期时自动更新 | 默默失去推送能力而不自知 |
| `periodicsync` 被浏览器拒绝 | 降级为只在 `widgetresume` 时刷新 | 依赖必定成功的后台同步 |

### 21.3 并发与竞态条件

**竞态 1：同时收到 postMessage 和 periodicsync**

- postMessage 带来本地 delta（`local-pending` 状态）
- periodicsync 带来云端数据（`fresh` 状态）
- 如果 periodicsync 拉到的云端数据还是"旧的"（因为 debounce 还没 flush），它会把 Widget 从 `local-pending` 回退到"更旧的 `fresh`"

**解决方案：** 每次更新 Widget 时，都记录一个单调递增的 `localUpdateSeq`。periodicsync 拉到的云端数据只有在 `summaryVersion > localUpdateSeq` 时才能覆盖。

**竞态 2：两个 Webhook 几乎同时触发 widget-notify**

- 可能导致两条 FCM message 几乎同时到达
- Android Widget 收到两条后触发两次 `widget-summary` 请求
- 第二次请求的响应可能先到

**解决方案：** Android 侧缓存每次 `widget-summary` 响应的 `summaryVersion`，只有更新的 `summaryVersion` 才写入缓存。

---

## 22. `widget-summary` Edge Function 的完整 SQL 查询设计

> v5.1 覆盖说明：本节中的 `Routine` / `completedToday` / `completionRate` 查询与返回结构，只适用于未来已经统一 `logicalDateKey` / timezone 语义后的版本。按第 44 节，当前跨端 Widget MVP 不应把“今日统计”理解为必选字段。

### 22.1 核心查询（使用 service_role，绕过 RLS）

`sql
-- 1. 获取最新的 Focus Session（单行 JSONB）
SELECT session_state, updated_at
FROM focus_sessions
WHERE user_id = :user_id
ORDER BY updated_at DESC
LIMIT 1;

-- 2. 获取 Black Box 未处理计数
SELECT COUNT(*) AS pending_count
FROM black_box_entries
WHERE user_id = :user_id
  AND deleted_at IS NULL
  AND is_completed = false
  AND is_archived = false
  AND (snooze_until IS NULL OR snooze_until <= :now);

-- 3. 获取今日 Routine 完成数
SELECT COUNT(*) AS completed_today
FROM routine_completions
WHERE user_id = :user_id
  AND date_key = :today;

-- 4. 获取 Routine 定义总数（用于计算完成率）
SELECT COUNT(*) AS total_routines
FROM routine_tasks
WHERE user_id = :user_id
  AND is_enabled = true;

-- 5. 校验摘要中引用的 project/task 是否仍存活
SELECT id FROM tasks
WHERE id = ANY(:task_ids) AND deleted_at IS NULL;

SELECT id FROM projects
WHERE id = ANY(:project_ids) AND deleted_at IS NULL;
`

### 22.2 查询性能估算

| 查询 | 预期走的索引 | 估计耗时 |
| --- | --- | --- |
| Focus Session | `idx_focus_sessions_user_updated_at` | <5ms |
| Black Box count | `idx_black_box_entries_user_id` | <5ms |
| Routine completions | `idx_routine_completions_user_routine_dk` | <3ms |
| Routine tasks count | `idx_routine_tasks_user_updated` | <3ms |
| Task 存活校验 | `tasks_pkey` | <2ms per task |
| Project 存活校验 | `projects_pkey` | <2ms per project |

**总估计：< 25ms**，远在 Supabase Edge Function 的 10s 超时之内。

### 22.3 完整响应契约（v3.0 扩展版）

`json
{
  "schemaVersion": 2,
  "summaryVersion": "2026-04-12T09:15:00.000Z|session-uuid-123",
  "cloudUpdatedAt": "2026-04-12T09:15:00.000Z",
  "freshnessState": "fresh",
  "generatedAt": "2026-04-12T09:15:01.234Z",
  "entryUrl": "./#/projects?entry=widget&intent=open-workspace",

  "focus": {
    "active": true,
    "overlayOn": true,
    "taskId": "task-uuid-1",
    "projectId": "project-uuid-1",
    "title": "撰写组件文档",
    "remainingMinutes": 24,
    "cognitiveLoad": "high",
    "sessionDurationMinutes": 42,
    "valid": true
  },

  "dock": {
    "count": 3,
    "items": [
      { "taskId": "t-2", "projectId": "p-1", "title": "整理测试矩阵", "valid": true },
      { "taskId": "t-3", "projectId": "p-1", "title": "优化构建脚本", "valid": true },
      { "taskId": "t-4", "projectId": "p-2", "title": "Review PR #42", "valid": false }
    ]
  },

  "blackBox": {
    "pendingCount": 2,
    "snoozedCount": 1,
    "todayCreatedCount": 3
  },

  "routines": {
    "completedToday": 4,
    "totalEnabled": 6,
    "completionRate": 0.67
  },

  "burnout": {
    "triggered": false,
    "highLoadCount": 2,
    "windowStartAt": "2026-04-12T08:00:00.000Z"
  },

  "warnings": ["cloud-state-only"],
  "deviceLastSeenAt": "2026-04-12T09:14:55.000Z"
}
`

**v3.0 相对 v2.0 的扩展点：**

- 新增 `focus.overlayOn`：区分"Focus 活跃但无 overlay"和"Focus 活跃且 overlay 开启"。
- 新增 `focus.sessionDurationMinutes`：让 Widget 显示"已专注 42 分钟"。
- 新增 `focus.valid` / `dock.items[].valid`：标记软删除目标，Widget 不为 `valid: false` 的条目生成点击链接。
- 新增 `blackBox.snoozedCount` / `blackBox.todayCreatedCount`：更丰富的 Black Box 统计。
- 新增 `routines`：日常任务完成率。
- 新增 `burnout`：燃尽预警数据，Widget 可显示"建议休息"。
- 新增 `generatedAt`：服务端生成时间，用于客户端精确计算数据年龄。
- 新增 `deviceLastSeenAt`：设备最后活跃时间，用于调试设备是否还活着。

---

## 23. 批判性分析：v1.0 原始想法中的遗留风险

本节对上游 Gemini 分析文档（v1.0 想法来源）中的建议进行批判性审查。

### 23.1 关于"通过 Web Share Target API 静默传数据"的批判

v1.0 想法中建议：

> "在 PWA 内部数据发生关键变化且离线时，通过 Web Share Target API 或构造特定的 Deep Link，静默触发 Android 原生层的 Intent"

**批判：**

- Web Share Target API 要求用户主动触发分享操作（通常是点击"分享"按钮），不能被应用静默调用。
- Deep Link 在 TWA 内部触发时，会打开一个新的 Chrome Custom Tab 而不是向宿主原生壳发送 Intent。
- 【已被 v5.0 §47 / v5.1 结构化清理覆盖】前文的“Chrome 90+”表述已过时；本轮官方再核对后，应按 Chrome 115+、`PostMessageService`、Digital Asset Links 与 host 主动建立 message channel 这些前置条件来理解 TWA PostMessage。

**纠正后的可行方案：**

对于"同设备 PWA->Android Widget"的数据同步，正确路径是：

1. **近期可用：** PWA 在写入 IndexedDB 后，如果检测到 push 成功（3s debounce 后云端确认），Supabase Webhook 会触发 FCM，间接刷新同设备的 Widget。延迟约 5-10 秒。
2. **远期增强：** 如果需要更快的同设备同步，可以利用 TWA PostMessage（按本轮官方再核对，应理解为 Chrome 115+ 且满足 DAL / `PostMessageService` / channel 建立前提）在 PWA 写入本地后立即通知宿主壳层，由壳层直接刷新 Widget。但这要求 TWA 宿主在前台运行，且按第 47 节只属于 optional fast path，不属于 correctness path。

### 23.2 关于"引入本地 SQLite 做双向同步中转"的批判

v1.0 想法中提问：

> "是倾向于接受这种'最终一致性'的延迟，还是打算在 Native 层引入一个本地的小型 SQLite 数据库来做双向同步中转？"

**批判：**

- NanoFlow 的核心哲学是"不造轮子"。引入 SQLite 等于在 Android 侧建立第三个数据存储（PWA IndexedDB + Supabase Cloud + Android SQLite），三者之间的一致性维护成本将远超 Widget 本身的价值。
- 当前 Jetpack DataStore（Proto / Preferences）完全够用于存储 Widget 缓存的摘要级数据（几百字节）。
- 只有在 Widget 需要支持离线写操作时（P3 阶段），才值得考虑引入 SQLite 并建立与 Supabase 的专用同步链路。

**结论：MVP 阶段坚决不引入 SQLite，使用 DataStore 缓存只读摘要。**

### 23.3 关于"updatePeriodMillis 不支持小于 30 分钟"的补充

v1.0 正确指出了 Android 的 30 分钟限制。但需要补充的是：

- `updatePeriodMillis` 实际上不保证精确间隔。系统会将多个 Widget 的更新请求批量处理以节省电量。
- 在 Doze 模式下，`updatePeriodMillis` 触发的更新可能被延迟到下一个维护窗口（最长可达数小时）。
- 因此，NanoFlow 的 Android Widget **不应依赖 `updatePeriodMillis`**，而应依赖：
  - FCM data message（准实时，但受 OEM 限制）
  - WorkManager（15 分钟间隔，比 `updatePeriodMillis` 更可靠）
  - Widget 被点击时主动刷新（最可靠）

### 23.4 关于"Widget 视觉模拟"中的交互边界

v1.0 建议了"2x2 专注胶囊"、"4x2 效率仪表盘"、"4x1 快捷捕获条"三种形态。补充批判：

- **4x1 快捷捕获条**中的"+"按钮如果直接启动语音录制或文字输入，在锁屏状态下可能绕过设备锁屏安全机制。Android Widget 在锁屏下的交互受限于 `android:widgetCategory="keyguard"` 配置。NanoFlow 的 Widget **不应声明 keyguard category**，避免在锁屏下暴露用户数据。
- **2x2 专注胶囊**中的"倒计时器"如果用动画环形进度条实现，会持续消耗 GPU 资源。Android Widget 不支持持续动画（RemoteViews 的限制），Glance 也不支持。正确做法是显示静态的"剩余 XX 分钟"文字，由刷新事件更新数字。

---

## 24. 测试策略深度扩展

### 24.1 Widget 特有的故障注入测试

| 测试场景 | 注入方式 | 预期结果 |
| --- | --- | --- |
| Widget Token 过期 | 在 IDB 中设置过期时间为过去 | Widget 进入 auth-required 态 |
| widget-summary 返回 500 | Edge Function 模拟错误 | Widget 保持缓存数据 + stale 标注 |
| widget-summary 超时 | Edge Function 延迟 15s | Widget 在 10s 超时后使用缓存 |
| summaryVersion 回退 | 模拟旧版本响应 | Widget 拒绝写入缓存 |
| focus_sessions 为空 | 新用户场景 | Widget 显示引导文案 |
| session_state 非法 JSON | 模拟数据损坏 | Widget 降级到"只有入口"模式 |
| 浏览器清除缓存 | 调用 clear site data | Widget Token 丢失，Widget 进入 auth-required 态 |
| 用户切换账号 | 退出->登录不同账号 | Widget 数据完全切换到新账号 |
| 软删除项目 | 删除 Widget 中引用的项目 | Widget 不再为该项目生成点击链接 |
| FCM Token 刷新 | Android 系统触发 onNewToken | widget_devices.push_token 更新 |
| OEM 杀后台 | 强制停止应用 | Widget 保持最后缓存状态直到下次唤醒 |

### 24.2 跨平台一致性测试矩阵

> v5.1 覆盖说明：本表中的“Windows 打开行为”是跨平台一致性对比项，不再表示 Windows 实际实现可以无条件 `openWindow(url)`。NanoFlow 的 Windows 打开策略应以第 45 节的“先复用窗口、必要时再 `openWindow`”为准。

| 验证点 | Windows PWA Widget | Android Glance Widget | 预期一致性 |
| --- | --- | --- | --- |
| Focus 标题完全一致 | Adaptive Cards TextBlock | Glance Text | 字符级一致 |
| Dock 数量完全一致 | FactSet fact value | Glance Text | 数字一致 |
| Black Box 计数一致 | FactSet fact value | Glance Text | 数字一致 |
| 点击打开 URL 一致 | 以第 45 节的“先复用窗口、必要时再 `openWindow`”策略打开同一 URL | `CustomTabsIntent(url)` | URL 一致 |
| 陈旧态提示一致 | freshnessLabel TextBlock | Glance "最近同步" Text | 语义一致 |
| auth-required 行为一致 | "请先登录"模板 | "请先登录" Glance UI | 行为一致 |

### 24.3 Supabase Free Tier 限制对 Widget 的影响

当前项目使用 Supabase 免费方案。Widget 引入后需要评估的配额影响：

| Free Tier 限制 | 当前使用量 | Widget 新增负载 | 是否超限 |
| --- | --- | --- | --- |
| 数据库连接数（60） | ~5-10（正常使用） | +1 per widget-summary 请求 | 不超限 |
| Edge Function 调用（500K/月） | backup 函数低频调用 | 假设 1000 次/天 -> 30K/月 | 不超限 |
| Edge Function 执行时间 | backup 函数较重 | widget-summary < 100ms | 不超限 |
| 数据库空间（500MB） | ~数 MB | widget_devices + throttle 表：微量 | 不超限 |
| 数据库 webhook（pg_net） | 0 | +1-2 个 Webhook | 不超限 |
| 实时连接（200 并发） | 关闭（REALTIME_ENABLED=false） | 不启用 | 不影响 |

**结论：** Widget 在 Free Tier 下可以安全运行，但 FCM 推送需要自己的 Google Cloud 配额（免费额度为 10 万条/天，远超 NanoFlow 需求）。

---

## 25. 完整的隐性问题解决方案索引

本节按问题严重程度排序，为 v2.0 和 v3.0 中发现的每个隐性问题提供一行式的解决方案索引：

| # | 隐性问题 | 严重度 | 解决方案位置 |
| --- | --- | --- | --- |
| 1 | 账号切换后 Widget 显示旧账号数据 | **P0-致命** | section 21.1 账号切换场景 |
| 2 | `widget-summary` 的 `verify_jwt` 矛盾 | **P0-阻塞** | section 15.5 混合认证模型 |
| 3 | RLS 双重 permissive 策略增加查询成本 | **P1-性能** | section 15.2 使用 service_role 绕过 |
| 4 | `cascade_soft_delete_connections` 的 `search_path` 未固定 | **P1-安全** | section 15.3 修复 search_path |
| 5 | 离线写入->Widget 状态裂缝 | **P1-体验** | section 16.3 postMessage 快速通道 |
| 6 | 跨设备推送风暴 | **P1-性能** | section 17.3 窗口去重 |
| 7 | `FocusSessionStateV2` 无 `savedAt` | **P1-实现** | section 15.6 使用 focus_sessions.updated_at |
| 8 | SW 升级后 Widget 空白 | **P1-体验** | section 18.3 activate 事件刷新 |
| 9 | 软删除目标产生无效深链 | **P1-体验** | section 21.1 + 22.1 存活性校验 |
| 10 | FCM high priority 配额耗尽 | **P2-性能** | section 16.3 使用 normal priority |
| 11 | 国产 ROM 杀后台 | **P2-体验** | section 19.1 OEM 限制清单 + 白名单引导 |
| 12 | Widget Token 泄漏 | **P2-安全** | section 20.4 影响范围分析 + 缓解措施 |
| 13 | periodicsync 被拒 | **P2-体验** | section 21.2 降级到 widgetresume |
| 14 | 多 Tab postMessage 竞态 | **P2-实现** | section 21.3 单调递增 localUpdateSeq |
| 15 | 华为设备无 GMS/FCM | **P3-范围** | section 19.1 MVP 不纳入 |
| 16 | Android Widget 锁屏隐私 | **P2-安全** | section 23.4 不声明 keyguard category |
| 17 | NGSW unrecoverable state | **P2-体验** | section 21.1 下次打开 PWA 时重新注册 |
| 18 | 两个 Webhook 竞态 | **P2-实现** | section 21.3 summaryVersion 比较 |
| 19 | `black_box_entries.project_id` 缺索引 | **P2-性能** | section 15.4 P1 前补索引 |
| 20 | Widget 构建链与 NGSW 升级冲突 | **P2-实现** | section 15.1 新增 compose-service-worker.cjs |
| 21 | 引入 SQLite 增加架构复杂度 | **拒绝** | section 23.2 MVP 不引入 |
| 22 | Web Share Target API 静默调用 | **拒绝** | section 23.1 不可行，已纠正 |

---

## 26. 修订后的分阶段实施路线图（v3.0 精确版）

### P0：Web 入口与契约准备

**新增交付物（v3.0 补充）：**

- 账号切换时的 Widget 数据清理逻辑（清除 IDB 缓存 + 吊销旧 Token）
- `intent` 参数的壳层解析器，包含对已软删除目标的安全降级
- 构建脚本 `scripts/compose-service-worker.cjs` 的骨架（不含 Widget 逻辑，仅验证组合 SW 注册流程可行）

**验证门禁（v3.0 新增）：**

- [ ] `cascade_soft_delete_connections` 函数的 `search_path` 已修复
- [ ] Auth 的 leaked password protection 已开启
- [ ] 组合 SW 注册后，NGSW 的缓存和更新行为与单独注册时一致

### P1：云侧摘要与设备认证基础设施

**新增交付物（v3.0 补充）：**

- `widget_notify_throttle` 去重表
- `widget-summary` 使用 `service_role` 绕过 RLS，内部手动验证 Widget Token
- `widget-notify` 使用 FCM **v1 API**（非 Legacy API）
- `widget-summary` 的 rate limiting（每 Token 每分钟 30 次）
- `black_box_entries.project_id` 外键索引
- `routine_completions.routine_id` 外键索引

**验证门禁（v3.0 新增）：**

- [ ] widget-summary 在无 JWT 时可通过 Widget Token 成功返回摘要
- [ ] Widget Token 吊销后立即失效
- [ ] 账号切换后旧 Token 无法获取新账号数据
- [ ] 推送去重：10 秒内重复触发只发 1 条 FCM

### P1.5：Windows PWA Widget PoC

**新增交付物（v3.0 补充）：**

- 完整的 `widgets/widget-runtime.js`（包含 section 18.3 的全部事件处理）
- Adaptive Cards 模板 `widgets/focus-template.json`（section 18.2）
- `postMessage` 本地快速通道（section 16.3）
- `vercel.json` + `netlify.toml` 缓存头更新（section 18.5）
- 单调递增 `localUpdateSeq` 竞态防护（section 21.3）

**Kill Criteria 补充（v3.0）：**

- `periodicsync` 在目标 Windows 版本上的注册成功率 < 80%
- SW 升级后 Widget 空白概率 > 5%（通过用户反馈或 Sentry 上报衡量）

### P2：Android 原生 Widget + TWA 壳

**新增交付物（v3.0 补充）：**

- `.well-known/assetlinks.json` 生成链 + 部署
- EncryptedSharedPreferences 存储 Widget Token
- FCM Token 续期逻辑（`onNewToken` -> 更新 `widget_devices.push_token`）
- OEM 后台限制引导页面（引导用户将应用加入电池白名单）
- DataStore 缓存策略（24 小时过期）
- 不声明 `keyguard` widget category（锁屏隐私保护）

**Kill Criteria 补充（v3.0）：**

- 目标设备（小米 / 三星 / Pixel）上 FCM data message 的 10 分钟内到达率 < 70%
- WorkManager 30 分钟任务的实际执行率 < 60%

### P3：交互式 Widget Action

**v3.0 前置条件（之前未明确的）：**

- P1/P1.5/P2 均已稳定运行至少 2 周
- Widget Token 增加 `widget:action.complete-task` 等细粒度 scope
- 新增 `widget-action` Edge Function，接受 Widget 发起的领域变更请求
- `widget-action` 必须将变更排入专用 Action Queue，不直接写业务表
- Action Queue 由主应用下次打开时消费并合并到 offline-first 主链路

---

## 27. v3.0 最终决策建议

### 27.1 相对 v2.0 的关键纠正

| v2.0 原判断 | v3.0 纠正 / 补充 |
| --- | --- |
| `widget-summary` 应 `verify_jwt = true` | 必须 `verify_jwt = false`，内部手动验证 Widget Token |
| Widget 数据从 `savedAt` 取时间戳 | 应从 `focus_sessions.updated_at` 数据库列取 |
| 组合 SW 是"推测可行" | Angular 官方文档已验证 `importScripts` 模式 |
| 推送去重"可以做" | 必须做——需要 `widget_notify_throttle` 表 |
| 账号切换场景"隐含在吊销流程中" | 需要独立设计——是最高优先级的隐私保护场景 |
| Android 方向成本"高于 Windows" | 精确化：华为设备因无 GMS 直接排除；国产 ROM 需要逐一方案 |

### 27.2 如果只能做一件事

如果资源极度有限，只能做一件事，那就是：

**先在 P0 阶段把 `intent` 深链协议和组合 SW 骨架打通。**

这不是因为它最出彩，而是因为所有后续阶段（Windows Widget、Android Widget、甚至 PWA shortcuts）都依赖于"入口可信"和"SW 可扩展"这两个基座。如果基座不稳，后续任何 Widget 实现都会在"升级后白屏"、"点击乱跳"、"账号混淆"等问题上反复返工。

### 27.3 v3.0 最终判断

v3.0 的核心增量不是"发现了更多问题"，而是为每个问题给出了具体的、可直接转化为代码的解决方案。v2.0 回答了"能不能做"，v3.0 回答了"做的时候会在哪里摔跤，以及怎么避免摔跤"。

---

## 28. 附：v3.0 新增研究依据

### 28.1 新增仓库实现审计

- `src/app/core/state/stores.ts`：TaskStore / ProjectStore / ConnectionStore 的 Signal 结构
- `src/models/focus.ts`：`FocusSessionStateV2` / `FocusTaskSlot` / `BlackBoxEntry` 完整接口
- `src/models/parking.ts`：`TaskParkingMeta` / `ParkingSnapshot` 完整接口
- `src/services/dock-cloud-sync.service.ts`：云推送/拉取/断路器/挂起恢复完整逻辑
- `src/services/dock-snapshot-persistence.service.ts`：IDB 持久化链/匿名迁移逻辑
- `src/services/sw-registration-strategy.ts`：`createPostHandoffSwRegistrationStrategy` 参数

### 28.2 新增官方文档验证

- Angular Dev：Custom Service Worker Scripts（`angular.dev/ecosystem/service-workers/custom-service-worker-scripts`）—— 确认 `importScripts` 组合模式为官方推荐
- Angular Dev：`SwRegistrationOptions`（`angular.dev/api/service-worker/SwRegistrationOptions`）—— 确认 `registrationStrategy` 可自定义
- Microsoft Learn：PWA Widgets Service Worker API Reference —— 完整 API（`widgets.getByTag`、`updateByTag` 等）
- Android Developers：App Widgets Overview —— Widget 类型、手势限制、刷新机制
- Supabase Docs：Database Webhooks —— `pg_net` 异步 HTTP 触发器

### 28.3 新增线上 Supabase 实时查询

- RLS 策略全量查询：确认 `tasks` 表双重 permissive SELECT 策略
- 触发器全量查询：确认 6 张核心表的 11 个触发器
- 索引全量查询：确认 18 个索引的覆盖范围
- `focus_sessions` 表结构查询：确认 6 个列的类型和约束
- `pg_net` 扩展版本确认：0.19.5
- Edge Functions 列表：5 个函数，均非 Widget 相关
- Performance Advisor：4 个未覆盖外键索引 + 1 个未使用索引
- Security Advisor：1 个 mutable search_path + 1 个 leaked password protection 未开启

### 28.4 上游想法来源

- Gemini Chat 分析（2026-04-12）：TWA + 原生 Widget 架构建议、离线数据悖论提出、FCM data message 链路设计、OEM 后台限制预警、Widget 视觉形态建议
- v3.0 对以上想法的批判性吸收结果记录在 section 23 中

---

# v4.0 交付级扩展：实例边界、发布控制与反假阳性治理

> 版本：v4.0 扩展层  
> 日期：2026-04-12  
> 状态：在 v3.0 基础上继续补盲，目标不是新增“更多想法”，而是把会在真正落地时引爆返工的实例边界、安装身份、发布门禁、可信度预算、共享设备隐私和反假阳性验收补齐。  
> 说明：本层不推翻 v2.0 / v3.0 结论，而是追加此前未被写成硬规则的执行门禁。若后续实现与 v4.0 冲突，以更保守、更可回滚、更能防止假阳性的规则为准。

---

## 29. v4.0 的新增目标与硬规则

v2.0 解决了“方向对不对”，v3.0 解决了“主要技术链路会不会卡住”，但两版都还没有把以下问题提升为上线门禁：

- Widget 到底以“设备”为边界，还是以“实例”为边界。
- 卸载、清缓存、换号、重装之后，旧身份如何被彻底回收。
- `fresh` 到底表示“时间新”，还是“时间新且语义可信”。
- 一旦线上某个平台、某尺寸、某版本出故障，如何只关掉这一小块，而不是把整个计划一起回滚。
- 在共享设备、受管环境、锁屏、企业策略、弱网、系统挂起下，什么能力仍然承诺，什么能力必须明写“不承诺”。

### 29.1 v4.0 新增硬规则

1. 未建立实例边界前，不得把“多 Widget、多尺寸、多个性化配置”写成默认能力。
2. 未建立卸载回收、账号切换清理、孤儿设备清理闭环前，不得把 Widget Token 描述成“可吊销即可安全”。
3. `fresh` 不能只代表“时间戳较新”；必须同时满足版本单调、认证有效、摘要结构兼容、目标资源存活、交叉校验通过，才允许进入 `fresh`。
4. `widget-summary` 是公网可达接口时，必须具备独立的认证、限流、日志脱敏和全局熔断，不得只依赖“Bearer token 存在”这一条。
5. Windows 和 Android 的 Widget 计划必须拆分支持矩阵、验收矩阵、回滚矩阵，禁止继续使用“跨端 Widget”单一表述掩盖平台差异。
6. 所有“近实时”“可做”“不会冲突”一类表述，若尚未在当前启动链、缓存链、升级链、账号链上验证，必须回写为 `PoC 假设` 或 `待验证前提`。
7. 任何时候都不得让 Widget 变成新的领域写路径主干。即使未来支持 Widget Action，也只能进入专用队列，再由主应用语义化消费，不能直写业务真表。
8. Widget 发布必须先有 Feature Flag / kill switch / telemetry，再有用户可见入口；顺序不能倒过来。

### 29.2 v4.0 对现有结论的谨慎化要求

以下类型的句子，在后续维护文档时必须自动降级措辞：

| 原类型 | v4.0 要求的写法 |
| --- | --- |
| 官方支持，所以可行 | 平台能力允许，但尚未在 NanoFlow 当前启动链与缓存链中验证 |
| 不影响现有 PWA 行为 | 预期可兼容，但必须经过安装升级、空缓存、挂起恢复、账号切换验证 |
| 可以保持现有 `registrationStrategy` 不变 | 这是 PoC 假设，不是既成事实 |
| 近实时同步 | 在云端已提交、平台允许刷新、凭证有效时通常可达 |
| 可做多实例 | 只有在 instance-scoped state 落地后才成立 |

---

## 30. 实例模型与配置隔离

这是 v4.0 认为最容易被低估、但后期最容易返工的部分。

当前文档已有 `widget_devices` 设计，但这还不够。`device` 只解决“哪个安装实例拿到了只读摘要令牌”，并不解决“一个设备上摆了几个 Widget、每个 Widget 尺寸/配置是否独立、卸载的是哪个 Widget、哪个 Widget 的缓存与遥测应该被回收”。

### 30.1 必须区分的四层身份

| 层级 | 含义 | 是否跨重装稳定 | 建议来源 | 说明 |
| --- | --- | --- | --- | --- |
| `user_id` | 当前登录用户 | 否 | Supabase Auth | 数据所有权边界 |
| `installation_id` | 某次 PWA 安装 / TWA 安装身份 | 否 | 客户端生成并持久化 | 代表某次宿主安装，而不是某个 Widget |
| `device_id` | Widget 读模型凭证持有者 | 否 | 客户端 `crypto.randomUUID()` | 对应一组 Widget Token / Push Token |
| `widget_instance_id` | 某个具体放置到桌面的 Widget 实例 | 否 | Windows host / Android host 提供，加本地映射 | 代表一个具体卡片实例 |

特别说明：

- Windows Widgets Board 的 `instanceId` 是 host 侧概念，不等价于 `device_id`。
- Android 的 `appWidgetId` 也是 host 侧实例 ID，不等价于安装身份。
- 如果策划案继续只写 `device_id`，后续多实例配置、实例卸载回收、尺寸独立统计、按实例禁用都会混在一起。

### 30.2 新增 `widget_instances` 设计建议

以下 SQL 仅为设计示意，不是可直接执行的迁移。实际建表时仍须遵守 NanoFlow 的客户端 ID 生成规则。

```sql
-- 设计示意：instance 级元数据表，避免把“设备”和“实例”混成一层。
create table public.widget_instances (
  id uuid primary key,
  device_id uuid not null references public.widget_devices(id) on delete cascade,
  user_id uuid not null,
  platform text not null check (platform in ('windows','android')),
  host_instance_id text not null,
  size_bucket text not null,
  config_scope text not null default 'global-summary',
  privacy_mode text not null default 'minimal',
  installed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  unique (platform, host_instance_id)
);
```

### 30.3 MVP 前的产品限制必须写明

如果 P1/P1.5 之前不打算真正实现 instance-scoped 配置，则文档必须明确写出：

1. Windows 首版建议把 widget manifest 的 `multiple` 设为 `false`，或至少只承诺“多个实例是镜像，不是独立配置”。
2. Android 首版即使允许多个放置，也只承诺“展示同一份全局摘要”，不能暗示“每个卡片都可绑定不同项目”。
3. 在 `widget_instances` 与配置页面落地之前，不做“项目级固定卡片”“Focus only 卡片”“Dock only 卡片”的产品承诺。

### 30.4 尺寸与配置必须按实例隔离

无论 Windows 还是 Android，只要允许 resize 或重新配置，就必须保证以下缓存键至少含 `platform + device_id + widget_instance_id`：

- 摘要缓存
- 最后一次 `summaryVersion`
- 最后一次 `freshnessState`
- 最后一次失败原因
- 用户选择的 `privacy_mode`
- bucket 对应的展示密度

否则会出现：

- 一个小尺寸卡片把另一个大尺寸卡片的布局和截断策略覆盖掉。
- 一个实例切换到“隐藏标题”，另一个实例也被强制隐藏。
- 一个实例被卸载后，另一个实例误判为也应回收缓存。

### 30.5 验证方式

- 同一台 Windows 设备放置两个不同尺寸实例时，二者的 `widget_instance_id`、bucket、缓存键、遥测事件都应可区分。
- Android 上同一 Provider 放置两个实例后，删除其中一个不应影响另一个继续刷新。
- 若 MVP 明确禁用独立配置，则两个实例必须被文档和 UI 同时定义为“镜像实例”，避免用户误解。

### 30.6 回滚点

- 若 `widget_instances` 引入后复杂度失控，可回滚为“单安装单实例镜像模式”。
- 回滚时必须同步把 Windows `multiple` 调回 `false`，并在 Android 配置页显式移除实例级选项。

---

## 31. 安装身份、卸载回收与重装再绑定

v2.0 / v3.0 已经写了“Token 可吊销、可轮换”，但还没有把“什么时候吊销、谁来吊销、吊销后本地缓存如何被清理、重装如何获得新身份”写成闭环。

### 31.1 必须建模的状态

建议把 `widget_devices` 与 `widget_instances` 的生命周期写成以下状态，而不是只用 `revoked_at` 一列表达所有情况：

| 状态 | 含义 | 允许拉摘要 | 允许收推送 | 说明 |
| --- | --- | --- | --- | --- |
| `active` | 当前安装、当前账号、当前实例均有效 | 是 | 是 | 正常运行态 |
| `orphaned` | 宿主缓存或应用可能已被清理，但服务端尚未确认卸载 | 否 | 否 | 等待垃圾回收 |
| `revoked` | 账号退出、设备吊销或安全事件后失效 | 否 | 否 | 不可恢复，只能重新注册 |
| `rebound` | 重装或换号后，实例重新绑定到了新的 `device_id` | 是 | 是 | 新旧身份不能共享 token |

### 31.2 必须覆盖的生命周期事件

| 事件 | 必须发生的动作 | 禁止出现的结果 |
| --- | --- | --- |
| `widgetinstall` | 若本地无有效 token，先显示 `auth-required` / `open-app-to-finish-setup`，待主应用完成注册后再切正常摘要 | 未注册即显示旧缓存 |
| `widgetuninstall` | 标记 `widget_instances.uninstalled_at`；若同设备已无存活实例，则停掉 periodic sync / push 映射 | 只删本地 UI，不删服务端记录 |
| 浏览器清站点数据 | 主应用下次启动时发现 token/安装身份缺失，必须把旧 `device_id` 置为 `orphaned` | 旧 token 继续有效 |
| 用户退出登录 | 吊销当前安装下所有 Widget token，清本地摘要缓存，清实例配置缓存 | 登录新账号后仍展示旧账号数据 |
| 用户切换账号 | 先 revoke 旧身份，再重新注册新 `device_id`；旧 `widget_instance_id` 只能重新绑定，不能继承旧凭证 | A 账号 Widget 数据泄漏给 B 账号 |
| 应用重装 | 创建新的 `installation_id` / `device_id` / secret，旧身份只做回收，不做复用 | 重装后复用旧 secret |

### 31.3 为什么“重装复用旧 token”不可接受

看起来复用旧 token 似乎能减少重新注册流程，但它会直接制造三类隐患：

1. 无法区分“真正的旧安装残留”和“用户主动重装后的新安装”。
2. 无法把旧 push token 与新 push token 分清楚，容易把推送发到旧实例。
3. 服务端无法判断某个实例是“恢复”还是“伪造回放”。

因此 v4.0 明确要求：**重装一定换 `installation_id`、换 `device_id`、换 secret。旧身份只回收，不复用。**

### 31.4 孤儿设备清理规则

以下清理策略建议纳入 P1：

- `widget_instances.last_seen_at` 超过 14 天且实例已 `uninstalled_at`，可进入硬删除候选。
- `widget_devices.last_seen_at` 超过 30 天且无活跃实例，自动置为 `orphaned`。
- `push_token` 在设备变为 `orphaned` 或 `revoked` 后立即停用，不进入后续发送名单。
- `widget_notify_throttle` 与实例配置缓存应按同样生命周期一并清除，避免重装后继承旧去重状态。

### 31.5 验证方式

- 卸载 Windows Widget 后，不打开主应用的情况下，服务端最迟在垃圾回收窗口内将其移出活跃实例集。
- Android 上删除一个 Widget 实例后，不应继续接收该实例的 instance-level push/update 统计。
- 用户退出 A 账号再登录 B 账号后，任何旧 token 拉取 `widget-summary` 都必须返回 401/403，而不是新的 B 账号摘要。

### 31.6 回滚点

- 若实例级回收过于复杂，可回滚为“device 级回收优先”，但仍不得放宽账号切换必须清 token 的规则。

---

## 32. SW 注册时序、升级兼容与首次可用性门禁

这是 v4.0 对 Windows 路线最关键的补丁之一。

当前主应用并不是页面一加载就立即注册 Service Worker，而是通过 `createPostHandoffSwRegistrationStrategy({ delayMs: 250, fallbackMs: 4000 })` 在 handoff 后延迟注册。这本身对主应用是合理的，但对 Widget 路线有两个直接影响：

1. “manifest 一上线，Widget runtime 就一定可用”并不成立。
2. “现有 registrationStrategy 可以保持不变”只能算 PoC 假设，不能算已验证事实。

### 32.1 当前启动链对 Widget 的真实含义

| 事实 | 对 Widget 的影响 |
| --- | --- |
| `provideServiceWorker('ngsw-worker.js', ...)` 当前只注册 Angular NGSW | 若要接入 Windows Widgets，必须改为 `sw-composed.js` 或等效组合方案 |
| 注册发生在 handoff 后 | 某些首次启动、异常恢复、冷启动失败场景下，Widget runtime 可能尚未装好 |
| fallback 4 秒后才强制注册 | 浏览器或页面若在此前关闭，首次 SW 安装时机可能被延后 |
| `launch.html` 仍承担历史安装身份兼容 | 任何 Widget 深链和 SW 变更都不能破坏旧安装升级路径 |

### 32.2 v4.0 新增的发布顺序约束

**严禁**在第一次发布 `sw-composed.js` 的同一波版本里，同时上线以下三件事：

1. 组合 SW 注册切换。
2. manifest 的 `widgets` 声明。
3. `widget-summary` 正式生产流量。

推荐顺序必须拆成至少两波：

#### 波次 A：仅发布可扩展底座

- 新增 `sw-composed.js`
- 保持主应用无 Widget manifest 暴露
- 完成 `ngsw-worker.js` 与 `sw-composed.js` 的 `no-cache` 头配置
- 观测主应用更新、恢复、离线缓存、旧安装升级是否稳定

#### 波次 B：在确认底座稳定后再暴露 Widget

- 追加 manifest `widgets`
- 启用 `widgetinstall` / `activate` / `widgetresume` 路径
- 启用 `widget-summary` 读模型与最小灰度

### 32.3 必须新增的首次可用性降级

在以下场景，Widget 不得显示空白：

- 新版 `sw-composed.js` 尚未被浏览器拿到
- 旧版 SW 仍未 activate
- 用户安装了 PWA，但还没前台打开过新版本
- `self.widgets` 所需能力存在，但本地 token 还没注册

建议统一降级为：

- Windows：显示 `Open NanoFlow to finish setup` 模板，而不是空模板。
- Android：显示 `打开 NanoFlow 完成初始化` 或 `请重新登录` 的静态卡片。

### 32.4 升级门禁

必须增加以下验证，才能把“组合 SW 不影响现有 PWA 行为”写进主文案：

- 旧安装从 `ngsw-worker.js` 升级到 `sw-composed.js` 后，`launch.html` 旧快捷方式仍不白屏。
- 浏览器空缓存 + 已安装 PWA + 弱网恢复场景下，Service Worker 不进入升级循环。
- `activate` 事件中的 Widget 刷新失败，不会让 Angular NGSW 主缓存链失效。

### 32.5 回滚点

- 立即把 `provideServiceWorker('sw-composed.js', ...)` 回滚到 `ngsw-worker.js`。
- 同时移除 manifest `widgets`，避免 host 继续装载需要 Widget runtime 的实例。

---

## 33. 摘要可信度预算：`fresh` 不等于正确

v2.0 / v3.0 已经引入 `freshnessState`，但 ఇంకా缺一层更重要的语义：**数据可能是新的，但仍然是错的。**

例如：

- `focus_sessions.updated_at` 很新，但 `session_state` 里引用的 task 已软删除。
- `summaryVersion` 在时间上变新了，但其实来自旧账号或旧实例。
- `dock.count` 来自快照，而 `tasks.parking_meta` 的交叉校验已经明显漂移。

### 33.1 建议把状态拆成三维，而不是一维

| 维度 | 建议字段 | 作用 |
| --- | --- | --- |
| 时间新鲜度 | `freshnessState` | 判断“多久前生成的” |
| 结构可信度 | `trustState` | 判断“是否通过版本、认证、资源存活、交叉校验” |
| 数据来源语义 | `sourceState` | 判断“来自云确认、同设备 local-pending、还是纯缓存回显” |

建议状态值：

#### `freshnessState`

- `fresh`
- `aging`
- `stale`

#### `trustState`

- `verified`
- `provisional`
- `untrusted`
- `auth-required`

#### `sourceState`

- `cloud-confirmed`
- `cloud-pending-local-hint`
- `cache-only`

### 33.2 只有同时满足以下条件，才允许进入 `fresh + verified`

1. `cloudUpdatedAt` 距今在阈值内。
2. `summaryVersion` 相对本地缓存单调不回退。
3. `schemaVersion` 与客户端兼容。
4. 设备令牌通过验证，且未被吊销。
5. `focus` / `dock` 中引用的 `taskId`、`projectId` 仍存活。
6. 交叉校验未发现超过阈值的漂移。

只要任一条件不满足，就必须降级，不允许只因“时间看起来新”而继续显示 `fresh`。

### 33.3 推荐新增的响应字段

```json
{
  "freshnessState": "fresh",
  "trustState": "verified",
  "sourceState": "cloud-confirmed",
  "consistencyState": "aligned",
  "degradedReasons": [],
  "schemaMinClient": 1,
  "schemaMaxClient": 2
}
```

以上 JSON 仅为设计示意。

### 33.4 交叉校验建议

v4.0 不建议每次都对 `tasks.parking_meta` 做重聚合，但建议至少在以下条件触发轻量交叉校验：

- `dock.count` 突然大幅变化
- `summaryVersion` 回退风险出现
- 目标 task/project 存活校验失败
- 同一设备连续两次拉到矛盾的摘要

交叉校验失败时，UI 必须进入 `untrusted` 或 `provisional`，而不是继续显示“刚刚同步”。

### 33.5 反假阳性显示规则

| 场景 | 正确显示 | 禁止显示 |
| --- | --- | --- |
| token 已失效 | `请重新打开 NanoFlow 完成登录` | 上次缓存仍标为 `fresh` |
| 资源被软删除 | 降级到工作区入口 | 继续生成无效深链 |
| 版本回退 | `数据验证中` / `旧数据已拒绝` | 直接覆写缓存 |
| 同设备 local postMessage 但云未确认 | `同步中` / `local-pending` | 冒充 `cloud-confirmed` |

### 33.6 验证方式

- 人工伪造旧 `summaryVersion` 响应，确认客户端拒绝覆盖。
- 人工删除 `focus` 指向的 task/project，确认 Widget 自动降级而不是保留旧深链。
- 在 Windows 同设备 local fast-path 下，UI 可以显示 `local-pending`，但绝不能显示 `cloud-confirmed`。

---

## 34. 发布策略：Feature Flag、灰度、Kill Switch 与遥测门禁

这部分在 v3.0 已有雏形，但还不够细。

当前仓库已经有 `FEATURE_FLAGS`、启动期 runtime boot flags 和 Sentry 基座。因此 v4.0 的要求不是“新增一套控制面”，而是：**优先复用现有基座，在服务端补一层 Widget 专属的远端熔断。**

### 34.1 推荐的两层控制模型

| 层级 | 作用 | 推荐实现 |
| --- | --- | --- |
| 客户端静态 / 启动期开关 | 决定某段代码是否装载、某个入口是否显示 | 复用 `FEATURE_FLAGS` + runtime boot flags |
| 服务端远端门禁 | 决定某平台 / 某版本 / 某 bucket 是否允许继续 refresh / push / install | `widget-summary` / `widget-register` 响应中的 kill-switch 字段 |

### 34.2 建议新增的客户端开关

以下命名仅为建议，最终可按既有风格调整：

- `WINDOWS_WIDGET_POC_V1`
- `ANDROID_WIDGET_RUNTIME_V1`
- `WIDGET_POSTMESSAGE_FASTPATH_V1`
- `WIDGET_DIRTY_PUSH_V1`
- `WIDGET_MULTI_INSTANCE_CONFIG_V1`
- `WIDGET_ACTIONS_V1`

### 34.3 建议新增的服务端 kill switch 字段

`widget-summary` 或独立的 `widget-capabilities` 响应建议至少包含：

```json
{
  "widgetEnabled": true,
  "installAllowed": true,
  "refreshAllowed": true,
  "pushAllowed": true,
  "reason": null
}
```

这样一旦某个平台出问题，可以只关闭：

- Windows Widget refresh
- Android push dirty
- 某个 schemaVersion
- 某个 runtimeVersion
- 某个 size bucket

而不必整包回滚全部功能。

### 34.4 遥测门禁必须回答的问题

发布前必须确定这些指标会被记录，否则出故障后几乎无法定责：

- `widget_register_success`
- `widget_register_failure`
- `widget_instance_install`
- `widget_instance_uninstall`
- `widget_summary_fetch_success`
- `widget_summary_fetch_failure`
- `widget_summary_schema_mismatch`
- `widget_stale_render`
- `widget_untrusted_render`
- `widget_killswitch_applied`
- `widget_account_switch_cleanup`
- `widget_sw_activate_refresh`
- `widget_push_dirty_sent`
- `widget_push_dirty_dropped`

### 34.5 灰度顺序建议

1. 先发布组合 SW 底座，不暴露 Widget manifest。
2. 再对 Windows PoC 小流量启用 Widget manifest 与本地模板。
3. Windows 验证稳定后，再启用 Android 壳和 dirty push。
4. 最后才讨论多实例配置和 Widget Action。

### 34.6 Kill Criteria 必须量化

以下指标建议进入策划案主干：

- SW 升级后空白 Widget 概率 > 1% 时，立即关停对应平台 Widget。
- 账号切换清理失败出现 1 次，即进入阻塞级事故，停止灰度扩容。
- `fresh + verified` 被误判的反例只要复现 1 次，就不允许对外宣传“Widget 已稳定”。

### 34.7 回滚点

- 客户端 flag 关闭入口显示。
- 服务端 kill switch 关闭 refresh / push。
- manifest 移除 `widgets`。
- Android 停止发送 dirty push，退化为 WorkManager 或仅快捷入口。

---

## 35. 公网摘要接口的防滥用、配额与熔断

`widget-summary` 是目前整个方案里最容易被“功能上可行”掩盖掉的安全面。

因为一旦它采用设备级自定义 token 而不是 JWT，就意味着该函数大概率需要 `verify_jwt = false`，由函数内部自行鉴权。此时真正的问题不再是“能不能查到数据”，而是“这条公网入口如何不被打爆、不被重放、不成为日志泄漏点”。

### 35.1 v4.0 的最小防护要求

1. 只接受 HTTPS。
2. 不接受 query string 携带 token。
3. 优先使用 `POST`，并将设备标识与客户端元数据放在请求头或 JSON body，而不是 URL。
4. 日志中禁止记录原始 token、完整摘要正文、完整 push token。
5. 所有 401/403/429 失败都要进入速率分析，而不是只记业务错误。

### 35.2 建议的限流维度

| 维度 | 建议阈值 | 作用 |
| --- | --- | --- |
| `device_id` | 30 次/分钟 | 防止单设备 bug 或循环刷新 |
| `user_id` | 120 次/分钟 | 防止同账号多个实例风暴 |
| IP | 60 次/分钟 | 防止公网爆破 |
| 失败次数 | 5 次连续失败后退避 | 防止错误密钥持续撞库 |

阈值本身不是硬编码结论，但“至少三维限流 + 失败退避 + 全局熔断”应写成硬规则。

### 35.3 建议的请求元数据

为便于审计和版本兼容，建议请求带上：

- `x-widget-platform`
- `x-widget-runtime-version`
- `x-widget-instance-id`
- `x-widget-size-bucket`
- `x-widget-schema-version`

这样服务端才能在问题发生时按平台、版本、尺寸定向熔断，而不是只能全局停服。

### 35.4 建议的异常降级策略

| 异常 | 服务端动作 | 客户端动作 |
| --- | --- | --- |
| token 验证失败 | 401 + 记录失败计数 | 进入 `auth-required` |
| 限流命中 | 429 + 明确退避窗口 | 使用缓存，不立即重试 |
| 平台被 kill switch 禁用 | 200 + `refreshAllowed=false` | 停止刷新，保留入口 |
| 下游数据库暂时不稳 | 503 + `retryAfter` | 标记 `stale`，延迟重试 |

### 35.5 回滚点

- 直接在服务端 kill switch 中关闭 `refreshAllowed`。
- 必要时只允许已缓存设备继续读取缓存，不再访问数据库。

---

## 36. 尺寸 Bucket、个性化配置与展示合同

v1.0 和 v3.0 都已经提到“2x2 / 4x2 / 4x3”之类尺寸，但 अभी仍缺少真正的展示合同：**每个 bucket 至少展示什么、绝不能展示什么、resize 后怎么退化、用户能否给不同实例不同配置。**

### 36.1 Windows 与 Android 的 bucket 不应共用一套口径

| 平台 | 建议 bucket | 首版是否支持独立配置 | 备注 |
| --- | --- | --- | --- |
| Windows Widgets Board | `small` / `medium` | 否 | 先做全局摘要，`multiple=false` 更稳妥 |
| Android Widget | `2x2` / `4x2` | 否 | 首版只做镜像实例，不做项目级绑定 |

### 36.2 每个 bucket 的“最低信息合同”

#### Windows `small`

- 当前 Focus 标题或“暂无活跃 Focus”
- 最新同步时间 / freshness 提示
- 打开 NanoFlow 的主入口

#### Windows `medium`

- `small` 的全部信息
- Dock 数量
- Black Box 未处理计数
- 最多 1-3 条 dock 摘要标题

#### Android `2x2`

- 当前 Focus 标题
- 简单状态（进行中 / 已暂停 / 需打开应用）
- 入口点击

#### Android `4x2`

- `2x2` 的全部信息
- Dock 计数
- Black Box 计数
- freshness 提示

### 36.3 首版禁止的个性化承诺

在 `widget_instances` 与配置页落地前，以下都只能写成“后续选项”，不能写成 MVP 能力：

- 某个实例只绑定一个项目
- 某个实例显示某个任务组
- 某个实例只显示 Dock、不显示 Focus
- 某个实例展示详细标题，另一个实例只展示计数

### 36.4 文本截断与隐私合同

无论哪个 bucket，都必须遵守：

1. 不显示 task `content`。
2. 不显示 Black Box 正文。
3. 标题超长时优先截断标题，不牺牲 freshness / auth-required / stale 提示位。
4. 截断策略必须按 bucket 固定，不能随意被另一个实例复用。

### 36.5 picker 截图与示例数据

Windows `widgets` manifest 中的 `screenshots` 只能使用演示数据，不得包含任何真实用户内容。否则即使 Widget 本身安全，安装选择器截图也会形成隐私暴露点。

### 36.6 验证方式

- 从大尺寸缩到小尺寸后，卡片应优先保留 `freshness/auth-required` 提示和主入口，而不是优先保留二级统计。
- 大字体 / 高缩放下，bucket 应退化为更少字段，而不是布局溢出。

---

## 37. 企业环境、共享设备与隐私治理

这部分是 v4.0 明确新增的非功能约束。此前文档更偏个人设备视角，但真正上线后，最容易出现争议的常常是共享设备、企业策略和锁屏/桌面可见性。

### 37.1 默认隐私模式必须更保守

推荐默认策略：

- 首版默认只展示计数和简化标题。
- 详细标题展示必须是用户显式打开的设置，而不是默认开启。
- Android 不声明 `keyguard` widget category，避免锁屏下展示敏感内容。
- Windows 若 host / policy 不允许 Widgets Board，则产品侧降级为 PWA shortcuts，不再暗示 Widget 能力可用。

### 37.2 必须写进文档的受管环境边界

| 场景 | 应写成什么 |
| --- | --- |
| Windows Widgets Board 被组策略禁用 | 不支持 Windows Widget，仅保留 PWA 安装与 shortcuts |
| Android Work Profile / 企业设备 | 只承诺“主应用可用”，不承诺 push/后台刷新一致性 |
| 无 GMS / HarmonyOS | 不纳入 Android Widget MVP 目标设备 |
| 代理 / 防火墙阻断 Edge Function / FCM | 退化为缓存显示和主应用入口，不承诺近实时 |

### 37.3 共享设备风险

即使不是锁屏，也可能在以下场景泄漏：

- 家庭共用 Windows 桌面
- 办公室大屏、投屏、桌面截图
- Android 主屏被旁人直接看到

因此文档必须把“默认 minimal mode”写成产品默认，而不是可选建议。

### 37.4 设备清单与用户可见的吊销能力

若要把“Token 可吊销”写成对用户负责的能力，必须在主应用设置页至少提供：

- 已注册 Widget 设备列表
- 平台类型
- 最近活跃时间
- 当前账号归属
- 一键吊销

否则对用户来说，“可吊销”只是工程实现细节，不是可用产品能力。

### 37.5 数据保留建议

以下为建议值，进入实施前应与隐私政策再对齐：

- 活跃设备心跳：保留 30 天
- 已吊销设备：保留 7-30 天的最小审计记录，再清理
- push token：吊销后立即失效，不再用于发送
- Widget telemetry：仅保留问题定位所需最小窗口，避免长期持有含行为轨迹的明细

### 37.6 验证方式

- 在共享设备模式下，新用户登录前不应看到上一用户的任何 Widget 标题。
- Android 锁屏状态下不应出现详细内容。
- Windows 安装选择器截图不应包含真实用户数据。

---

## 38. 反假阳性验收、故障演练与发布前门禁

这是 v4.0 最终要补上的最后一层：**不是只测“链路能跑通”，而是测“它是否会伪装成成功”。**

### 38.1 必须新增的反假阳性验收

| 编号 | 场景 | 若出现则视为阻塞级失败 |
| --- | --- | --- |
| FP-01 | 旧 token 在账号退出后仍可拉到摘要 | 是 |
| FP-02 | Widget 显示 `fresh`，但目标 task/project 已软删除 | 是 |
| FP-03 | 小尺寸实例更新覆盖了大尺寸实例的缓存与布局 | 是 |
| FP-04 | 卸载一个实例导致另一个实例停止刷新 | 是 |
| FP-05 | 同设备 local-pending 被错误显示为 cloud-confirmed | 是 |
| FP-06 | 服务端 kill switch 生效后，客户端仍持续高频请求 | 是 |
| FP-07 | 组合 SW 升级后 Widget 空白，但主应用无观测信号 | 是 |
| FP-08 | Windows / Android 不支持环境下仍显示“Widget 已可用” | 是 |

### 38.2 必须演练的故障场景

1. 浏览器清缓存后重启应用。
2. 用户从 A 切换到 B 账号。
3. `summaryVersion` 回退。
4. `widget-summary` 连续返回 429 / 503。
5. Windows host suspend -> resume。
6. Android Doze / 后台受限。
7. kill switch 远端关闭某个平台。
8. `focus_sessions` 有数据但其中引用的任务已被软删除。

### 38.3 发布前检查表

- [ ] 组合 SW 已单独上线并稳定运行至少一轮版本升级
- [ ] `widget-summary` 的限流、日志脱敏、全局熔断已验证
- [ ] 账号切换清理流程已通过人工故障演练
- [ ] `fresh/trust/source` 三维状态在 UI 中有明确降级语义
- [ ] Windows/Android 支持矩阵已写进对外文档，不再混用“跨端 Widget”笼统表述
- [ ] 设备清单与吊销能力有清晰产品归属（即使不在 MVP 上线，也需写明后续门禁）

### 38.4 回滚矩阵

| 回滚目标 | 手段 | 影响范围 |
| --- | --- | --- |
| 仅停 Windows Widget | 移除 manifest `widgets` 或服务端 kill switch 针对 Windows | Android 不受影响 |
| 仅停 Android dirty push | 关闭 `pushAllowed` 或客户端 flag | Android 退化为 WorkManager/打开主应用 |
| 仅停 summary refresh | 服务端 `refreshAllowed=false` | 保留静态入口和缓存展示 |
| 全部停 Widget | 客户端 flag + manifest 回滚 + token revoke | 主应用仍可正常使用 |

---

## 39. 文档维护规则：如何避免把 PoC 假设写成事实

这不是功能需求，但它决定了后续所有实现讨论是否还能保持清醒。

### 39.1 v4.0 要求的证据标注法

后续任何编辑此文档时，新增结论至少要标明属于以下哪一类：

| 标签 | 含义 |
| --- | --- |
| `仓库已验证` | 已被当前代码、测试或配置直接证明 |
| `官方文档约束` | 已被 Angular / Android / Chrome / Microsoft / Supabase 官方资料支持 |
| `实时项目快照` | 只对某个日期时点成立的 Supabase live check |
| `PoC 假设` | 方向合理，但尚未在 NanoFlow 当前实现中验证 |
| `后续可选项` | 明确不属于 MVP 或当前阶段 |

### 39.2 后续编辑时必须避免的写法

- 不要把 `PoC 假设` 写成“推荐路线已验证”。
- 不要把 `实时项目快照` 写成长期静态事实。
- 不要把 `后续可选项` 写成当前阶段范围。
- 不要把平台文档支持写成“对 NanoFlow 当前启动链已无风险”。

### 39.3 建议的评审问句

每次再编辑此文档时，至少问自己这五个问题：

1. 这句话是仓库事实、官方约束、时点快照，还是推测？
2. 若它失败，会出现功能失败，还是“看起来成功其实错了”的假阳性？
3. 这个规则是 device 级、instance 级，还是 account 级？
4. 若线上只坏某个平台 / 某 bucket / 某版本，是否已有独立熔断手段？
5. 用户在共享设备、换号、卸载、清缓存后，会不会看到不该看到的数据？

---

## 40. v4.0 最终建议

如果只保留一句最关键的 v4.0 结论，那就是：

**NanoFlow 的 Widget 计划现在最大的风险已经不再是“技术上能不能做出来”，而是“做出来后是否会因为实例边界不清、安装身份回收不完整、状态被误标为 fresh、平台差异被写平、发布缺少 kill switch，而出现一批看起来偶发、实则架构层必然出现的假阳性事故”。**

因此 v4.0 的建议非常明确：

1. 先把实例边界、身份回收、可信度预算、发布控制和反假阳性验收写成门禁。
2. 再进入 Windows PoC 与 Android 壳层实现。
3. 在这些门禁未落地前，不把任何 Widget 能力写成“已基本可行，只差编码”。

这会让方案看起来更保守，但这是对 NanoFlow 现有 offline-first 主干、安装身份兼容链和用户隐私负责的保守，而不是拖延。

---

## 41. v5.0 再纠偏：`widget-notify` 的鉴权模型不能继续默认写成 `verify_jwt = true`

这一节是本轮最重要的新纠偏点之一。原因不是“喜欢更保守的说法”，而是官方资料已经给出了更接近真实落地的约束：**Supabase Database Webhook 直达 Edge Function 时，不能把它天然视为一条用户态 JWT 链路。**

### 41.1 本轮官方再核对结论

- Supabase 官方 push notification 示例把 webhook 目标函数以 `--no-verify-jwt` 部署。
- Supabase Function 配置文档也明确说明：Edge Function 默认要求有效 JWT；若关闭 `verify_jwt`，则变成公网可调用入口，需要自行承担鉴权责任。
- 这意味着：当前文档前文把 `widget-notify` 写成 `verify_jwt = true`，**只有在额外引入 trusted gateway / queue / signer 中间层时才成立**，不能再作为 direct webhook 的默认前提。

### 41.2 对 NanoFlow 的两条真实可行路径

| 路径 | `widget-notify` 配置 | 可行性 | 代价 |
| --- | --- | --- | --- |
| Supabase Database Webhook -> `widget-notify` Edge Function | `verify_jwt = false` | 可行，最接近官方示例 | 必须自己做 shared secret / HMAC、重放保护、幂等去重、速率限制、日志脱敏 |
| Supabase Database Webhook -> custom gateway / queue -> `widget-notify` | 可保持 `verify_jwt = true` 或走私有内部鉴权 | 可行，但更重 | 额外服务、额外故障面、额外部署与监控成本 |

### 41.3 v5.0 推荐决策

若 P1 阶段坚持使用 **direct webhook**，则必须正式改写职责定义：

- `widget-register`：保持“用户态注册入口”的语义不变，但实现改为 `verify_jwt = false + auth.getUser(token)`，因为 live ES256 access token 已证明 gateway 校验会误拒真实用户会话。
- `widget-summary`：保持 `verify_jwt = false`，通过 device token 做自定义鉴权。
- `widget-notify`：**默认视为内部公网 webhook 入口**，不是 JWT 保护入口。

### 41.4 `widget-notify` 的最低安全门禁

若 `widget-notify` 采用 direct webhook + `verify_jwt = false`，则以下门禁必须是 P1 阻塞项，而不是“上线后再补”：

1. 只接受预共享密钥或 HMAC 签名头，不接受裸请求体即直接执行。
2. 校验事件来源的 `schema/table/type` allowlist，不允许“任何 webhook 都能进来”。
3. 校验时间戳与容忍窗口，防止旧请求重放。
4. 使用 `event_id` 或等价组合键做幂等去重，防止重复推送风暴。
5. 对请求体、头、push token、device token 统一做日志脱敏。
6. 当全局 kill switch 关闭时，应返回快速拒绝，而不是继续打 FCM/Expo/后续通道。

### 41.5 对前文的正式纠偏

v5.0 对本文件前文涉及 Function 鉴权的结论，做如下覆盖性纠偏：

| 接口 | 前文写法 | v5.0 修正 |
| --- | --- | --- |
| `widget-register` | `verify_jwt = false + auth.getUser(token)` | 以函数内显式认证替代 gateway JWT 校验 |
| `widget-summary` | 已在前文纠偏为 `verify_jwt = false` | 保持不变 |
| `widget-notify` | 多处仍写成 `verify_jwt = true` | direct webhook 默认应改写为 `verify_jwt = false`；只有前置 trusted gateway 时才成立 |

换句话说：**不要再把“直连 webhook”与“JWT 保护”同时写成默认状态。二者默认并不天然兼容。**

---

## 42. v5.0 新增：HTTP 缓存与中间层缓存语义必须单独建模

当前文档已经花了很多笔墨讨论 `freshnessState`、`summaryVersion`、`trustState`。但如果 HTTP 层与浏览器层缓存语义没有单独建模，就会出现一种更隐蔽的问题：**状态看起来是 fresh，实际上只是从错缓存里读出来的。**

### 42.1 这个风险为什么在 NanoFlow 里更危险

- `widget-summary` 不是普通静态 JSON，而是设备级摘要接口。
- `widget-summary` 未来大概率走 `verify_jwt = false` + 自定义 token，这意味着它更像“public custom-auth endpoint”，而不是传统的浏览器用户态接口。
- Windows 路线里又会出现 `widgets/focus-data.json` 这种“看起来像静态资源、实际上应该是 runtime data”的路径。
- 如果 CDN、浏览器 HTTP cache、NGSW、Service Worker Cache Storage 中任何一层把上一用户或上一设备的摘要缓存复用了，就会制造跨账号、跨实例、跨时间窗口的数据错读。

### 42.2 v5.0 的硬规则

以下规则必须单独写进实现与发布门禁：

1. `widget-summary` 的 HTTP 响应必须显式声明：

```http
Cache-Control: private, no-store, max-age=0
Pragma: no-cache
Vary: Authorization
Content-Type: application/json; charset=utf-8
```

2. Windows Service Worker 调用 `widget-summary` 时，必须使用 `cache: 'no-store'`，而不是依赖默认 fetch 行为。
3. Android 原生侧调用 `widget-summary` 时，不得走共享 HTTP 响应缓存；本地缓存只能落在 DataStore / SQLite / Encrypted storage 的显式层，不得“顺便依赖 OkHttp/系统 HTTP cache”。当前宿主实现已把 `widgetToken/deviceSecret/pushToken` 放进 `EncryptedSharedPreferences`，把摘要缓存、实例映射和 pending bootstrap 状态放进 DataStore。
4. `/widgets/focus-data.json` 不得作为含真实用户摘要的构建产物存在于 `dist`。若 manifest 需要这个 URL，则它应当是 runtime-only 响应，而不是 build-time personalized file。
5. 若未来增加同源 `/api/widget/*` 或等价路径，必须显式确认它不会被 Angular NGSW `assetGroups/dataGroups` 代理。
6. Widget template 可以缓存，**Widget data 不得通过共享 HTTP cache 作为权威缓存层**。

### 42.3 本项目特有的额外约束

由于当前仓库中：

- `ngsw-config.json` 没有把 Widget 数据 URL 设为专门的 runtime data group。
- `main.ts` 仍注册 Angular NGSW。
- 未来 Windows 路线又计划引入组合 SW。

因此需要额外补一条规则：

**Widget 的正确性不能依赖主应用当前的 polling/realtime transport 是否活跃，也不能依赖浏览器 HTTP cache 是否“刚好命中正确版本”。**

Widget 本地缓存、HTTP 缓存、云端摘要必须分层；三者不能互相伪装。

### 42.4 反假阳性验收

以下任一情况出现，都应视为阻塞级失败：

- 用户 A 退出后，用户 B 用同一浏览器/同一设备登入，`widget-summary` 仍能命中 A 的缓存结果。
- 清理本地缓存后，客户端仍通过 CDN/HTTP cache 取回旧摘要并显示为 `fresh`。
- `widgets/focus-data.json` 在未触发 runtime update 的情况下就能返回“看似真实”的旧用户数据。

---

## 43. v5.0 新增：登出与换号必须采用 server-first revoke 顺序

当前仓库的登出主链路已经做了大量本地清理，但从 Widget 角度看，这还不够。原因很直接：**本地清理失败，不应成为旧 Widget Token 继续有效的理由。**

### 43.1 仓库实现对这个问题的启发

本轮再次核对到的实现事实：

- `AppAuthCoordinatorService.signOut()` 会继续完成登出流程，即使本地清理失败，只是额外弹 warning toast。
- `UserSessionService.clearAllLocalData()` 虽然会清 IndexedDB、localStorage、sessionStorage，但这属于本地善后，不等价于设备级摘要令牌已经失效。
- 目前已有 `onUserLogout()` 的服务主要是 optimistic / undo / attachment 侧，Widget 规划中的设备令牌回收并不存在于现有实现中。

因此，Widget 规划必须显式新增一条顺序性约束。

### 43.2 v5.0 推荐顺序

用户退出登录或 A -> B 换号时，推荐顺序如下：

1. 服务端先执行 `widget-revoke-all-for-user(userId)`，将该用户所有活跃设备令牌打上 `revoked_at`。
2. 同步或异步通知各端 Widget runtime 进入 `auth-required` / `binding-clearing` 态。
3. 主应用再执行本地队列、IDB、launch snapshot、sessionStorage 等清理。
4. 本地清理完成后，才允许新用户把同一 `installation_id` 重新绑定到新账号。

### 43.3 新增字段建议

为了让这个顺序在数据层能落地，建议 `widget_devices` 至少具备以下字段：

| 字段 | 用途 |
| --- | --- |
| `revoked_at` | 旧 token 的立即失效时间点 |
| `binding_generation` | 防止同一安装实例在换号时复活旧绑定 |
| `expires_at` | 硬过期 TTL |
| `last_seen_at` | 清理与审计依据 |
| `last_bound_user_hash` | 仅用于隐私安全诊断，不存明文 user id |

### 43.4 为什么要引入 `binding_generation`

仅靠 `revoked_at` 还不够，因为它只能表达“旧 token 失效”，不能表达“同一个 `installation_id` 已被重新绑定到新的账号世代”。

推荐规则：

- `widget-summary` 返回数据前，既要校验 token secret，也要校验 `binding_generation`。
- 若 generation 不匹配，即使 token 仍未过 TTL，也必须返回 `401` 或 `trustState='binding-mismatch'` 降级信息。

### 43.5 阻塞级故障演练

以下场景应作为 P1 阻塞级故障演练，而不是上线后观察：

1. A 用户退出时本地 IndexedDB 删除一半失败。
2. A 用户刚退出，B 用户立即登入同一设备。
3. 老 token 仍在 Windows SW 或 Android 本地缓存中存活。
4. 老 `summaryVersion` 在新账号绑定后仍被客户端视为 `fresh`。

只要出现“旧账号 token 仍能读摘要”或“新账号看到旧账号标题”任一情况，就不是普通 bug，而是隐私阻塞项。

---

## 44. v5.0 新增：时间语义未统一前，“今日统计”不应作为跨端 Widget MVP 承诺

这是本轮新增的另一个高价值纠偏。因为当前仓库里，“今天”并不是一个稳定的云端概念，而是一个**依赖本地设备时钟与 `routineResetHourLocal` 的逻辑概念**。

### 44.1 当前仓库事实

本轮再核对到：

- `DockDailySlotService.todayDateKey()` 直接基于本地 `Date` 与 `routineResetHourLocal` 计算逻辑日。
- `resetDailySlotsIfNeeded()` 也是按本地逻辑日触发。
- 当前实现中并不存在一个明确的 `canonicalTimezoneIana` 或跨设备统一日界线字段。

这意味着：桌面端与手机端即便登录同一账号，也可能在下列场景下得出不同的“今日完成数”：

- 两台设备时区不同。
- 用户修改系统时区。
- 用户修改 `routineResetHourLocal`。
- 夏令时切换。
- 手动拨快/拨慢设备时间。

### 44.2 v5.0 的推荐决策

在没有统一时间语义前，建议把 Widget 数据分成两类：

| 数据类型 | 当前是否适合跨端 Widget | 原因 |
| --- | --- | --- |
| Focus / Dock / Black Box 摘要 | 适合 | 主要基于云侧快照或稳定计数 |
| `routine` / “今日完成数” / “今日空白期补位统计” | 不适合作为 MVP 承诺 | 当前依赖本地逻辑日，跨设备不稳定 |

因此 v5.0 推荐：

**在 canonical timezone / canonical logical date 模型落地前，不把“今日统计”写进跨端 Widget MVP。**

### 44.3 若未来必须支持“今日统计”

则建议新增一组明确字段，而不是继续隐式沿用本地时间：

```json
{
  "logicalDateKey": "2026-04-12",
  "timePolicy": "canonical-user-timezone",
  "timezoneIana": "Asia/Shanghai",
  "timezoneOffsetMinutes": 480,
  "routineResetHourLocal": 5
}
```

只有当以下条件同时满足时，Widget 才应展示“今日统计”：

1. 服务端与客户端对 `logicalDateKey` 的定义一致。
2. 当前缓存元组未发生 `timezone/resetHour` 漂移。
3. `trustState` 没有进入 `drifted` / `binding-mismatch` / `untrusted`。

### 44.4 若仍坚持在 MVP 中展示

那至少必须加一条诚实规则：

- 当客户端发现当前设备的 `timezoneOffsetMinutes`、`timezoneIana` 或 `routineResetHourLocal` 与缓存不一致时，Widget 应降级隐藏“今日统计”，而不是继续显示旧计数。

### 44.5 必做故障演练

1. 手动改系统时区。
2. 夏令时跨越。
3. 用户修改 `routineResetHourLocal`。
4. 桌面与手机同时在线，但位于不同时区。
5. 手动修改系统时钟后再恢复自动校时。

只要这些场景没被验证过，就不要在对外文案里承诺跨端“今日统计”是稳定可信的。

---

## 45. v5.0 新增：Windows `widgetclick` 必须优先复用现有窗口，不能无条件 `clients.openWindow()`

这一节直接来自仓库既有经验。原因不是 Microsoft 文档写错了，而是 **NanoFlow 自身有过 PWA 双启动与历史 alias 入口耦合问题**。因此 Windows Widget 的打开策略不能只抄官方最短示例。

### 45.1 为什么这是阻塞级问题

当前文档前文示例里已出现 `clients.openWindow('/#/projects')`。这在官方最简 demo 中没问题，但在 NanoFlow 中会放大三类风险：

1. 已有窗口明明存在，却再次打开第二个独立窗口。
2. 旧版 / 升级中的 uncontrolled client 与新 SW 并存，重复点击时更容易双开。
3. 若有人误把 `launch.html` 混进打开路径，会重新触发已修过的 legacy entry 风险。

### 45.2 v5.0 推荐策略

Windows `widgetclick` 的顺序应当是：

1. 先 `clients.matchAll({ type: 'window', includeUncontrolled: true })`。
2. 优先寻找同源且可复用的 NanoFlow 窗口。
3. 若找到，先 `focus()`，再用 `postMessage` 发送 `widget-intent`。
4. 只有在找不到任何可复用窗口时，才 `clients.openWindow(targetUrl)`。

示意代码如下：

```javascript
self.addEventListener('widgetclick', (event) => {
  event.waitUntil((async () => {
    const targetUrl = '/#/projects?entry=widget&intent=open-focus-tools';
    const allClients = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    const existing = allClients.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (existing) {
      await existing.focus();
      existing.postMessage({
        type: 'widget-intent',
        url: targetUrl,
        instanceId: event.instanceId,
      });
      return;
    }

    await clients.openWindow(targetUrl);
  })());
});
```

### 45.3 强制规则

- 任何 Widget 打开路径都不得落到 `launch.html`。
- 必须允许对短时间内重复点击做去重预算，避免快速双击带来双开。
- 当现有窗口还处于 uncontrolled 状态时，也要优先尝试复用，而不是直接放弃。
- 复用窗口逻辑必须是 leader-aware；若命中的现有 NanoFlow client 处于 follower / 只读租约态或未确认能消费 `widget-intent`，则不得把它作为唯一复用目标。
- `postMessage` 只传意图，不传敏感摘要正文。

### 45.4 验证方式

1. 已有窗口存在时，连续点击 Widget 不得再新开第二个窗口。
2. SW 升级前后，旧窗口仍可被聚焦并收到意图。
3. 安装历史 legacy shortcut 的情况下，Widget 打开主应用仍只会命中根路径 + hash。
4. 浏览器恢复可见后第一次点击，不得因 uncontrolled client 导致双开。
5. 同设备存在 leader / follower 多窗口时，Widget 意图不得投递到只读 follower 后又被误判为成功。


---

## 46. v5.0 补强：Windows 官方 `instanceId` / `hostId` API 应反向约束 MVP 范围

此前文档已经提出 `device_id` 和 `widget_instance_id` 不能混用。本轮微软官方资料再次给出更强的依据：Windows Widget Service Worker API 原生就区分 `instanceId`、`hostId`、`tag`、`updateByInstanceId()` 与 `updateByTag()`。这意味着 MVP 的范围必须更明确。

### 46.1 本轮官方再确认的事实

- `widgetinstall` / `widgetuninstall` / `widgetresume` 事件都携带 `instanceId` 与 `hostId`。
- `self.widgets` 同时提供 `getByInstanceId()`、`matchAll({ instanceId, hostId })`、`updateByInstanceId()`。
- `updateByTag()` 是“按 tag 广播式更新”，并不是天然适合有个性化实例的长期方案。

### 46.2 对 NanoFlow 的设计含义

在 NanoFlow 里，至少要区分三种标识：

| 标识 | 语义 | 是否等价 |
| --- | --- | --- |
| `device_id` | 设备级注册实例 | 不等价于 `instanceId` |
| `instanceId` | Widget host 中某个具体卡片实例 | 不等价于 `hostId` |
| `hostId` | 某个宿主板位 / host 维度标识 | 不等价于 `tag` |

### 46.3 MVP 的强约束

v5.0 推荐把以下规则升级为硬约束：

1. Windows `multiple=false`。
2. MVP 只允许镜像式全局摘要，不允许按实例做 project/task 个性化配置。
3. 在上述前提下，`updateByTag()` 仍然可接受。
4. 一旦出现按实例大小、按实例项目、按实例过滤条件的配置需求，就必须切换到 `updateByInstanceId()` 语义。

### 46.4 `widgetuninstall` 的额外规则

前文已有 periodic sync unregister 逻辑，但 v5.0 再加一条明确规则：

- 只有当最后一个实例被移除时，才允许取消对应 tag 的 periodic sync。
- 删除一个实例时，不得把剩余实例也一起判死。

### 46.5 遥测最小集

即使 MVP 不做实例个性化，也建议记录以下最小信息：

- `tag`
- `instanceId` hash
- `hostId` hash
- 最后一次 `summaryVersion`
- 最后一次 `trustState`
- 安装 / 卸载 / resume / click 时间点

这样未来一旦发生“某个实例总是旧、另一个实例正常”的问题，至少有追查依据。

---

## 47. v5.0 再校准：TWA PostMessage 只属于 optional fast path，不属于 correctness path

当前文档前文已经把 TWA PostMessage 定位为未来增强项。v5.0 再补一个更硬的结论：**它不是“做得更好一些的默认通道”，而是一条有明显前置条件的 optional fast path。**

### 47.1 本轮官方再核对到的前提

- 需要 Chrome 115+。
- 需要 `androidx.browser` 的相应版本支持。
- 需要在 Android Manifest 中声明 `PostMessageService`。
- 需要通过 Digital Asset Links 在网页侧声明 `delegate_permission/common.use_as_origin`。
- 需要 host app 在导航完成后主动建立 message channel。
- Web 侧收到消息后仍需自行校验 `origin` 与消息格式。

### 47.2 对 NanoFlow 的现实含义

这意味着：

- TWA PostMessage 不能作为 Android Widget 的 correctness path。
- 即使未来要用它，也只能把它用于“同设备更快地刷新或传递意图”。
- 一旦校验失败、浏览器能力不满足、用户默认浏览器不支持、或 DAL 配置不完整，系统必须退回深链 / query param / 打开主应用这条稳态路径。

### 47.3 v5.0 推荐决策

建议把 Android 打开与同步路径正式分层：

| 层级 | 角色 | 是否可依赖 |
| --- | --- | --- |
| 深链 / query param / TWA 打开 URL | 正式稳态路径 | 可依赖 |
| FCM dirty ping + `widget-summary` 拉取 | Android Widget 的正式刷新路径 | 可依赖 |
| TWA PostMessage | 同设备 fast path / 体验增强 | 不可作为 correctness path |

### 47.4 Kill Criteria

满足任一条件，就应禁用 PostMessage fast path，而不是硬保：

1. 关系校验在目标设备集上不稳定。
2. 用户默认浏览器经常不满足能力条件。
3. message channel 本身引入比收益更大的兼容性问题。
4. 线上难以观测“消息未到达”与“消息到了但未处理”的差异。

---

## 48. v5.0 新增：PoC 有效性前提，不满足时不接受“失败结论”

这条是为后续调研和验证阶段防止“因为环境没搭对，所以误判为方案不行”。

### 48.1 Windows Widget PoC 的有效性前提

只有同时满足以下条件，Windows Widget PoC 的失败才算真实失败：

1. 使用的是公共可安装 HTTPS 端点，而不是仅限 localhost 的页面。
2. 测试机已安装 WinAppSDK 1.2 并开启 Developer Mode。
3. Windows 11 Widgets Board 可用，且未被组策略禁用。
4. manifest `widgets` 与 `sw-composed.js` 已同时部署，而不是只上了其中一半。

### 48.2 Android TWA / Widget PoC 的有效性前提

只有同时满足以下条件，Android 路线的失败才算真实失败：

1. `assetlinks.json` 已部署且可验证。
2. 测试设备具备 Chrome/TWA 运行条件。
3. 若验证 dirty push，则 FCM 凭证链路已完成配置。
4. 至少覆盖一个后台限制明显的 ROM 与一个较接近 AOSP 的基线设备。

### 48.3 不能被当成架构结论的“伪失败”

以下情况都不能直接写成“路线不可行”：

- localhost 打不进 Widgets Board 打包链。
- 因缺失 `assetlinks.json` 导致 TWA / PostMessage 失败。
- 在无 GMS/无 FCM 的设备上验证 Android push 路线失败。
- 只部署了 manifest `widgets`，却没有部署组合 SW runtime。

这些都属于**环境或前提无效**，不是架构本身被证伪。

---

## 49. v5.0 新增阻塞级门禁

在 v4.0 基础上，v5.0 再新增一组更接近“实现前必须定案”的阻塞项：

| 编号 | 门禁 | 阶段 | 不满足时的后果 |
| --- | --- | --- | --- |
| G-41 | `widget-notify` 鉴权模型已选定且与部署方式一致 | P1 | webhook 链路要么不可达，要么暴露为假安全 |
| G-42 | `widget-summary` HTTP 缓存契约已落地 | P1 | 会出现跨账号/跨实例错缓存被标记为 fresh |
| G-43 | logout / account switch 的 server-first revoke 已验证 | P1 | 旧 token 在换号后继续可读 |
| G-44 | “今日统计”要么隐藏，要么已 canonicalize | P1 | 跨设备出现错日、跳零、双记账 |
| G-45 | Windows `widgetclick` 单窗口复用测试通过 | P1.5 | 双开、错误入口、legacy alias 回归 |
| G-46 | Windows `multiple=false` 与 instance boundary 已证明稳定 | P1.5 | 小实例覆盖大实例、卸载串扰 |
| G-47 | TWA PostMessage 被明确降级为 optional fast path | P2 | 把增强通道误写成 correctness path |
| G-48 | PoC 环境前提被逐条验真 | 全阶段 | 用无效实验得出错误架构结论 |

### 49.1 v5.0 新增一条总规则

**Widget 的新鲜度路径必须自洽，不能依赖主应用此刻是否正好在线、正好活跃、正好维持 polling/realtime transport。**

主应用同步链路可以帮助更快，但不能成为 Widget correctness 的隐式前提。

---

## 50. v5.0 最终结论

如果只保留一句 v5.0 的结论，那么应该是：

**NanoFlow 的 Widget 计划现在最危险的地方，已经不是“Adaptive Cards、Jetpack Glance、TWA、FCM 这些技术名词能不能拼起来”，而是“当它们拼起来后，系统是否会因为 webhook 鉴权写错、HTTP 缓存复用、换号回收顺序错误、时间语义漂移、窗口复用策略缺失，而生成一批看似偶发、实则必然出现的假阳性事故”。**

因此 v5.0 的建议非常明确：

1. 先把 webhook 鉴权模型定死。
2. 先把缓存语义定死。
3. 先把换号回收顺序定死。
4. 先把“今日统计”的时间语义定死，或直接从 MVP 中拿掉。
5. 先把 Windows 单窗口复用与实例边界定死。

在这些问题没有定案前，不应再把方案描述成“已经只差编码”。

---

## 51. 本轮新增官方依据补充

以下资料是 v5.0 本轮再核对并直接影响本文纠偏的依据：

- Angular：Custom service worker scripts
  https://angular.dev/ecosystem/service-workers/custom-service-worker-scripts
- Supabase：Function configuration / `verify_jwt`
  https://supabase.com/docs/guides/functions/function-configuration
- Supabase：Push notifications with Edge Functions
  https://supabase.com/docs/guides/functions/examples/push-notifications
- Microsoft Learn：Display a PWA widget in the Windows Widgets Board
  https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps-chromium/how-to/widgets
- Chrome Developers：Trusted Web Activity overview
  https://developer.chrome.com/docs/android/trusted-web-activity/overview
- Chrome Developers：PostMessage for TWA
  https://developer.chrome.com/docs/android/post-message-twa

这些依据没有推翻前文的大方向，但它们让几个此前写得过于“默认安全”或“默认稳定”的点必须被重新收紧：

- direct webhook 不应默认写成 JWT 保护。
- Widget data 不应默认被 HTTP 缓存视为安全可复用资源。
- PostMessage 不应默认被当成 Android 正式链路。
- Windows `widgetclick` 不应默认走最短 `openWindow()` 示例而不考虑本项目的历史双启动约束。
