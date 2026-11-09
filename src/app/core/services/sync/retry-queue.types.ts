import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import type {
  RetryQueueSupersessionReservation,
  TaskDeleteBaseUpdatedAtMap,
} from '../../../../services/action-queue.types';
import type { Task, Project, Connection, BlackBoxEntry } from '../../../../models';

export type { TaskDeleteBaseUpdatedAtMap } from '../../../../services/action-queue.types';

export interface RetryTaskDeleteData {
  id: string;
  baseUpdatedAt?: string | null;
}

/**
 * 可重试的实体类型
 */
export type RetryableEntityType = 'task' | 'project' | 'connection' | 'blackbox';

/**
 * 可重试的操作类型
 */
export type RetryableOperation = 'upsert' | 'delete';

export type RetryQueueRemoteOutcome = 'unknown';

/**
 * unknown-outcome 项重放前对账的判定结果：
 * - `settled`：服务端已包含本次写（LWW 视角下无需重放），按成功结算并推进；
 * - `replay`：服务端未包含本次写，按正常路径重放一次；
 * - `unknown`：对账查询失败或时钟不可靠，保持结果未知状态等待下一轮（不消耗 retryCount）。
 */
export type RetryQueueUnknownOutcomeReconcileResult = 'settled' | 'replay' | 'unknown';

export interface RetryQueueLastFailure {
  errorType: string;
  message: string;
  recordedAt: number;
  remoteOutcome?: RetryQueueRemoteOutcome;
}

/**
 * 重试队列项
 */
export interface RetryQueueItem {
  /** 唯一标识符 */
  id: string;
  /** 实体类型 */
  type: RetryableEntityType;
  /** 操作类型 */
  operation: RetryableOperation;
  /** 实体数据 */
  data: Task | Project | Connection | BlackBoxEntry | RetryTaskDeleteData;
  /** 关联的项目 ID */
  projectId?: string;
  /** 重试次数 */
  retryCount: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 来源用户，用于跨账号 replay 隔离 */
  sourceUserId?: string;
  /** 原始业务操作幂等键，失败后重放必须沿用同一个 operationId */
  operationId: string;
  /** project 级快照重放时需要继续保留的删除意图 */
  taskIdsToDelete?: string[];
  /** project 级重放时 task delete 的 CAS 基线 */
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  /** task upsert 重放时保留原始写入意图，避免失败后退化为 full upsert */
  writeIntent?: TaskWriteIntent;
  /** 最近一次入队失败上下文，用于区分 timeout 等远端结果未知写入。 */
  lastFailure?: RetryQueueLastFailure;
  /** Unsettled ownership transfer to a newer durable ActionQueue action. */
  actionQueueSupersessions?: RetryQueueSupersessionReservation[];
}

export type PersistedRetryQueueItem = Omit<RetryQueueItem, 'operationId'> & {
  /** 兼容旧持久化数据；加载后必须补齐为 RetryQueueItem.operationId */
  operationId?: string;
};
export type RetryQueueData = Task | Project | Connection | BlackBoxEntry | RetryTaskDeleteData;
export type RetryQueuePersistMode = 'debounced' | 'manual';
export type RetryQueueProjectPendingWriteState = 'pending' | 'clear' | 'unknown';
export type RetryQueueStorageLoadToken = {
  ownerUserId: string;
  queueStateGeneration: number;
  lifecycleClosed: boolean;
};
export type DbInitFinalize = (db: IDBDatabase | null) => void;

export interface RetryQueueAddRequest {
  type: RetryableEntityType;
  operation: RetryableOperation;
  data: RetryQueueData;
  projectId: string | undefined;
  sourceUserId: string | undefined;
  taskIdsToDelete: string[] | undefined;
  taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined;
  writeIntent: TaskWriteIntent | undefined;
  operationId: string | undefined;
  lastFailure: RetryQueueLastFailure | undefined;
  persistMode: RetryQueuePersistMode;
}

