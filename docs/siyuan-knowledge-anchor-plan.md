# NanoFlow × SiYuan Knowledge Anchor 策划案

> **版本**：v1.1  
> **日期**：2026-04-28  
> **状态**：Draft for implementation  
> **定位**：思源笔记是知识源头（Source of Truth），NanoFlow 是执行工作台（Execution Workspace）  
> **核心决策**：NanoFlow 只保存思源块指针与少量元数据，不嵌入思源 UI，不在 MVP 同步正文到云端，不在 MVP 做双向写回。

---

## 0. 执行摘要

本方案建议为 NanoFlow 引入一个轻量的外部知识锚点能力：**在任务块中挂载思源块链接，悬浮或点击时展示 NanoFlow 原生预览，点击时跳回思源原块**。

该能力的产品边界必须收紧为：

1. **思源负责内容主权**：长文、知识块、引用网络、属性体系继续留在思源。
2. **NanoFlow 负责执行推进**：任务排序、Focus、Parking Dock、流程推进仍由 NanoFlow 主导。
3. **指针优先于镜像**：默认只同步块 ID、URI、路径、标签、角色等轻量信息；正文预览默认仅保存在本机。
4. **只读优先于写回**：第一阶段只做读取预览、打开原块、刷新缓存、解除关联，不做从 NanoFlow 改写思源。

### 0.1 本案最终裁决

针对 HTTPS PWA 无法直接请求 `http://127.0.0.1:6806` 的 Mixed Content 物理限制，本案**优先采用桌面浏览器扩展 Relay** 作为突破方式，而不是先做本地 HTTP bridge。

原因：

1. **兼容公网 HTTPS PWA**：扩展可以在浏览器权限模型内访问本地思源内核，不要求 NanoFlow 页面直接发起 mixed-content 请求。
2. **避免本地证书分发复杂度**：如果先做本地 bridge，要么仍然是 HTTP 被拦截，要么必须处理本地 HTTPS 证书信任，实施成本高且易出故障。
3. **对现有 NanoFlow 改动最小**：前端只需要接一个 provider 抽象层，桌面端通过扩展拿预览，移动端和未安装扩展的环境直接降级为缓存预览 + 深链打开。
4. **更符合 MVP 节奏**：先把链接绑定、缓存预览、深链回跳跑通，再为桌面浏览器补上“在线预览”能力，产品风险最小。

因此，本案采用三层运行时策略：

| 运行时 | 预览能力 | 打开原块 | 备注 |
|------|------|------|------|
| 桌面浏览器 + NanoFlow Extension | 实时预览 | 支持 | 主路径 |
| 本地开发 / 本地桌面壳（未来） | 实时预览 | 支持 | 次路径 |
| 公网 HTTPS PWA / 移动端 / 无扩展桌面 | 缓存预览或无预览 | 支持 | 降级路径 |

---

## 1. 背景与目标

NanoFlow 的核心价值在于离线优先、任务执行、Focus 与 Dock 调度；思源笔记的核心价值在于块级知识管理、引用、双向链接与长文材料承载。两者并不应该互相吞并，而应建立清晰分工：

```text
SiYuan：事实、背景、资料、知识块、原始上下文
NanoFlow：拆解、推进、切换、执行、专注、停泊
```

本功能的目标，是让任务在执行时拥有“足够近”的知识上下文，但不让 NanoFlow 演化成第二个知识库。

### 1.1 目标

1. 允许任务挂载一个或多个思源块作为上下文锚点。
2. 在任务卡、Focus、Parking Dock 中以克制方式显示思源来源。
3. 在桌面端提供安全、快速、只读的块预览体验。
4. 在移动端和弱连接场景下提供缓存预览或深链回跳。
5. 维持 NanoFlow 现有 Offline-first、LWW、Signals、按设备本地配置的架构原则。

### 1.2 非目标

以下内容**不进入 MVP**：

1. 在 NanoFlow 中内嵌思源原生 UI 或 iframe。
2. 在 NanoFlow 中搜索整个思源库。
3. 将完整思源正文默认同步到 Supabase。
4. 从 NanoFlow 直接编辑、删除思源块。
5. 默认向思源写回 NanoFlow 状态。

---

## 2. 产品定位与命名

建议将该能力命名为：**Knowledge Anchor / 知识锚点 / 思源锚点**。

任务卡中的呈现建议如下：

