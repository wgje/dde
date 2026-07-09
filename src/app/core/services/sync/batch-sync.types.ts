import type { SupabaseClient } from '@supabase/supabase-js';
import type { Connection, Project, Task } from '../../../../models';
import type { ProjectChangeSummary } from '../../../../services/change-tracker.types';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import type { ProjectSavePreparation } from './project-save-plan';
import type { RetryQueueLastFailure, TaskDeleteBaseUpdatedAtMap } from './retry-queue.types';

export type { TaskDeleteBaseUpdatedAtMap } from './retry-queue.types';

export interface RemoteExistingTaskIdsResult {
  existingIds: Set<string>;
  deferredBySuspension: boolean;
}

export interface TaskPurgeCloudResult {
  success: boolean;
  retriedTaskIds?: string[];
  deletedTaskIds?: string[];
  skippedTaskIds?: string[];
}

export interface ProjectSaveRetryContext {
  project: Project;
  userId: string;
  pendingTaskIdsToDelete: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  retryEnqueued: string[];
  failedTaskIds: string[];
  failedConnectionIds: string[];
  projectPushed: boolean;
  enqueueProjectRetry: () => Promise<boolean>;
}

export interface RefreshedProjectSaveSessionContext extends ProjectSaveRetryContext {
  sessionUserId: string | null;
}

export interface ProjectSaveSessionRefreshContext extends ProjectSaveRetryContext {
  client: SupabaseClient;
}

export interface ProjectSaveTaskPushContext {
  callbacks: BatchSyncCallbacks;
  task: Task;
  projectId: string;
  userId: string;
  operationId?: string;
  positionOnlyUpdate: boolean | undefined;
  writeIntent?: TaskWriteIntent;
  failedTaskIds: string[];
}

export interface ProjectSaveState {
  failedTaskIds: string[];
  failedConnectionIds: string[];
  retryEnqueued: string[];
  projectPushed: boolean;
  taskPurgeSucceeded: boolean;
}

export interface ProjectSaveRetryTracker {
  recordRetryMarker: (marker: string) => void;
  recordDurableRetryMarker: (marker: string) => void;
  enqueueProjectRetry: () => Promise<boolean>;
  confirmAccumulatedRetryMarkers: () => Promise<void>;
}

export interface ProjectSaveRuntimeContext {
  callbacks: BatchSyncCallbacks;
  project: Project;
  userId: string;
  operationId?: string;
  changes: ProjectChangeSummary;
  pendingTaskIdsToDelete: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  state: ProjectSaveState;
  retryTracker: ProjectSaveRetryTracker;
}

export type ProjectSavePreflightResult =
  | { client: SupabaseClient; result?: undefined }
  | { client?: undefined; result: BatchSyncResult };

export interface ProjectSaveBatchContext extends ProjectSaveRuntimeContext {
  client: SupabaseClient;
  batchChangeRevision: number;
  preparation: ProjectSavePreparation;
  projectSnapshot: Project;
}

export interface PreparedProjectSaveBatch {
  tasksToSync: Task[];
  connectionTombstoneIds: Set<string>;
  connectionUpsertIds: Set<string>;
}

export interface ConnectionReadiness {
  allSyncedTaskIds: Set<string>;
  purgedTaskIds: Set<string>;
  deferredBySuspension: boolean;
}

/** 批量同步结果 */
export interface BatchSyncResult {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  projectPushed?: boolean;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
  failureReason?: string;
  terminal?: boolean;
  /**
   * 中文注释：部分失败但未全部转交 RetryQueue 的语义标记。
   * - true：存在被记入 failedTaskIds / failedConnectionIds 的项未进入 RetryQueue（容量已满 /
   *   purge 部分失败 / 浏览器挂起 continue 等），下游不应以 "已转交" 视之，也不应抛 ERROR。
   * - false / undefined：要么完全成功，要么所有失败项都已转交 RetryQueue（"fullyResolved"）。
   */
  partialRetryHandoff?: boolean;
}

/** 批量同步回调函数类型 */
export interface BatchSyncCallbacks {
  pushProject: (
    project: Project,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
  pushTask: (
    task: Task,
    projectId: string,
    skipTombstoneCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ) => Promise<{ success: boolean; retryEnqueued?: boolean }>;
  pushTaskPosition: (
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
    operationId?: string,
  ) => Promise<boolean>;
  pushConnection: (
    connection: Connection,
    projectId: string,
    skipTombstoneCheck?: boolean,
    skipTaskExistenceCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    operationId?: string,
  ) => Promise<{ success: boolean; retryEnqueued?: boolean }>;
  getTombstoneIds: (projectId: string) => Promise<Set<string>>;
  getConnectionTombstoneIds: (projectId: string) => Promise<Set<string>>;
  purgeTasksFromCloud: (
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ) => Promise<TaskPurgeCloudResult>;
  topologicalSortTasks: (tasks: Task[]) => Task[];
  addToRetryQueue: (
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: unknown,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ) => Promise<boolean>;
  addToRetryQueueDurably: (
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: unknown,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ) => Promise<boolean>;
  confirmRetryQueuePersistence: () => Promise<boolean>;
}
