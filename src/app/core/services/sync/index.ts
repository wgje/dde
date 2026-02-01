/**
 * Sync Services - 同步服务模块
 * 
 * Sprint 3-9 技术债务修复：从 SimpleSyncService 拆分的专注服务
 * 
 * 服务列表：
 * - SyncStateService: 同步状态管理
 * - TombstoneService: 墓碑（软删除标记）管理
 * - RetryQueueService: 重试队列管理
 * - TaskSyncService: 任务同步操作
 * - ProjectSyncService: 项目同步操作
 * - ConnectionSyncService: 连接同步操作
 * - RealtimePollingService: 实时订阅与轮询管理 (Sprint 9)
 * - SessionManagerService: 会话管理 (Sprint 9)
 */

// 状态管理
export { SyncStateService } from './sync-state.service';
export type { SyncState, ConflictData } from './sync-state.service';

// 墓碑管理
export { TombstoneService } from './tombstone.service';

// 重试队列
export { RetryQueueService } from './retry-queue.service';
export type { RetryQueueItem, RetryableEntityType, RetryableOperation } from './retry-queue.service';

// 任务同步
export { TaskSyncService } from './task-sync.service';

// 项目同步
export { ProjectSyncService } from './project-sync.service';

// 连接同步
export { ConnectionSyncService } from './connection-sync.service';

// 实时订阅与轮询 (Sprint 9)
export { RealtimePollingService } from './realtime-polling.service';
export type { RemoteChangeCallback, UserPreferencesChangeCallback } from './realtime-polling.service';

// 会话管理 (Sprint 9)
export { SessionManagerService } from './session-manager.service';

// 同步操作辅助 (Sprint 9)
export { SyncOperationHelperService } from './sync-operation-helper.service';
export type { SyncOperationContext, SyncOperationOptions, SyncOperationResult } from './sync-operation-helper.service';