```text
任务标题
任务描述 / Markdown 内容

来源  思源：/项目资料/产品设计/悬浮窗联动方案
```

桌面端 hover 或移动端点击后，弹出 NanoFlow 自己渲染的预览层：

```text
/项目资料/产品设计/悬浮窗联动方案      打开思源   刷新

这里是思源块的摘要正文
- 子块 1
- 子块 2
- 相关背景说明
```

点击“打开思源”时，使用：

```text
siyuan://blocks/{blockId}?focus=1
```

---

## 3. 核心产品原则

### 3.1 Source of Truth 原则

思源是原块事实源，NanoFlow 只保存：

1. 指向思源块的稳定标识。
2. 用于显示的轻量元数据。
3. 当前设备本地缓存的只读预览。

### 3.2 执行优先原则

Knowledge Anchor 的作用是降低“切出任务上下文”的摩擦，而不是把用户引导回长时间阅读。任何预览层都要服务于任务推进，而不是制造新的信息漫游。

### 3.3 降级优先原则

如果当前环境无法安全访问思源内核，本功能仍需保持可用：

1. 能显示锚点。
2. 能打开原块深链。
3. 如果存在本地缓存，则优先展示缓存。
4. 不因为思源不可达而阻塞任务工作流。

### 3.4 只读优先原则

在 read-only 能力稳定之前，不开放写回路径。所有写回能力都必须是用户显式选择加入（opt-in），而不是默认开启。

---

## 4. 关键约束与物理边界

### 4.1 Web 平台约束

当 NanoFlow 运行在公网 HTTPS PWA 环境时，浏览器会拦截页面对 `http://127.0.0.1:6806` 的直接请求。这意味着：

1. **前端页面不能直接 fetch 本地 HTTP 思源 API**。
2. 这不是普通 CORS 配置问题，而是 Mixed Content 硬限制。
3. 因此“网页直连思源内核”不能作为公网 HTTPS 版本的主路径。

### 4.2 设备与运行时差异

| 维度 | 桌面浏览器 | 移动浏览器 / TWA | 本地桌面壳（未来） |
|------|------|------|------|
| Hover | 支持 | 不支持 | 支持 |
| 访问扩展 Relay | 支持 | 基本不可依赖 | 不需要 |
| 访问本地思源内核 | 需 Relay | 默认不可依赖 | 可实现 |
| 推荐交互 | Hover Popover | Bottom Sheet | Hover Popover |

### 4.3 安全边界

1. 思源 token 只能保存在当前设备，不进入 Supabase。
2. 思源最小支持版本建议为 `>= 3.6.2`，推荐使用最新版。
3. 首版只允许访问块预览所需接口，不暴露通用 SQL、文件或 snippet 执行能力。

---

## 5. 用户体验设计

### 5.1 桌面端

任务卡显示一个精简锚点行：

```text
📎 思源 /产品/需求分析/任务悬浮窗方案
```

交互规则：

1. `mouseenter 300ms` 后打开预览。
2. `mouseleave 150ms` 后关闭。
3. 指针进入预览层时保持打开。
4. `Esc` 关闭。
5. 点击“打开思源”时直接拉起深链。
6. 点击“刷新”时触发重新取数并更新本地缓存。

### 5.2 移动端

移动端无 hover，因此交互改为：

1. 单击锚点：打开底部 Sheet 预览。
2. 长按锚点：弹出操作菜单。

操作菜单建议包含：

1. 预览
2. 打开思源
3. 刷新缓存
4. 解除关联

### 5.3 Focus 与 Parking Dock

在 Focus 和 Dock 中，Knowledge Anchor 必须更克制：

1. 只显示一行“思源上下文”入口。
2. 预览默认展示标题、路径、摘要，不展开大段正文。
3. 不在 Focus 中暴露块内多跳导航，避免用户掉入阅读流。
4. “打开思源”保留，以便需要时跳回原知识源。

### 5.4 多锚点策略

数据模型从第一版就按多锚点设计，但产品入口建议分两阶段：

1. **MVP 默认单锚点**：降低 UI 与排序复杂度。
2. **Phase 2 以后支持多锚点**：通过 role 区分 `context/spec/reference/evidence/next-action`。

---

## 6. 数据模型设计

建议不要把思源链接直接塞进任务 Markdown 作为唯一结构，而是单独维护外部来源层：

