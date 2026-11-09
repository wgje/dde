---
title: 生产排障
status: canonical
audience: operator
last_verified: 2026-07-15
category: deploy-operate
source_paths:
  - docs/handbook/01-get-started/06-pwa-offline-and-error-recovery.md
  - docs/handbook/02-use-nanoflow/07-android-widget.md
  - docs/handbook/02-use-nanoflow/10-attachments-and-file-safety.md
  - docs/handbook/03-data-sync-safety/01-offline-first-model.md
  - docs/handbook/03-data-sync-safety/02-sync-and-conflicts.md
  - docs/handbook/03-data-sync-safety/03-backup-and-restore.md
  - docs/handbook/03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md
  - docs/handbook/04-deploy-operate/02-supabase-operations.md
  - src/services/sw-update-lifecycle.service.ts
  - src/services/auth-session-cache.service.ts
  - src/services/storage-quota.service.ts
  - src/services/action-queue-storage.service.ts
  - src/services/action-queue-owner-storage.service.ts
  - src/utils/supabase-error.ts
  - src/app/core/shell/workspace-shell-startup-entry-intent-sync.controller.ts
  - src/app/core/shell/workspace-shell-startup-widget-gate-mutation-effect.controller.ts
  - supabase/functions/_shared/widget-common.ts
  - supabase/functions/_shared/widget-fcm.ts
  - supabase/functions/widget-notify/index.ts
  - supabase/functions/cleanup-attachments/index.ts
---

# 生产排障

这页只写当前仓库里已经能从源码或相邻手册核对到的生产排障路径。目标不是给出“理论上也许能行”的建议，而是明确三件事：

1. 先保住现场和数据。
2. 用当前产品真的会出现的信号给故障分流。
3. 把普通运维动作和需要 secrets / 基础设施权限的动作分开。

## 本文内容

