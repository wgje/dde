# NanoFlow SiYuan Relay

这是 Knowledge Anchor 的桌面浏览器扩展 Relay 最小实现，用于在 HTTPS PWA 中安全读取本机思源内核的只读块预览。

## 安全边界

- token 只保存在扩展 `chrome.storage.local`，不会写入 NanoFlow、Supabase 或预览缓存。
- content script 只在 NanoFlow 正式域名、本地开发域名和预览域名注入。
- background 只允许访问策划案中列出的只读接口：
  - `/api/system/version`
  - `/api/block/getBlockKramdown`
  - `/api/block/getChildBlocks`
  - `/api/filetree/getHPathByID`
  - `/api/attr/getBlockAttrs`
- 不提供通用 URL 代理、SQL、文件、snippet 或写接口。

## 本地安装验证

1. 打开 Chrome/Edge 扩展管理页并启用开发者模式。
2. 选择“加载已解压的扩展”，目录选择 `extensions/siyuan-relay`。
3. 在扩展选项页保存思源本地地址和 token。
4. 打开 NanoFlow，设置页选择“浏览器扩展 Relay（推荐）”，点击“测试连接”。

## 回滚

如 Relay 异常，可在 NanoFlow 设置页切换到“仅缓存与深链”，任务锚点仍会显示并可通过 `siyuan://blocks/{id}?focus=1` 打开原块。
