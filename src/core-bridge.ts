/**
 * Core Bridge - 核心层桥接
 *
 * 解决 src/services/ 层无法直接引用 src/app/core/ 层的架构限制。
 * 所有 src/services/ 需要使用的 core 层导出，统一从此文件导入。
 *
 * 规则：
 * - 仅放「被 src/services/ 实际依赖」的符号
 * - 不要放仅 app/core 内部使用的符号
 * - 新增导出时请附注使用方
 */

// SimpleSyncService — 被 9 个 services 使用
export { SimpleSyncService } from './app/core/services/simple-sync.service';

// RetryQueueService — 被 sync-coordinator 使用
export { RetryQueueService } from './app/core/services/sync/retry-queue.service';

// IndexedDB — 被 indexeddb-health 使用
export { IndexedDBService, DB_CONFIG } from './app/core/state/persistence/indexeddb.service';

// Stores — 被 project-state 使用
export { TaskStore, ProjectStore, ConnectionStore } from './app/core/state/stores';