```text
Task
 └── ExternalSourceLink[]
      └── SiyuanBlockLink
```

### 6.1 同步模型

需要把“可跨设备共享的信息”与“仅本机持有的信息”分开：

```ts
type ExternalSourceRole =
  | 'context'
  | 'spec'
  | 'reference'
  | 'evidence'
  | 'next-action';

type ExternalSourceLink = {
  id: string;                    // crypto.randomUUID()
  taskId: string;
  sourceType: 'siyuan-block';
  targetId: string;              // 思源 block id
  uri: string;                   // siyuan://blocks/{id}?focus=1
  label?: string;                // 显示名
  hpath?: string;                // 人类可读路径
  role?: ExternalSourceRole;
  createdAt: string;
  updatedAt: string;
};

type LocalSiyuanPreviewCache = {
  linkId: string;
  plainText?: string;
  kramdown?: string;
  excerpt?: string;
  childBlocks?: Array<{ id: string; content: string; type: string }>;
  fetchedAt: string;
  sourceUpdatedAt?: string;
  fetchStatus: 'idle' | 'loading' | 'ready' | 'error';
  errorCode?:
    | 'not-configured'
    | 'runtime-not-supported'
    | 'extension-unavailable'
    | 'kernel-unreachable'
    | 'token-invalid'
    | 'block-not-found'
    | 'unknown';
};
```

### 6.2 同步与本地存储边界

**默认同步到 Supabase**：

1. `id`
2. `taskId`
3. `sourceType`
4. `targetId`
5. `uri`
6. `label`
7. `hpath`
8. `role`
9. `createdAt` / `updatedAt`

**默认仅保存在本机**：

1. 思源 `baseUrl`
2. 思源 `token`
3. 正文缓存
4. 子块缓存
5. 资源文件 URL
6. 最后错误状态

这样既维持多设备间的锚点一致，又不把知识正文和凭证带上云端。

---

## 7. 架构设计

### 7.1 建议分层

建议新增独立的外部来源层，而不是耦合进任务正文组件内部。

```text
src/app/core/external-sources/
  external-source.model.ts
  external-source-link.store.ts
  external-source-link.service.ts
  external-source-cache.service.ts

src/app/core/external-sources/siyuan/
  siyuan-link-parser.ts
  siyuan-provider.interface.ts
  siyuan-extension-provider.ts
  siyuan-direct-provider.ts
  siyuan-preview.service.ts
  siyuan-preview-cache.service.ts

src/app/shared/components/knowledge-anchor/
  knowledge-anchor.component.ts
  knowledge-anchor-popover.component.ts
  knowledge-anchor-sheet.component.ts
```

### 7.2 Provider 抽象

前端不应该把“访问思源的方式”写死为 HTTP fetch，而应该用 provider 层隔离不同运行时：

```ts
interface SiyuanPreviewProvider {
  isAvailable(): Promise<boolean>;
  getBlockPreview(blockId: string, signal?: AbortSignal): Promise<{
    hpath?: string;
    plainText?: string;
    kramdown?: string;
    sourceUpdatedAt?: string;
    childBlocks?: Array<{ id: string; content: string; type: string }>;
  }>;
}
```

Provider 对外只返回 NanoFlow 需要的预览 DTO，不向组件暴露思源原始 API 响应：

```ts
type SiyuanBlockPreview = {
  blockId: string;
  hpath?: string;
  plainText?: string;
  kramdown?: string;
  sourceUpdatedAt?: string;
  attrs?: Record<string, string>;
  childBlocks?: Array<{ id: string; type: string; subType?: string; content?: string }>;
};
```

实现约束：

1. `blockId` 必须先通过格式校验后再进入 provider。
2. provider 内部统一把思源 `{ code, msg, data }` 响应转换为 NanoFlow Result / error code。
3. `AbortSignal` 必须贯穿扩展消息和 direct fetch，避免 hover 频繁切换造成悬挂请求。
4. 组件不得知道 token、baseUrl、HTTP header 或扩展内部端口。
5. direct provider 仅允许在 `localhost` 开发环境或未来可信桌面壳中启用。

实现优先级：

1. `SiyuanExtensionProvider`：桌面浏览器主路径。
2. `SiyuanDirectProvider`：仅本地桌面壳/开发 localhost 等安全场景可用。
3. `CacheOnlyProvider`：降级路径。