export interface RetryQueueAddTarget {
  targetQueue: RetryQueueItem[];
  targetOwnerUserId: string;
}

export interface RefreshedRetryQueueItemDraft {
  item: RetryQueueItem;
  safeData: RetryQueueData;
  sourceUserId: string;
  taskIdsToDelete: string[] | undefined;
  taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined;
  operationId: string;
}

export interface RetryQueueCapacityDiagnostics {
  currentSize: number;
  maxSize: number;
  percentUsed: number;
  typeBreakdown: Record<string, number>;
}

export interface LegacyRetryReviewItem {
  item: RetryQueueItem;
  reason: string;
  quarantinedAt: string;
  ownerUserId: string;
}

/**
 * 重试操作处理器接口
 * 由 SimpleSyncService 实现，提供实际的推送方法
 */
export interface RetryOperationHandler {
  pushTask(
    task: Task,
    projectId: string,
    sourceUserId?: string,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<boolean>;
  deleteTask(
    taskId: string,
    projectId: string,
    sourceUserId?: string,
    fromRetryQueue?: boolean,
    baseUpdatedAt?: string | null,
    operationId?: string,
  ): Promise<boolean>;
  pushProject(
    project: Project,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<boolean>;
  pushConnection(connection: Connection, projectId: string, sourceUserId?: string, operationId?: string): Promise<boolean>;
  /** 推送黑匣子条目到服务器（专注模式数据同步） */
  pushBlackBoxEntry?(entry: BlackBoxEntry, sourceUserId?: string, operationId?: string): Promise<boolean>;
  /**
   * unknown-outcome（timeout/abort 后服务端结果未知）项重放前对账：
   * 判定服务端是否已包含该队列项承载的写入。缺省实现视为 `replay`（保持旧行为）。
   */
  reconcileUnknownOutcome?(item: RetryQueueItem): Promise<RetryQueueUnknownOutcomeReconcileResult>;
  isSessionExpired(): boolean;
  isOnline(): boolean;
  onProcessingStateChange(processing: boolean, pendingCount: number): void;
}

export interface RetryQueueSliceOptions {
  maxItems?: number;
  maxDurationMs?: number;
  /**
   * 【根因修复 2026-04-22】用户手动触发（例如点 "立即同步"）的回放必须穿透
   * isBrowserNetworkSuspendedWindow() 的 1500ms grace：用户已经明确在前台交互，
   * 无需再用 tab 隐藏/刚恢复的风险规避去屏蔽这次尝试。
   */
  allowWhileSuspended?: boolean;
  /** 内部标记：是否已为超时强制恢复重试，防止无限递归 */
  _forcedRecovery?: boolean;
}

export interface RetryQueueSliceResult {
  processed: number;
  remaining: number;
  durationMs: number;
  completed: boolean;
}

export interface NormalizedQueueSliceOperationIds {
  itemsSnapshot: RetryQueueItem[];
  changed: boolean;
}

export interface RetryQueueSliceRuntime {
  options: RetryQueueSliceOptions;
  startedAt: number;
  generation: number;
  initialQueueLength: number;
  itemsSnapshot: RetryQueueItem[];
  maxItems: number;
  maxDurationMs: number;
  operationHandler: RetryOperationHandler;
  leaseHandle: LeaseHandle | null;
  hasNotifiedSyncStart: boolean;
  successfulReplayCount: number;
  hadTerminalRemoval: boolean;
  stoppedByBudget: boolean;
  drainCompletedBySuccessfulReplay: boolean;
  expiredIds: Set<string>;
  processedIds: Set<string>;
  exceededCount: number;
  processedCount: number;
}

export type RetryQueueItemProcessResult = 'continue' | 'break';

export const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';
export const SYNC_WRITER_LEASE_PROJECT_SCOPE = '__global__';
export const SYNC_WRITER_LEASE_WAIT_MS = 5_000;