- [先分清哪些动作谁可以做](#先分清哪些动作谁可以做)
- [先保全现场再排障](#先保全现场再排障)
- [总分流顺序](#总分流顺序)
- [启动认证与首屏恢复失败](#启动认证与首屏恢复失败)
- [同步与 Stale 数据冲突](#同步与-stale-数据冲突)
- [PWA 与 Service Worker 故障](#pwa-与-service-worker-故障)
- [浏览器 Storage 与本地持久化故障](#浏览器-storage-与本地持久化故障)
- [Supabase Storage 与附件链路故障](#supabase-storage-与附件链路故障)
- [Edge Function 故障](#edge-function-故障)
- [Android Widget 与 TWA 故障](#android-widget-与-twa-故障)
- [回滚恢复与保护边界](#回滚恢复与保护边界)
- [升级处置前最少要交付哪些证据](#升级处置前最少要交付哪些证据)

## 先分清哪些动作谁可以做

### 普通运维可以做的动作

| 动作 | 什么时候做 | 为什么安全 |
| --- | --- | --- |
| 点 `立即刷新` | 看到 `🚀 发现新版本` 或 `版本已更新` 时 | 当前代码已经把这两类提示接到明确刷新路径 |
| 打开系统仪表盘 / 同步状态入口 | `待同步` 不收敛、出现失败操作、冲突、队列冻结时 | 这是当前界面公开暴露的诊断入口 |
| 导出项目 JSON | 准备改同步方向、准备清理浏览器数据、准备升级处置前 | 是当前最基础的保全动作 |
| 导出附件 ZIP | 项目依赖附件，或你准备换设备 / 清浏览器数据时 | JSON 不含原始附件文件 |
| 导出待同步数据 | 看到 `存储受限`、队列冻结或相关导出入口时 | 它能保留待处理队列和冻结原因 |
| 重新登录当前账号 | 看到 `请重新登录 NanoFlow` 或确认会话失效时 | 属于正常会话恢复路径 |
| 在手机上打开 NanoFlow 一次后回桌面手动刷新 widget | widget 处于 setup / auth-required / stale 状态时 | 这是当前 widget 的正常恢复顺序 |

### 需要 secrets 或基础设施权限的动作

| 动作 | 为什么不能当成普通运维动作 |
| --- | --- |
| 设置或轮换 Supabase Secrets | 影响服务端凭据，超出前端/应用内运维边界 |
| 部署或重部署 Edge Function | 属于服务端发布动作 |
| 修改 RLS / policy / bucket 权限 | 会直接改变数据隔离边界 |
| 使用 service role 做诊断或修复 | 当前用户 JWT 不能替代 service role |
| 调用 `cleanup-attachments` 维护入口 | 该函数明确要求维护 bearer secret，普通用户 JWT 或 service-role 请求头都不应直接作为入口凭据 |
| 处理 FCM 构建、push provider 或 Android ADB 强制刷新 | 属于 widget 支持/基础设施链路，不是普通桌面操作 |
| 批量吊销 widget binding | 源码里有支持路径，但不属于普通用户自助流程 |

## 先保全现场再排障

生产排障里最危险的误操作不是“没马上修好”，而是“为了试试看先把现场抹掉”。当前仓库已经反复把下面几件事写成硬边界：

1. **不要先清浏览器站点数据。**
2. **不要在待同步、失败操作、冲突或队列冻结还没导出前就切账号、换设备、重装 PWA 或重装浏览器。**
3. **不要让第二台设备同时接着改同一批任务。**
4. **不要把“提示消失了”当成排障完成。**

最小保全顺序固定为：

1. 记下当前账号、项目、任务、设备和时间。
2. 截图或抄下界面文案。
3. 如果当前设备看起来还持有最新数据，先导出项目 JSON；有附件再导出 ZIP。
4. 如果已经出现 `存储受限`、队列冻结或 `🚨 存储失败 - 数据可能丢失`，优先导出待同步数据或逃生 JSON。
5. 只有证据和导出都在手里，才进入下一步处置。

## 总分流顺序

先用你眼前的信号分流，不要一上来就改配置：

1. **先看更新/启动类提示**
   例如 `🚀 发现新版本`、`版本已更新`、白屏、首屏卡住、重新登录提示。
2. **再看同步状态**
   例如 `待同步`、`连接中断`、失败操作、冲突、另一台设备数据 stale。
3. **再看浏览器本地持久化**
   例如 `存储空间不足`、`存储空间即将耗尽`、`存储受限`、`🚨 存储失败 - 数据可能丢失`。
4. **再看服务端链路**
   例如 Edge Function、Supabase Storage、附件扫描、widget 摘要/通知。
5. **最后才做需要基础设施权限的变更**
   例如 secrets、RLS、bucket、函数部署、FCM 配置。

## 启动认证与首屏恢复失败

### 你可能看到什么

- `🚀 发现新版本`
- `版本已更新`
- 登录后仍回不到预期工作区
- 页面首屏卡住，或启动入口来自 widget / TWA 后没有落到正确界面
- 控制台出现：
  - `SwUpdate checkForUpdate failed`
  - `[FastPath] 本地会话读取失败，回退到网络检查`
  - `[FastPath] 本地 token 即将过期，回退到网络检查`

### 先怎么判断

| 信号 | 代表什么 | 不要误判成什么 |
| --- | --- | --- |
| `🚀 发现新版本` | Service Worker 已经看到可激活新版本 | 普通浏览器 reload 就一定等价 |
| `版本已更新` | 动态加载的 chunk 命中了 stale 资源 | 业务数据损坏 |
| `[FastPath] 本地会话读取失败，回退到网络检查` | 本地会话缓存不可用，认证在降级到网络检查 | 本地项目已经丢失 |
| `[FastPath] 本地 token 即将过期，回退到网络检查` | 本地 token 已接近过期，认证不再信任 fast path | 登录一定已经失效 |

### 安全处置顺序

1. 如果看到 `🚀 发现新版本` 或 `版本已更新`，先点对应提示里的 `立即刷新`。
   不要先用普通 `刷新页面` 代替，也不要立刻清站点数据。
2. 如果是登录恢复问题，先确认是不是正确账号，再重新登录当前账号。
3. 登录后等待当前工作区完成恢复，不要同时去另一台设备继续改同一项目。
4. 如果启动入口来自 widget / TWA，且同时有 widget 相关异常，转到本文后面的“Android Widget 与 TWA 故障”。

### 做完以后要验证什么

- 当前账号是否正确；
- 项目列表是否正确；
- 关键项目和任务是否还在；
- 是否仍有 `待同步`、迁移横幅、离线横幅或存储异常提示。

### 什么时候升级处置

- 同一个环境里反复出现 `SwUpdate checkForUpdate failed`，且一次正确的 `立即刷新` 后仍无法恢复；
- 正确账号重新登录后，工作区仍长期卡在错误状态；
- 启动链路和 widget / TWA 入口交错，无法判断是登录问题还是 widget bootstrap 问题。

## 同步与 Stale 数据冲突

### 你可能看到什么

- `待同步` 长时间不减少
- `连接中断`
- 另一台设备已经改了，但这里看不到
- 系统仪表盘里有失败操作、死信或冲突
- 文案或错误消息接近：
  - `当前离线，跳过云端同步`
  - `网络连接失败，数据将自动重试同步`
  - `浏览器恢复连接中，数据将在稍后自动重试同步`

### 先收集哪些证据

1. 当前账号、当前项目、受影响任务或项目 ID。
2. 另一台设备是不是同一账号，以及哪一台被你认定为当前可信来源。
3. 系统仪表盘里的：
   - 待同步数量
   - 失败操作/死信数量
   - 冲突数量
4. 关键任务的标题、正文、关系、附件入口、Parking / Focus 状态。

### 安全处置顺序

1. 先导出当前项目 JSON；有附件时再导出 ZIP。
2. 打开系统仪表盘或同步状态入口，不要直接清浏览器数据。
3. 只做一次明确动作：
   - 网络刚恢复、会话刚恢复时：做一次 `立即同步` 或单条重试；
   - 明确另一台设备才是可信来源时：对当前项目做重新同步；
   - 进入冲突时：转到冲突中心，不要继续重复点同步。
4. 如果刚经历导入、恢复或长时间离线编辑，优先关闭自动解决，让冲突先暴露出来再处理。

### 明确不要做什么

- 不要通过反复编辑同一字段来“逼同步”；
- 不要把 `清空全部` 当成修复失败操作；
- 不要在没导出前就清缓存、切账号或让另一台设备继续改；
- 不要手改数据库行却不理解 `updated_at` 和 RLS 影响。

### 做完以后要验证什么

- 仪表盘里的待同步和失败操作计数是否符合预期；
- 当前项目仍是正确项目；
- 关键标题、正文、层级、关系、附件入口、Parking / Focus 状态是否正确；
- 另一台设备在同步稳定后是否看到同一结果。

### 什么时候升级处置

- 正确账号、正确项目、网络恢复且做过一次明确重试后，关键数据仍 stale；
- 仪表盘显示的是权限或过滤类问题，需要去核对 RLS；
- 冲突已经进入“本地/云端谁可信”判断，普通运维无法代替业务方做选择。

## PWA 与 Service Worker 故障

### 你可能看到什么

- `🚀 发现新版本` + `立即刷新`
- `版本已更新` + `立即刷新`
- 长时间挂着的页面突然出现更新提示
- 控制台出现：
  - `SwUpdate activateUpdate succeeded`
  - `SwUpdate checkForUpdate failed`

### 当前实现真正会做什么

- 更新检查不只发生在启动时，还会在**定时轮询、页面重新可见、窗口重新聚焦、网络恢复**时继续做。
- `🚀 发现新版本` 这条路径会先尝试 `activateUpdate()`，再走强制清缓存刷新。
- 普通错误边界里的 `刷新页面` 只是普通 reload，不等同于前面那条更新路径。

### 安全处置顺序

1. 有更新提示时，优先点更新提示里的 `立即刷新`。
2. 只有在没有更具体更新提示时，才用错误边界里的 `刷新页面`。
3. 刷新后检查当前账号、项目、待同步和离线提示。
4. 如果是已安装 PWA，再从桌面或主屏图标重开一次确认状态。

### 明确不要做什么

- 不要为了“让更新一定生效”先清站点数据；
- 不要把 stale chunk 问题直接等同于数据损坏；
- 不要在还没确认同步稳定前就卸载 PWA 或切换设备继续编辑。

### 什么时候升级处置

- 正确执行 `立即刷新` 后，仍持续加载到旧资源；
- 控制台持续出现 `SwUpdate checkForUpdate failed`；
- 同一发布在多个会话里都表现为旧版本或 chunk 不一致。

## 浏览器 Storage 与本地持久化故障

这一类要严格分三层，不能混成一句“浏览器存储坏了”。

### 第一层：配额接近上限

当前 `StorageQuotaService` 会在启动时检查一次，之后定时复查；它只会对 warning / critical 两级做提示。

| 你看到的提示 | 当前含义 | 立即动作 |
| --- | --- | --- |
| `存储空间不足` | 达到 warning 阈值 | 先导出 JSON；项目依赖附件时再导出 ZIP；暂停大导入和大批量编辑 |
| `存储空间即将耗尽` | 达到 critical 阈值 | 立即导出；不要继续堆积待同步操作；先处理浏览器或设备空间 |

当前自动“紧急清理”只会清理被标成缓存类的键，例如 flowchart cache、temp、debug；不会把认证、偏好、主题或 undo session 当成普通缓存清掉。

### 第二层：队列冻结 / 存储受限

当 Action Queue 写 `localStorage` 命中 `QuotaExceededError` 时，当前实现会：

1. 冻结队列写入；
2. 把 `queueFreezeReason` 记为当前原因；
3. 上报 `Action queue frozen`；
4. 启动从 30 秒开始、最长退避到 5 分钟的自动重试；
5. 成功恢复时自动解冻。

对应的操作顺序是：

1. 立刻停止大文本、附件上传、批量编辑、导入、删除和切账号。
2. 导出项目 JSON；有附件时导出 ZIP。
3. 如果界面提供“导出待同步数据”，立刻导出。
   这份文件名是 `nanoflow-pending-sync-<timestamp>.json`。
4. 保持当前标签页打开，先处理浏览器空间问题。

### 第三层：存储失败逃生模式

如果 `localStorage` 和 IndexedDB 都不可用，或本地队列快照损坏且备份也恢复不了，当前实现会进入更高一级逃生模式：

- 常驻错误标题：`🚨 存储失败 - 数据可能丢失`
- 文案要求：`请立即复制下方数据进行备份！`
- Shell 会打开 `StorageEscapeModal`

这个模态框里当前会暴露：

- `queue`
- `deadLetter`
- `projects`
- `timestamp`

最安全的顺序固定为：

1. 先复制 JSON。
2. 再下载原始文件。
   文件名是 `nanoflow-backup-<timestamp>.json`。
3. 记下当时的待处理数量、死信数量、冻结原因和时间。
4. 在确认备份已保存前，不要关闭标签页、清站点数据、重新登录或重装应用。

### 什么时候升级处置

- 已经进入 `存储失败`；
- 逃生导出拿不到；
- 队列长时间保持冻结，且空间释放后仍无法自动恢复；
- 需要判断浏览器本地数据是否还能作为可信恢复来源。

## Supabase Storage 与附件链路故障

这里说的是**远端附件与清理链路**，不是前一节的浏览器本地存储。

### 先确认当前边界

- NanoFlow 期望存在私有 bucket：`attachments`
- 该 bucket **不应**改成 public
- 当前删除附件是**软删除优先**：
  1. 给附件写 `deletedAt`
  2. 更新任务里的附件数组
  3. 后续再由 cleanup 队列异步清理远端对象

### 你可能看到什么

- 选中文件后立刻失败
- 当前设备里已经出现文件名，但别的设备打不开
- 删除附件后还想恢复
- 清理作业报 401 / 503

### 安全处置顺序

1. 先判断是“本地 pending 还没上传完”，还是“远端 Storage / 清理链路真的失败”。
2. 如果文件名只在当前设备出现，先确认：
   - 当前设备同步是否已清零；
   - 远端上传是否真的完成；
   - 另一台设备是否同一账号、同一项目并完成同步；
   - 访问链接是否已过期。
3. 准备任何恢复、清理或换设备前，先做：
   - 项目 JSON 导出
   - 附件 ZIP 导出
4. 删除后想恢复时，优先找：
   - 原文件副本
   - 附件 ZIP
   - 项目级恢复路径
   不要把“仓库里有 restore helper”误解成“当前公开入口一定能一键恢复”。

### 涉及基础设施权限的边界

- `cleanup-attachments` 维护入口明确要求维护 bearer secret；
- 它缺少维护 secret 时会返回 `Maintenance secret is not configured`；
- 缺少服务端配置时会返回 `Supabase service configuration is not configured`；
- 普通用户 JWT 或普通前端入口不应直接承担这条清理链路。

### 什么时候升级处置

- bucket 权限、大小限制、病毒扫描或 cleanup secret 明显有问题；
- 远端文件清理、扫描或重扫需要服务端参与；
- 另一台设备长期打不开附件，而当前设备已经确认同步稳定。

## Edge Function 故障

### 先确认哪些功能本来就依赖它

当前手册和源码已经核对到这些正式依赖：

| 功能 | 依赖函数 |
| --- | --- |
| 语音转写 | `transcribe` |
| widget 注册 | `widget-register` |
| widget 摘要 | `widget-summary` |
| widget 通知 | `widget-notify` |
| 附件扫描 / 清理 | 对应上传扫描与 cleanup 函数组 |

### 先收集哪些证据

1. 浏览器请求是否真的打到 `/functions/v1/<name>`。
2. 当前环境到底指向哪个 Supabase project。
3. Function logs 里是否收到请求。
4. 响应是 401 / 403 / 404 / 429 / 5xx 里的哪一类。
5. 是否出现这些明确字符串：
   - `Supabase service role environment is not configured`
   - `Maintenance secret is not configured`
   - `[WidgetTelemetry] ...`

### 安全处置顺序

1. 先核对请求路径、当前环境、函数日志。
2. 先判断是**没部署 / 没请求到 / 请求到了但配置缺失 / 请求到了但权限失败**里的哪一种。
3. 普通运维可以确认降级是否合理，但不要在没权限的前提下尝试伪造 service role 或维护 secret。

### 需要升级权限的典型场景

- 要部署或重部署函数；
- 要补或轮换 Secrets；
- 要确认 service role 是否正确注入；
- 要验证 CORS、provider key、维护 secret、FCM 凭据或 Groq 凭据。

### 什么时候升级处置

- 线上函数根本没收到请求；
- 收到请求但缺少 Secret / service role；
- 响应类别表明是服务端配置问题，而不是普通用户会话问题。

## Android Widget 与 TWA 故障

### 你可能看到什么

前台或桌面文案可能包括：

- `Widget 尚未连接`
- `请先打开 NanoFlow 完成初始化`
- `请重新登录 NanoFlow`
- `摘要待验证，请打开 NanoFlow`
- `当前显示的是本地缓存摘要`
- `数据较旧，点按可打开 NanoFlow`
- `摘要刷新已暂停，请打开 NanoFlow`
- `关联目标已变化，请打开 NanoFlow`
- `Widget 连接未完成，请回到桌面重新点按组件`
- Toast `网络繁忙，请稍后重试`

后台或控制台证据可能包括：

- `Startup entry widget gate mutation failed`
- `[WidgetTelemetry] ...`
- 服务端 token / binding 类错误码：
  - `WIDGET_TOKEN_REQUIRED`
  - `DEVICE_NOT_FOUND`
  - `DEVICE_REVOKED`
  - `BINDING_MISMATCH`
  - `TOKEN_EXPIRED`
  - `TOKEN_INVALID`
  - `INSTANCE_CONTEXT_REQUIRED`
  - `INSTANCE_CONTEXT_INVALID`
  - `INSTANCE_NOT_ACTIVE`
  - `INSTANCE_BINDING_MISMATCH`

### 当前实现允许你先做什么

1. 先确认手机上的当前账号和网络。
2. 打开 NanoFlow 一次，让登录和启动恢复完成。
3. 回到桌面手动刷新 widget。
4. 只有前面三步都做过，且仍卡在 setup / auth-required / stale 状态时，才删除并重新添加组件。

### 先怎么理解这些信号

| 信号 | 当前更可能代表什么 |
| --- | --- |
| `当前显示的是本地缓存摘要` | 这次没拿到新摘要，宿主回退到 cache-only |
| `摘要刷新已暂停，请打开 NanoFlow` | 服务端返回 refresh-disabled，宿主进入退避窗口 |
| `Widget 连接未完成...` | bootstrap 回调被拒绝、过期，或桌面实例上下文已变 |
| `网络繁忙，请稍后重试` | Gate / Focus 的乐观更新被远端失败回滚，本地动画不等于提交成功 |
| `Startup entry widget gate mutation failed` | widget gate 相关远端变更失败，需要按失败路径重试，而不是假定状态已经落地 |

### 明确不要做什么

- 不要手工拼接 `nanoflow-widget://bootstrap` 之类回调协议；
- 不要把 force refresh broadcast、ADB、批量 revoke-all 当成普通用户步骤；
- 不要把“线上 dirty push 一定已打通”当成前提；当前实现允许退化到手动刷新、解锁补刷、打开应用补刷和周期刷新。

### 什么时候升级处置

- 正确账号重新登录并手动刷新后，widget 仍长期停在 setup / auth-required；
- Function logs 里持续出现 `[WidgetTelemetry]` 错误事件或 token / binding 类错误；
- 需要动 FCM、构建配置、ADB 强制刷新或批量吊销绑定。

## 回滚恢复与保护边界

排障时最容易混用的几种“备份 / 导出 / 恢复”边界如下：

| 形式 | 它能保住什么 | 它不能替代什么 |
| --- | --- | --- |
| 项目 JSON 导出 | 项目、任务、连接、附件元数据 | 原始附件文件、本机待同步队列 |
| 附件 ZIP 导出 | 原始附件内容 | 项目结构、关系、同步状态 |
| 待同步数据导出 | 待处理操作、死信、冻结状态、冻结原因 | 普通项目导入恢复 |
| 存储失败逃生 JSON | 当前现场的技术快照 | 正常业务备份 |
| 本地增强备份 | 本机 localState 级恢复材料 | 不经人工核对的“整机无脑回滚” |

另外再记住三个保护边界：

1. **附件删除不是立即物理删除远端文件。**
2. **`清空全部`、`忽略`、`刷新页面`、`重新同步` 都不是同一种动作。**
3. **widget 的 binding/token 清理会把组件带回 setup/auth-required，不等于数据自动恢复。**

## 升级处置前最少要交付哪些证据

如果需要把问题升级给能动 secrets、RLS、函数部署或 Android 构建的人，至少带上这些：

1. 当前环境和域名。
2. 当前账号、项目、任务或附件标识。
3. 你看到的原始文案或错误字符串。
4. 浏览器控制台中的关键日志，尤其是：
   - `SwUpdate checkForUpdate failed`
   - `[FastPath] 本地会话读取失败，回退到网络检查`
   - `[FastPath] 本地 token 即将过期，回退到网络检查`
   - `Startup entry widget gate mutation failed`
   - `Action queue frozen`
5. Function logs 中的关键行，尤其是：
   - `[WidgetTelemetry] ...`
   - `Supabase service role environment is not configured`
   - `Maintenance secret is not configured`
6. 现场导出物：
   - 项目 JSON
   - 附件 ZIP
   - `nanoflow-pending-sync-<timestamp>.json`
   - `nanoflow-backup-<timestamp>.json`
7. 你已经做过哪些动作，以及每一步之后验证到了什么。

只要这些证据还不完整，就先不要做更激进的清理、迁移或覆盖动作。

## 下一步

- 继续核对 Supabase 项目、RLS、bucket 和 secrets：读 [Supabase 运维](02-supabase-operations.md)。
- 继续处理 PWA、离线、队列冻结和逃生导出：读 [应用安装、离线与错误恢复](../01-get-started/06-pwa-offline-and-error-recovery.md)。
- 继续处理待同步、死信、冲突和重同步：读 [同步诊断与冲突中心](../03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md)。
- 需要恢复材料和恢复后验收顺序：读 [备份与恢复](../03-data-sync-safety/03-backup-and-restore.md)。