### 7.3 运行时选择规则

```text
if desktop browser && extension available:
  use extension relay
else if trusted local runtime allows direct preview:
  use direct provider
else:
  use cache-only provider
```

---

## 8. Mixed Content 解决方案设计

### 8.1 为什么不把本地 bridge 作为第一优先级

如果本地 bridge 只是：

```text
http://127.0.0.1:38465/nanoflow-siyuan/preview
```

那么 NanoFlow 的 HTTPS PWA 仍然无法直接访问它，问题没有消失，只是从 `6806` 换成了另一个本地 HTTP 端口。

如果把 bridge 升级为本地 HTTPS，又会立刻引入：

1. 本地证书签发与信任安装。
2. Windows/macOS/Linux 三端证书行为差异。
3. 用户首次配置门槛上升。
4. 排障成本显著增加。

因此，本案把本地 bridge 作为**后续安全增强路径**，而不是第一阶段的主突破方式。

### 8.2 优先方案：桌面浏览器扩展 Relay

扩展承担三件事：

1. 保存当前设备的思源连接信息。
2. 代表 NanoFlow 页面访问本地思源 API。
3. 只向 NanoFlow 页面暴露受限的只读预览能力。

推荐消息模型：

```ts
type SiyuanExtensionRequest = {
  type: 'nanoflow.siyuan.get-preview';
  requestId: string;
  payload: {
    blockId: string;
    includeChildren?: boolean;
  };
};

type SiyuanExtensionResponse = {
  type: 'nanoflow.siyuan.preview-result';
  requestId: string;
  ok: boolean;
  data?: {
    blockId: string;
    hpath?: string;
    plainText?: string;
    kramdown?: string;
    sourceUpdatedAt?: string;
    attrs?: Record<string, string>;
    childBlocks?: Array<{ id: string; content: string; type: string }>;
  };
  errorCode?: string;
  errorMessage?: string;
};
```

扩展 Relay 的最小职责：

1. 在扩展本地存储中保存 `baseUrl` 与 token；NanoFlow 页面只持有扩展可用状态。
2. 对来自 NanoFlow 页面的消息做来源校验，只接受受信任的 NanoFlow origin。
3. 只实现 allowlist 中的只读接口，不提供任意 URL 代理。
4. 为每次请求设置超时和 `requestId`，超时后返回 `kernel-unreachable` 或 `unknown`。
5. 对返回的 `kramdown` 只做最小必要转换，不在扩展内注入 HTML。

扩展内部访问思源内核时统一使用：

```text
POST http://127.0.0.1:6806/api/{module}/{method}
Authorization: Token {local-token}
Content-Type: application/json
```

### 8.3 后续增强：本地 bridge / 桌面壳

当以下条件成立时，再推进本地 bridge：

1. 需要更强的 token 隔离。
2. 计划推出 NanoFlow 桌面壳或 Tauri/Electron 版本。
3. 希望提供比浏览器扩展更稳定的本机集成层。

此时 bridge 可以作为扩展后的第二跳，而不是直接暴露给网页。

---

## 9. 思源 API 使用边界

本节根据 Context7 查询到的 SiYuan API 文档补齐接口契约。思源本地内核默认监听：

```text
http://127.0.0.1:6806
```

通用约定：

1. API token 在思源 `设置 - 关于` 中获取。
2. 请求头使用 `Authorization: Token {token}`。
3. 请求体为 JSON，`Content-Type: application/json`。
4. API 响应统一为 `{ code: number, msg: string, data: unknown }`，`code === 0` 表示成功。
5. MVP 中 token 只能由扩展或可信本地运行时持有，NanoFlow 云端与 Supabase 不保存 token。

### 9.1 MVP 允许的接口

MVP 只允许访问：

| 接口 | 用途 | 请求体 | MVP 用法 |
|------|------|------|------|
| `/api/system/version` | 连接测试与版本检查 | 无 | 设置页“测试连接” |
| `/api/block/getBlockKramdown` | 读取块 Kramdown | `{ "id": blockId }` | 生成摘要与受限预览 |
| `/api/block/getChildBlocks` | 读取直接子块结构 | `{ "id": blockId }` | 展示子块列表骨架 |
| `/api/filetree/getHPathByID` | 读取人类可读路径 | `{ "id": blockId }` | 展示来源路径 |
| `/api/attr/getBlockAttrs` | 读取块属性 | `{ "id": blockId }` | 获取 `updated` 等元数据或用户自定义标记 |

