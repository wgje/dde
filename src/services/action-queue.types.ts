/**
 * 操作队列类型定义
 * 
 * 从 action-queue.service.ts 提取的类型定义
 */
import { Attachment, Connection, Project, Task, UserPreferences } from '../models';
import {
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../models/parking-dock';
import type { TaskWriteIntent } from './sync-rpc-client.service';

export type TaskDeleteBaseUpdatedAtMap = Record<string, string | null | undefined>;

/**
 * 操作重要性级别
 * Level 1: 日志/埋点类 - 失败后 FIFO 丢弃，无提示
 * Level 2: 重要但可补救的数据 - 失败进入死信队列，有容量和清理策略
 * Level 3: 关键操作 - 失败次数超阈值触发用户提示
 */
export type OperationPriority = 'low' | 'normal' | 'critical';

export type OutboxSyncState =
  | 'local_committed'
  | 'held'
  | 'pending_sync'
  | 'syncing'
  | 'retry_scheduled'
  | 'synced'
  | 'conflict_detected'
  | 'conflict_saved'
  | 'dead_letter'
  | 'blocked_by_auth'
  | 'blocked_by_protocol'
  | 'storage_frozen';

export type ProjectConflictLocalHandoffState =
  | 'required'
  | 'reserved'
  | 'effects-applied'
  | 'complete';

export interface ProjectConflictLocalHandoff {
  kind: 'resolved-project-conflict';
  state: ProjectConflictLocalHandoffState;
  ownerUserId: string;
  projectId: string;
  actionId: string;
  operationId: string;
  payloadDigest: string;
  conflictFingerprint: string;
  reservationId?: string;
  reservedAt?: string;
  effectsAppliedAt?: string;
  completedAt?: string;
  removalAuthorization?: {
    kind: 'dead-letter';
    actionId: string;
    operationId: string;
    authorizedAt: string;
  };
}

export type RetryQueueSupersessionEntityType = 'project' | 'task' | 'connection';

export interface RetryQueueSupersessionItemIdentity {
  id: string;
  operationId: string;
}

export interface RetryQueueSupersessionReservation {
  token: string;
  ownerUserId: string;
  entityType: RetryQueueSupersessionEntityType;
  entityId: string;
  actionId: string;
  actionOperationId: string;
  retryItems: RetryQueueSupersessionItemIdentity[];
}

/**
 * 操作有效载荷类型
 * 根据实体类型和操作类型定义具体的载荷结构
 */
export type ActionPayload = 
  | ProjectPayload
  | ProjectDeletePayload
  | ConnectionPayload
  | TaskPayload
  | TaskDeletePayload
  | AttachmentUploadPayload
  | PreferencePayload
  | FocusSessionPayload
  | RoutineTaskPayload
  | RoutineCompletionPayload;

export interface ProjectPayload {
  project: Project;
  sourceUserId?: string;
  taskIdsToDelete?: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  conflictHandoff?: {
    conflictRecord: import('./conflict-storage.helpers').ConflictRecord;
  };
}

export interface ProjectDeletePayload {
  projectId: string;
  userId: string;
  sourceUserId?: string;
  /** 删除意图创建时确认的远端项目版本；必须跨刷新和重放保持不变。 */
  baseUpdatedAt?: string | null;
}

export interface ConnectionPayload {
  connection: Connection;
  projectId: string;
  sourceUserId?: string;
}

export interface TaskPayload {
  task: Task;
  projectId: string;
  sourceUserId?: string;
  writeIntent?: TaskWriteIntent;
}

export interface TaskDeletePayload {
  taskId: string;
  projectId: string;
  sourceUserId?: string;
  baseUpdatedAt?: string | null;
}

export interface AttachmentUploadPayload {
  attachment: Attachment;
  blobKey: string;
  fileName: string;
  mimeType: string;
  projectId: string;
  taskId: string;
  userId: string;
  sourceUserId?: string;
}

export interface PreferencePayload {
  preferences: Partial<UserPreferences>;
  userId: string;
  sourceUserId?: string;
  /** 上次确认的 user_preferences.updated_at；同一 operationId 下不得改写。 */
  baseUpdatedAt?: string | null;
}

export interface FocusSessionPayload {
  record: FocusSessionRecord;
  sourceUserId?: string;
}

export interface RoutineTaskPayload {
  userId: string;
  routineTask: RoutineTask;
  sourceUserId?: string;
}

export interface RoutineCompletionPayload {
  completion: RoutineCompletionMutation;
  sourceUserId?: string;
}

/**
 * 操作队列项
 */
export interface QueuedAction<T extends ActionPayload = ActionPayload> {
  id: string;
  operationId: string;
  type: 'create' | 'update' | 'delete';
  entityType: 'project' | 'task' | 'connection' | 'attachment' | 'preference' | 'focus-session' | 'routine-task' | 'routine-completion';
  entityId: string;
  payload: T;
  timestamp: number;
  localCommittedAt?: number;
  syncState?: OutboxSyncState;
  localHandoff?: ProjectConflictLocalHandoff;
  retryQueueSupersessions?: RetryQueueSupersessionReservation[];
  retryCount: number;
  lastError?: string;
  /** 错误类型：network=网络错误可重试，business=业务错误不可重试，permission=权限错误，timeout=超时，unknown=未知错误 */
  errorType?: 'network' | 'business' | 'permission' | 'timeout' | 'unknown' | 'deferred';
  /** 操作优先级：决定失败后的处理策略 */
  priority?: OperationPriority;
}

export interface QueueBackupPersonalRestoreTransition {
  schemaVersion: 1;
  state: 'prepared';
  ownerUserId: string;
  token: string;
  preimage: QueuedAction[];
  preimageDigest: string;
  restoredActions: QueuedAction[];
  restoredDigest: string;
  preparedActionsDigest: string;
  preparedAt: string;
}

export interface QueueBackupPersonalRestoreReceipt {
  id: string;
  kind: 'queue-backup-personal-restore-receipt';
  schemaVersion: 1;
  ownerUserId: string;
  token: string;
  outcome: 'finalized' | 'rolled-back';
  preimageDigest: string;
  restoredDigest: string;
  preparedActionsDigest: string;
  resultDigest: string;
  completedAt: string;
}

export type QueueBackupPersonalRestoreCommand =
  | {
    kind: 'prepare';
    token: string;
    expectedActions: QueuedAction[];
    restoredActions: QueuedAction[];
  }
  | { kind: 'finalize' | 'rollback'; token: string };

export type QueueBackupPersonalRestoreResult =
  | { status: 'prepared' | 'already-prepared' }
  | { status: 'finalized' | 'already-finalized' }
  | { status: 'rolled-back' | 'already-rolled-back' }
  | { status: 'storage-failed' }
  | {
    status: 'rejected';
    reason: 'identity-mismatch' | 'identity-conflict' | 'not-prepared'
      | 'transition-conflict' | 'terminal-conflict' | 'malformed-record';
  };

export interface QueueBackupPersonalRestoreIdentityInputV2 {
  ownerUserId: string;
  restoreRunId: string;
  participant: 'action-queue';
  sourceDigest: string;
  token: string;
}

export interface QueueBackupPersonalRestoreIdentityV2
  extends QueueBackupPersonalRestoreIdentityInputV2 {
  recordId: string;
  identityDigest: string;
  receiptId: string;
}

export type QueueBackupPersonalRestoreAbsenceProof = object;

interface QueueBackupPersonalRestoreReceiptCommonV2
  extends QueueBackupPersonalRestoreIdentityV2 {
  kind: 'queue-backup-personal-restore-receipt';
  schemaVersion: 2;
  id: string;
}

export interface QueueBackupPersonalRestorePreparedReceiptV2
  extends QueueBackupPersonalRestoreIdentityV2 {
  kind: 'queue-backup-personal-restore-prepared-receipt';
  schemaVersion: 2;
  id: string;
  recordPresent: boolean;
  preimageDigest: string;
  restoredDigest: string;
  preparedActionsDigest: string;
  preparedAt: string;
}

export interface QueueBackupPersonalRestoreTransitionV2 {
  kind: 'queue-backup-personal-restore-transition';
  schemaVersion: 2;
  state: 'prepared';
  id: string;
  preparedReceipt: QueueBackupPersonalRestorePreparedReceiptV2;
  preimage: QueuedAction[];
  restoredActions: QueuedAction[];
}

export type QueueBackupPersonalRestoreTerminalReceiptV2 =
  | (QueueBackupPersonalRestoreReceiptCommonV2 & {
    outcome: 'finalized' | 'rolled-back' | 'invalidated';
    recordPresent: boolean;
    preimageDigest: string;
    restoredDigest: string;
    preparedActionsDigest: string;
    resultDigest: string;
    completedAt: string;
    invalidationReason?: string;
  })
  | (QueueBackupPersonalRestoreReceiptCommonV2 & {
    outcome: 'abandoned-before-prepare';
    abandonReason: 'marker-committed-before-queue-prepare';
    recordPresent: boolean;
    resultDigest: string;
    completedAt: string;
  });

export type QueueBackupPersonalRestoreCommandV2 =
  | {
    kind: 'prepare';
    identity: QueueBackupPersonalRestoreIdentityV2;
    expectedActions: QueuedAction[];
    restoredActions: QueuedAction[];
  }
  | {
    kind: 'finalize' | 'rollback';
    identity: QueueBackupPersonalRestoreIdentityV2;
  }
  | {
    kind: 'invalidate';
    identity: QueueBackupPersonalRestoreIdentityV2;
    invalidationReason: string;
  };

export interface QueueBackupPersonalRestoreAbandonCommandV2 {
  kind: 'abandon-before-prepare';
  identity: QueueBackupPersonalRestoreIdentityV2;
  absenceProof: QueueBackupPersonalRestoreAbsenceProof;
}

export type QueueBackupPersonalRestoreResultV2 =
  | { status: 'prepared' | 'already-prepared' }
  | {
    status: 'finalized' | 'already-finalized'
      | 'rolled-back' | 'already-rolled-back'
      | 'invalidated' | 'already-invalidated'
      | 'abandoned-before-prepare' | 'already-abandoned-before-prepare';
    receipt: QueueBackupPersonalRestoreTerminalReceiptV2;
  }
  | {
    status: 'rejected';
    reason: 'active-transition' | 'opposite-terminal' | 'state-changed'
      | 'identity-collision' | 'malformed-evidence' | 'retention-full'
      | 'not-prepared' | 'stale-identity';
  }
  | { status: 'aborted'; reason: 'auth-unavailable' | 'transaction-aborted' }
  | { status: 'ambiguous' };

export type QueueBackupPersonalRestoreIdentityStateV2 =
  | {
    status: 'absent-for-identity';
    identity: QueueBackupPersonalRestoreIdentityV2;
    absenceProof: QueueBackupPersonalRestoreAbsenceProof;
  }
  | { status: 'active'; transition: QueueBackupPersonalRestoreTransitionV2 }
  | { status: 'terminal'; receipt: QueueBackupPersonalRestoreTerminalReceiptV2 }
  | {
    status: 'unknown';
    reason: 'auth-unavailable' | 'storage-unavailable' | 'malformed-evidence';
  };

type EnqueueMetadata = {
  operationId?: string;
};

/**
 * 类型安全的操作入队参数
 */
export type EnqueueParams = EnqueueMetadata & (
  | { type: 'create' | 'update'; entityType: 'project'; entityId: string; payload: ProjectPayload; priority?: OperationPriority }
  | { type: 'delete'; entityType: 'project'; entityId: string; payload: ProjectDeletePayload; priority?: OperationPriority }
  | { type: 'create' | 'update' | 'delete'; entityType: 'connection'; entityId: string; payload: ConnectionPayload; priority?: OperationPriority }
  | { type: 'create' | 'update'; entityType: 'task'; entityId: string; payload: TaskPayload; priority?: OperationPriority }
  | { type: 'delete'; entityType: 'task'; entityId: string; payload: TaskDeletePayload; priority?: OperationPriority }
  | { type: 'create'; entityType: 'attachment'; entityId: string; payload: AttachmentUploadPayload; priority?: OperationPriority }
  | { type: 'create' | 'update' | 'delete'; entityType: 'preference'; entityId: string; payload: PreferencePayload; priority?: OperationPriority }
  | { type: 'create' | 'update'; entityType: 'focus-session'; entityId: string; payload: FocusSessionPayload; priority?: OperationPriority }
  | { type: 'create' | 'update'; entityType: 'routine-task'; entityId: string; payload: RoutineTaskPayload; priority?: OperationPriority }
  | { type: 'create' | 'update'; entityType: 'routine-completion'; entityId: string; payload: RoutineCompletionPayload; priority?: OperationPriority }
);

/**
 * 死信队列项 - 永久失败的操作
 */
export interface DeadLetterItem {
  action: QueuedAction;
  failedAt: string;
  reason: string;
}
