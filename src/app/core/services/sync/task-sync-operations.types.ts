import type { Task } from '../../../../models';
import type { SyncRpcResult, TaskWriteIntent } from '../../../../services/sync-rpc-client.service';

/** Tombstone 查询结果 */
export interface TombstoneQueryResult {
  ids: Set<string>;
  deletedAtByTaskId?: Map<string, number>;
  fromRemote: boolean;
  localCacheOnly: boolean;
  timestamp: number;
}

export interface TaskPushRequest {
  task: Task;
  projectId: string;
  skipTombstoneCheck: boolean;
  fromRetryQueue: boolean;
  sourceUserId?: string;
  dataSafetyOwnerUserId?: string;
  dataSafetyRpcAudit?: TaskRpcWriteAuditContext;
  dataSafetyRpcAuditRecorded?: boolean;
  treatTombstoneAsPermanent: boolean;
  writeIntent?: TaskWriteIntent;
  operationId?: string;
  replayFence?: TaskActionQueueReplayFence;
  replayHandoff?: boolean;
  replayOutcome?: 'stale' | 'deferred';
}

export type TaskActionQueueReplayInput = {
  actionId: string;
  actionOperationId: string;
  task: Task;
  projectId: string;
  sourceUserId: string;
  writeIntent?: TaskWriteIntent;
  leaseSignal: AbortSignal;
  isFenceCurrent: () => boolean;
};

export type TaskActionQueueReplayFence = TaskActionQueueReplayInput & {
  durableTask: Task;
  payloadSignature: string;
  isCurrent: () => boolean;
};

export type TaskActionQueueReplayResult =
  | { outcome: 'applied' | 'handoff' | 'stale' | 'deferred' }
  | { outcome: 'conflict'; error: unknown };

export type TaskPushExecutionOutcome = 'pushed' | 'blocked-by-tombstone' | 'blocked-by-sync-rpc' | 'not-pushed';

export interface TaskRpcWriteAuditContext {
  operationId: string;
  result: SyncRpcResult;
  localTimestamp: number;
  updatedAtBaseline: string | null;
  beforeVersion: string | null;
  enteredRetryQueue: boolean;
  retryCount: number;
  lastSyncTimeBefore: string | null;
}

export type TopologicalSortFrame = { taskId: string; expanded: boolean; depth: number };

export interface TaskPurgeResult {
  success: boolean;
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  retriedTaskIds: string[];
  conflictTaskIds?: string[];
  conflictPersisted?: boolean;
}

export interface RemoteTaskFreshness {
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface TaskPositionPushRequest {
  taskId: string;
  x: number;
  y: number;
  projectId?: string;
  fallbackTask?: Task;
  sourceUserId?: string;
  operationId?: string;
}

export interface TaskDeleteRequest {
  taskId: string;
  projectId: string;
  sourceUserId?: string;
  fromRetryQueue: boolean;
  baseUpdatedAt?: string | null;
  operationId?: string;
}

export type TaskWriteRow = {
  id: string;
  project_id: string;
  title: string;
  content: string;
  stage: number | null;
  parent_id: string | null;
  order: number;
  rank: number;
  status: Task['status'];
  x: number;
  y: number;
  short_id: string | undefined;
  priority: Task['priority'] | null;
  due_date: string | null;
  expected_minutes: number | null;
  cognitive_load: Task['cognitive_load'] | null;
  wait_minutes: number | null;
  tags: string[];
  completed_at: string | null;
  deleted_at: string | null;
  attachments: Task['attachments'];
  parking_meta: Task['parkingMeta'] | null;
  attention_meta: Task['attentionMeta'] | null;
};
