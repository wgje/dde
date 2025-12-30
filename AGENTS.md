# NanoFlow — Global Agent Instructions

## 核心哲学（不要造轮子）
- 同步：Supabase
- ID：客户端 crypto.randomUUID()
- 离线：PWA + IndexedDB
- 监控：Sentry

## 绝对规则（Hard Rules）
1) **ID 策略**
- 所有实体 id 必须由客户端 `crypto.randomUUID()` 生成
- 禁止：数据库自增 ID、临时 ID、同步时做 ID 转换

2) **数据流与同步（Offline-first）**
- 读：IndexedDB → 后台增量拉取（updated_at > last_sync_time）
- 写：本地写入 + UI 立即更新 → 后台推送（防抖 3s）→ 失败进入 RetryQueue
- 冲突：LWW（Last-Write-Wins）
- 目标体验：点击立即生效、无 loading 转圈；断网写入不丢，联网自动补同步

3) **移动端 GoJS**
- 手机默认 Text 视图；Flow 图按需懒加载（@defer）
- 禁止 `visibility:hidden`：必须完全销毁/重建 GoJS

4) **树遍历**
- 一律用迭代算法 + 深度限制（MAX_SUBTREE_DEPTH = 100）

## 状态管理（Angular Signals）
- tasksMap: Map<string, Task>（O(1) 查找）
- tasksByProject: Map<string, Set<string>>（按项目索引）
- 保持扁平，避免深层嵌套结构

## 错误处理（Result Pattern + Sentry）
- 用 Result 类型，避免 try/catch 地狱
- 网络错误：静默（入队重试）
- 业务错误：Toast
- Supabase 错误统一转换：supabaseErrorToError(error)

## 全局错误分级（GlobalErrorHandler）
- SILENT：仅日志（例：ResizeObserver）
- NOTIFY：Toast（例：保存失败）
- RECOVERABLE：恢复对话框（例：同步冲突）
- FATAL：错误页（例：Store 初始化失败）

## 目录结构（必须遵守）
- src/app/core/：核心单例（SimpleSyncService, stores.ts）
- src/app/features/：业务组件（Flow, Text）
- src/app/shared/：共享组件/模态框
- src/services/：主服务层（大量服务）
- src/config/：配置常量（按职责拆分）
- src/utils/：工具函数（result.ts, supabase-error.ts）

## 关键配置（保持一致，不随意改语义）
- SYNC_CONFIG.DEBOUNCE_DELAY = 3000ms
- SYNC_CONFIG.CLOUD_LOAD_TIMEOUT = 30000ms
- REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT = 4
- TIMEOUT_CONFIG.STANDARD = 10000ms
- FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100
- AUTH_CONFIG.LOCAL_MODE_USER_ID = 'local-user'
