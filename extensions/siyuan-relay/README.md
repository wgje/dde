# NanoFlow SiYuan Relay

这是 Knowledge Anchor 的桌面浏览器扩展 Relay 最小实现，用于在 HTTPS PWA 中安全读取本机思源内核的只读块预览。

## 安全边界

- token 按 NanoFlow owner 分桶保存在扩展 `chrome.storage.local`，background 只读取与请求中 captured owner 匹配的记录。
- v0.3 owner-bound 操作使用 `nanoflow.siyuan.v3.*` 消息；旧 content-script 不会把这些请求转发到 background。
- 页面 → 扩展消息携带 owner 标识；旧版全局 `baseUrl/token` 不会猜测归属或自动迁移，只会 fail-closed，并可在 Options 页清除。
- 用户在 NanoFlow 设置页填写 baseUrl / token 后，浏览器通过 content-script 把字段写入当前 owner 的扩展记录，**扩展不会回传 token 明文**（`get-config-status` 仅返回 `{ baseUrl, hasToken }`）；NanoFlow 页面端**不**把 token 持久化到 IndexedDB 或上传到云端。
- content script 只在 NanoFlow 正式域名和托管预览域名注入（含 `https://www.nanoflow.app`）；发布 manifest 与运行时 allowlist 保持一致。
- 发布扩展明确不信任 `localhost` 或 `127.0.0.1` 页面，不会在本地开发页面注入或转发请求。
- background 只允许访问策划案中列出的只读接口：
  - `/api/system/version`
  - `/api/block/getBlockKramdown`
  - `/api/block/getChildBlocks`
  - `/api/filetree/getHPathByID`
  - `/api/filetree/getHPathByPath`
  - `/api/filetree/getPathByID`
  - `/api/attr/getBlockAttrs`
- 不提供通用 URL 代理、SQL、文件、snippet 或写接口。

## 本地安装验证

1. 打开 Chrome/Edge 扩展管理页并启用开发者模式。
2. 选择"加载已解压的扩展"，目录必须选择包含 `manifest.json` 的扩展根目录：
   - 从仓库源码安装：选择 `extensions/siyuan-relay`。
   - 从 GitHub 下载 ZIP 后安装：先完整解压仓库，再选择 `dde-main/extensions/siyuan-relay`（或对应分支名的同级目录）。
   - 如果你把扩展复制到桌面或其他目录时，请确认被选中的 `siyuan-relay` 目录内同时存在 `manifest.json` 和 `src/`（Windows 示例：`C:\Users\你的用户名\Desktop\siyuan-relay\manifest.json`）；不要选择仓库根目录、`src` 子目录，或只从 GitHub 页面单独保存下来的空目录。
3. 打开 NanoFlow，设置页选择"浏览器扩展 Relay（推荐）"，在"本机 Token"输入框填写思源 API Token，点击**保存到扩展**。
4. 点击"测试连接"验证。
5. 扩展 Options 页只用于检测并清除旧版未绑定账号的授权，不再允许创建全局凭据。

## 排障速查

- 扩展灰色 ≠ 一定故障：MV3 图标可能保持灰色，请以 NanoFlow 设置页"测试连接"结果为准。
- Chrome/Edge 提示"清单文件缺失或不可读取 / Manifest file is missing or unreadable"时，说明当前选择的目录根部没有可读取的 `manifest.json`；重新选择上面第 2 步的扩展根目录即可。
- 若提示"扩展未安装或未注入当前页面"，请确认当前页面 origin 属于上述注入范围，并刷新页面后重试。
- 若提示"扩展未安装或版本过旧"，说明扩展不支持 owner-bound 配置与响应协议，请升级到 v0.3.0 及以上。
- 若提示"未配置 token"，请在 NanoFlow 设置页为当前账号填写并点击"保存到扩展"。
- 若提示"未连接到思源"，请确认思源内核已启动且可访问 `http://127.0.0.1:6806`。

## 扩展版本与页面兼容性

- 不支持 owner-bound 消息响应的旧扩展会 fail-closed；必须升级扩展并在 NanoFlow 设置页为当前账号重新授权。
- 新扩展（>= v0.3.0）+ 旧页面：旧页面不携带 owner，preview/test/config 请求会 fail-closed；页面与扩展必须一起升级。

## 回滚

如 Relay 异常，可在 NanoFlow 设置页切换到"仅缓存与深链"，任务锚点仍会显示并可通过 `siyuan://blocks/{id}?focus=1` 打开原块。