#### 9.1.1 连接测试：`/api/system/version`

用于判断思源内核是否可达、token 是否有效、版本是否满足最低要求。

```http
POST /api/system/version
Authorization: Token {token}
Content-Type: application/json
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": "3.6.1"
}
```

处理规则：

1. `code !== 0` 或 HTTP 非 2xx：显示连接失败。
2. 版本低于最低支持版本：允许保存配置，但预览能力标记为 unsupported。
3. 该接口只用于本机配置校验，不进入任务同步流程。

#### 9.1.2 块正文：`/api/block/getBlockKramdown`

```http
POST /api/block/getBlockKramdown
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "id": "20260426123456-abc1234",
    "kramdown": "这里是思源块的 Kramdown 内容"
  }
}
```

MVP 处理规则：

1. `kramdown` 只进入本机缓存，不同步到 Supabase。
2. 预览默认从 `kramdown` 提取 `plainText` / `excerpt`，不直接注入 HTML。
3. 块属性尾标记、块引用、资源链接必须走安全转换链路。
4. 返回的 `data.id` 必须与请求 `blockId` 一致，否则视为异常响应。

#### 9.1.3 子块结构：`/api/block/getChildBlocks`

```http
POST /api/block/getChildBlocks
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": [
    {
      "id": "20260426123500-child1",
      "type": "h",
      "subType": "h1"
    },
    {
      "id": "20260426123600-child2",
      "type": "l",
      "subType": "u"
    }
  ]
}
```

MVP 处理规则：

1. 只读取直接子块，不递归展开整棵树。
2. 子块正文如需展示，必须对单个子块再按需调用 `getBlockKramdown`，并限制数量。
3. 默认最多展示前 `SIYUAN_PREVIEW_CONFIG.MAX_CHILD_BLOCKS = 5` 个子块摘要，避免 hover 时触发大量请求。
4. 子块列表仅用于预览，不作为任务依赖关系或 NanoFlow 树结构。

#### 9.1.4 人类可读路径：`/api/filetree/getHPathByID`

```http
POST /api/filetree/getHPathByID
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应：

```json
{
  "code": 0,
  "msg": "",
  "data": "/项目资料/产品设计/悬浮窗联动方案"
}
```

MVP 处理规则：

1. `data` 作为 `ExternalSourceLink.hpath` 候选值。
2. 路径可同步到 Supabase，因为它是轻量定位元数据，不包含正文。
3. 如果路径读取失败，仍允许创建锚点，只显示 block ID 或用户手填 label。

#### 9.1.5 块属性：`/api/attr/getBlockAttrs`

```http
POST /api/attr/getBlockAttrs
Authorization: Token {token}
Content-Type: application/json
```

请求体：

```json
{
  "id": "20260426123456-abc1234"
}
```

成功响应形态：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "id": "20260426123456-abc1234",
    "updated": "20260428094500",
    "custom-nanoflow-role": "spec"
  }
}
```

MVP 处理规则：

1. 属性只作为预览元数据读取，不在 MVP 写回。
2. `custom-*` 属性可以作为未来 opt-in 写回的兼容点，但首版不主动设置。
3. 如果存在可用更新时间字段，可映射到 `sourceUpdatedAt` 用于缓存陈旧提示。

### 9.2 MVP 禁止的接口

MVP 不开放：

1. `/api/query/sql`
2. `/api/snippet/*`
3. `/api/file/*`
4. 任意写接口（除未来可选的 `setBlockAttrs`）

### 9.3 链接接入方式

MVP 的接入入口建议保持极简：

1. 用户在思源中复制块超链接。
2. 粘贴到 NanoFlow 任务的“关联思源块”输入框。
3. NanoFlow 解析 block ID。
4. 通过 provider 验证可读性。
5. 成功后创建锚点。

支持输入：

```text
siyuan://blocks/20260426123456-abc1234
siyuan://blocks/20260426123456-abc1234?focus=1
20260426123456-abc1234
```

解析规则：

