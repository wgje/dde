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
}

export interface ProjectDeletePayload {
  projectId: string;
  userId: string;
  sourceUserId?: string;
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
  retryCount: number;
  lastError?: string;
  /** 错误类型：network=网络错误可重试，business=业务错误不可重试，permission=权限错误，timeout=超时，unknown=未知错误 */
  errorType?: 'network' | 'business' | 'permission' | 'timeout' | 'unknown' | 'deferred';
  /** 操作优先级：决定失败后的处理策略 */
  priority?: OperationPriority;
}

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
