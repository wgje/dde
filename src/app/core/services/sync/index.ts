/**
 * Sync Services - 同步服务模块
 * 
 * Sprint 3-7 技术债务修复：从 SimpleSyncService 拆分的专注服务
 * 
 * 服务列表：
 * - SyncStateService: 同步状态管理
 * - TombstoneService: 墓碑（软删除标记）管理
 * - RetryQueueService: 重试队列管理
 * - TaskSyncService: 任务同步操作
 * - ProjectSyncService: 项目同步操作
 * - ConnectionSyncService: 连接同步操作
 */

// 状态管理
export { SyncStateService } from './sync-state.service';
export type { SyncState, ConflictData } from './sync-state.service';

// 墓碑管理
export { TombstoneService } from './tombstone.service';

// 重试队列
export { RetryQueueService } from './retry-queue.service';
export type { RetryQueueItem } from './retry-queue.service';

// 任务同步
export { TaskSyncService } from './task-sync.service';

// 项目同步
export { ProjectSyncService } from './project-sync.service';

// 连接同步
export { ConnectionSyncService } from './connection-sync.service';