1. block ID 格式按 `YYYYMMDDHHmmss-xxxxxxx` 校验。正则为 `^\d{14}-[a-z0-9]{7}$`。后缀必须正好 7 位。每一位允许小写字母 `a-z` 或数字 `0-9`。显式不接受大写字母。有效示例：`20260426123456-abc1234`。
2. `siyuan://blocks/{id}` 只提取 path 中的 `{id}`，忽略未知 query 参数。
3. 保存时统一生成规范 URI：`siyuan://blocks/{id}?focus=1`。
4. 原始输入不得直接回显为 HTML；错误提示只展示经过转义的文本。
5. 粘贴普通文本但无法解析 block ID 时，不自动创建锚点。

### 9.4 预览取数编排

单次预览刷新建议按以下顺序执行：

```text
1. getHPathByID(blockId)
2. getBlockAttrs(blockId)
3. getBlockKramdown(blockId)
4. getChildBlocks(blockId)        // includeChildren=true 时才执行
5. 可选：对前 N 个子块按需 getBlockKramdown(childId)
```

编排约束：

1. `getHPathByID` 和 `getBlockAttrs` 失败不应阻断 `getBlockKramdown`。
2. `getBlockKramdown` 失败时预览刷新整体失败，并保留旧缓存。
3. 子块请求失败只降级为“不展示子块摘要”。
4. hover 自动刷新必须有并发去重：同一 `blockId` 同一时刻只允许一个刷新请求。
5. 初始实现必须直接使用 NanoFlow 既有 `TIMEOUT_CONFIG.QUICK`（5000ms）或扩展侧同等配置。只有基准测试证明本地内核需要不同超时时，才新增 `SIYUAN_PREVIEW_CONFIG.TIMEOUT_MS` 这类命名配置。不得新增裸超时魔数。

### 9.5 错误码映射

| 场景 | NanoFlow errorCode | 用户提示 |
|------|------|------|
| 未配置 token / baseUrl | `not-configured` | 当前设备未配置思源连接 |
| 当前运行时不能访问实时预览 | `runtime-not-supported` | 当前环境仅支持缓存预览或打开思源 |
| 浏览器扩展不可用 | `extension-unavailable` | 未检测到 NanoFlow 思源扩展 |
| 思源内核不可达或请求超时 | `kernel-unreachable` | 无法连接本机思源内核 |
| token 无效或被拒绝 | `token-invalid` | 思源授权失败，请重新配置 token |
| 块不存在或无权限读取 | `block-not-found` | 未找到该思源块 |
| API 响应结构不符合预期 | `unknown` | 预览失败，可稍后重试 |

错误处理要求：

1. 所有错误都必须可降级，不阻塞任务编辑、Focus 或 Dock。
2. 日志不得输出 token、完整正文或未脱敏的 API 响应体。
3. UI 上优先展示可操作建议，例如“打开思源”“重新配置”“仅使用缓存”。

---

## 10. 预览与渲染策略

### 10.1 首版渲染原则

思源返回的是 Kramdown，不应在首版直接按完整 HTML 嵌入。首版建议采用**摘要优先、保守渲染**：

1. 优先产出 `plainText` 摘要。
2. 如果存在安全可控的 Kramdown 转换，再展示有限 Markdown。
3. 继续复用 NanoFlow 现有 Markdown 安全渲染链路。
4. 保留 DOMPurify 等现有 XSS 防护。

### 10.2 首版转换范围

1. 删除块属性尾标记，例如 `{: id="..."}`。
2. 把块引用 `((blockId "文本"))` 转成可点击深链。
3. 子块优先以结构化列表展示，而不是完整富文本。
4. 图片和资源文件首版只显示占位，不做代理加载。

### 10.3 缓存策略

悬浮预览遵循：

```text
先显示本地缓存
后台尝试拉取最新预览
成功后局部更新
失败则保留旧缓存并提示状态
```

缓存策略建议：

1. 默认仅当前设备保存缓存。
2. 缓存包含抓取时间与源块更新时间。
3. 支持手动刷新。
4. 后续在桌面扩展路径可选接入事件通知或轮询失效检查。

---

## 11. 状态设计

Knowledge Anchor 至少要覆盖以下状态：

| 状态 | 展示 | 用户操作 |
|------|------|------|
| 已关联，缓存可用，内核可连 | 直接展示缓存并后台刷新 | 打开思源 / 刷新 / 解除关联 |
| 已关联，缓存可用，内核不可连 | 展示缓存 + “当前设备未连接思源” | 打开思源 / 配置连接 |
| 已关联，无缓存，扩展未安装 | 显示“未安装扩展，无法实时预览” | 安装扩展 / 打开思源 |
| 已关联，无缓存，token 无效 | 显示鉴权错误 | 重新配置 |
| 已关联，块不存在 | 显示失效锚点状态 | 打开思源 / 解除关联 |
| 未配置思源 | 只保留深链与说明 | 配置连接 |

### 11.1 Focus 降噪规则

在 Focus 模式下：

1. 不自动展开大段正文。
2. 不展示块内多层跳转。
3. 优先展示摘要与“打开思源”。
4. 所有额外交互都必须少于普通任务卡。

---

## 12. 本地配置设计

思源连接配置必须按设备本地保存，不进入云端同步。

建议配置项：

```text
siyuan.runtimeMode = extension-relay | direct | cache-only
siyuan.baseUrl = http://127.0.0.1:6806
siyuan.token = local-only secret
siyuan.previewStrategy = excerpt-first
siyuan.autoRefresh = on-hover | manual
```

建议实现时把预览数量与摘要长度限制集中为命名配置；超时初始阶段直接使用 `TIMEOUT_CONFIG.QUICK`：

```ts
const SIYUAN_PREVIEW_CONFIG = {
  MAX_CHILD_BLOCKS: 5,
  MAX_EXCERPT_CHARS: 500,
} as const;
```

如后续基准测试证明思源本地内核需要独立超时，再新增 `SIYUAN_PREVIEW_CONFIG.TIMEOUT_MS`。代码应引用既有 `TIMEOUT_CONFIG` 或新的具名毫秒常量。不得复制裸数值。

建议在设置页增加：

1. 连接方式说明。
2. 扩展安装提示。
3. 测试连接。
4. 清除本机缓存。
5. 关闭实时预览，仅保留深链。

---

## 13. 实施路线图

### Phase 0：锚点绑定与深链回跳

目标：先让任务“挂得上、点得开”。

交付：

1. 设置页增加 SiYuan 集成说明与本机配置入口。
2. 支持解析 `siyuan://blocks/{id}`。
3. 任务卡新增“关联思源块”。
4. 任务卡展示锚点行。
5. 点击可打开思源原块。

验收：

1. 粘贴思源块链接后可正确解析 block ID。
2. 任务卡显示锚点。
3. 点击可拉起 `siyuan://blocks/{id}?focus=1`。

### Phase 1：预览模型与缓存框架

目标：完成预览数据结构、缓存层和状态 UI，但不强依赖公网 HTTPS 实时取数。

交付：

1. 外部来源数据模型。
2. 本地预览缓存。
3. 桌面 Popover / 移动端 Bottom Sheet。
4. loading / error / disconnected / cache-only 状态。
5. 保守渲染链路。

验收：

1. 有缓存时可立即展示。
2. 无缓存时能显示正确状态，不阻塞任务操作。
3. Focus / Dock 中为缩减版预览。

### Phase 2：桌面浏览器扩展 Relay

目标：让公网 HTTPS PWA 在桌面浏览器中获得实时预览能力。

交付：

1. NanoFlow 扩展 Relay。
2. 扩展内思源连接配置与测试连接。
3. 前端 provider 接入扩展通道。
4. 只读 allowlist API 访问。

验收：

1. HTTPS NanoFlow 页面可通过扩展读取思源块预览。
2. 未安装扩展时自动降级，不报致命错误。
3. token 不进入 NanoFlow 应用存储。

### Phase 3：移动端 / Focus / Dock 完整适配

目标：确保多端与专注场景不被打断。

交付：

1. 移动端底部 Sheet 与长按菜单。
2. Focus / Dock 的最小干扰展示。
3. 多锚点 UI（可选）。
4. 缓存陈旧提示与手动刷新优化。

验收：

1. 手机端无需 hover 也能完成查看与跳转。
2. Focus 模式不被知识预览抢走注意力。
3. Dock 任务可快速查看来源上下文。

### Phase 4：安全增强与可选写回

目标：在主路径稳定后，再处理更重的系统能力。

交付：

1. 可选本地 bridge / 桌面壳集成。
2. 可选 `setBlockAttrs` 反向写回。
3. 可选同步更丰富的摘要快照开关。

验收：

1. 写回能力必须显式 opt-in。
2. 所有写回都可关闭并可回滚。
3. 没有 bridge 的环境依然可工作。

---

## 14. 验证方式

### 14.1 功能验收

1. 任务可以绑定一个思源块并显示锚点。
2. 桌面端可以悬浮查看预览，移动端可以点击查看预览。
3. 点击“打开思源”可回到原块。
4. 思源不可达时，任务工作流仍可继续。
5. 粘贴非法文本、错误 URI、非思源 block ID 时不会创建锚点。
6. 预览刷新失败时保留旧缓存并显示可恢复状态。

### 14.2 架构验收

1. 思源 token 不进入 Supabase。
2. 预览缓存默认不进入 Supabase。
3. 外部来源层不直接耦合任务 Markdown 内容。
4. Provider 抽象可以区分 extension/direct/cache-only 三种模式。

### 14.3 安全验收

1. 首版不暴露通用 SQL 或文件接口。
2. 不允许从 NanoFlow 页面直接访问本地 HTTP 思源内核作为公网主路径。
3. 只在安全运行时中启用实时预览。
4. token 只存在扩展或可信本地运行时，不进入 Supabase、IndexedDB 预览缓存或日志。
5. 扩展 Relay 只接受受信任 NanoFlow origin，并只代理 allowlist 接口。
6. Kramdown 转换后的展示内容必须经过 NanoFlow 现有 XSS 防护链路。

### 14.4 API 合约验收

使用本机思源内核和测试块验证：

1. `/api/system/version` 可返回版本字符串，并能识别 token 错误。
2. `/api/filetree/getHPathByID` 返回可读路径；失败时 UI 可退回 label / block ID。
3. `/api/block/getBlockKramdown` 返回的 `data.id` 与请求 block ID 一致。
4. `/api/block/getChildBlocks` 只展示有限数量子块，不递归拉取整棵树。
5. `/api/attr/getBlockAttrs` 失败不影响正文预览。
6. 所有 `code !== 0` 的响应都能映射为稳定的 NanoFlow errorCode。

---

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 用户未安装扩展 | 无法实时预览 | 保留 cache-only 降级路径 |
| 思源 token 失效 | 预览失败 | 明确状态提示 + 测试连接 |
| Kramdown 复杂语法过多 | 渲染混乱 | 首版摘要优先，保守渲染 |
| Focus 场景被知识预览打断 | 影响专注 | Focus 中收缩预览能力 |
| 误把正文同步进云端 | 产品语义漂移 | 本机缓存与云端指针分层 |
| 以后支持多来源时模型耦合 | 扩展困难 | 从首版就采用 ExternalSourceLink 抽象 |
| 扩展被滥用为任意本地 API 代理 | 安全风险 | origin 校验 + allowlist + 禁止任意 URL |
| 子块过多导致 hover 卡顿 | 体验下降 | 限制子块数量 + 请求去重 + 超时取消 |
| 思源 API 响应结构变化 | 预览失败 | provider 层运行时校验 + errorCode 降级 |

---

## 16. 回滚策略

如果实时预览链路出现问题，可以按层级降级：

1. 关闭扩展 Relay，只保留深链打开。
2. 关闭缓存刷新，只展示已缓存摘要。
3. 关闭锚点预览 UI，只保留锚点标签与跳转按钮。

该能力的最小可退化形态应始终是：

```text
任务卡显示一个思源锚点
点击后跳转回思源原块
```

即使所有预览能力都被关闭，任务与知识源之间的指针关系仍然成立。

---

## 17. 最小产品定义

第一版只做以下 6 项：

1. 任务关联一个思源块链接。
2. 任务卡显示思源锚点。
3. 桌面端有原生 Popover，移动端有 Bottom Sheet。
4. 预览层展示路径、摘要、打开思源按钮。
5. 本地缓存预览，思源不可达时优先展示缓存。
6. token 与缓存只保存在当前设备。

第一版明确不做：

1. 全库搜索思源块。
2. 全量同步正文。
3. 在 NanoFlow 内编辑思源块。
4. iframe 嵌入思源 UI。
5. 默认写回思源属性。

---

## 18. 一句话结论

> **把思源当知识源头，把 NanoFlow 当执行界面；任务只挂一个或多个思源锚点，NanoFlow 自己做安全预览，用户需要深入时再跳回思源原块。对于 HTTPS PWA 的 Mixed Content 障碍，首选桌面浏览器扩展 Relay，而不是先做本地 HTTP bridge。**
