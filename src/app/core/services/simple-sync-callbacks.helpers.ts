import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection, Project, Task } from '../../../models';
import type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
import type {
  BatchSyncService,
  RetryableEntityType,
  RetryableOperation,
  RetryQueueLastFailure,
  TaskDeleteBaseUpdatedAtMap,
  TaskPurgeResult,
} from './sync';
import type { ProjectDeleteCoordinatorService } from './sync/project-delete-coordinator.service';
import type { ProjectPushService } from './sync/project-push.service';
import type { DurableRetryHandler, GetSupabaseClientHandler } from './sync/project-push.types';
import type { ProjectSaveFlightCoordinatorService } from './sync/project-save-flight-coordinator.service';
import type { ProjectSyncCursorService } from './sync/project-sync-cursor.service';

type RetryQueueData = Task | Project | Connection | { id: string };

type ProjectPushStatus = Promise<{
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  retryEnqueued?: boolean;
  failureReason?: string;
  terminal?: boolean;
}>;

type EntityPushStatus = Promise<{ success: boolean; retryEnqueued?: boolean }>;

export interface SimpleSyncBatchCallbackFacade {
  pushProjectFromBatchSync(
    project: Project,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): ProjectPushStatus;
  pushTaskWithResult(
    task: Task,
    projectId: string,
    skipTombstoneCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): EntityPushStatus;
  pushTaskPosition(
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
    operationId?: string,
  ): Promise<boolean>;
  pushConnectionWithResult(
    connection: Connection,
    projectId: string,
    skipTombstoneCheck?: boolean,
    skipTaskExistenceCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    operationId?: string,
  ): EntityPushStatus;
  getTombstoneIds(projectId: string): Promise<Set<string>>;
  getConnectionTombstoneIds(projectId: string): Promise<Set<string>>;
  purgeTasksFromCloudWithResult(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<TaskPurgeResult>;
  topologicalSortTasks(tasks: Task[]): Task[];
  addToRetryQueue(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: RetryQueueData,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean>;
  addToRetryQueueDurably(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: RetryQueueData,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean>;
  confirmRetryQueuePersistence(): Promise<boolean>;
}

export interface ConfigureSimpleSyncBatchCallbacksDeps {
  batchSyncService: BatchSyncService;
  facade: SimpleSyncBatchCallbackFacade;
}

export function configureSimpleSyncBatchCallbacks(
  deps: ConfigureSimpleSyncBatchCallbacksDeps,
): void {
  const facade = deps.facade;
  deps.batchSyncService.setCallbacks({
    pushProject: (project, fromRetryQueue, sourceUserId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId) =>
      facade.pushProjectFromBatchSync(project, fromRetryQueue ?? false, sourceUserId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId),
    pushTask: (task, projectId, skipTombstoneCheck, fromRetryQueue, sourceUserId, writeIntent, operationId) =>
      facade.pushTaskWithResult(task, projectId, skipTombstoneCheck, fromRetryQueue, sourceUserId, writeIntent, operationId),
    pushTaskPosition: (taskId, x, y, projectId, fallbackTask, sourceUserId, operationId) =>
      operationId === undefined
        ? facade.pushTaskPosition(taskId, x, y, projectId, fallbackTask, sourceUserId)
        : facade.pushTaskPosition(taskId, x, y, projectId, fallbackTask, sourceUserId, operationId),
    pushConnection: (connection, projectId, skipTombstoneCheck, skipTaskExistenceCheck, fromRetryQueue, sourceUserId, operationId) =>
      facade.pushConnectionWithResult(connection, projectId, skipTombstoneCheck, skipTaskExistenceCheck, fromRetryQueue, sourceUserId, operationId),
    getTombstoneIds: (projectId) => facade.getTombstoneIds(projectId),
    getConnectionTombstoneIds: (projectId) => facade.getConnectionTombstoneIds(projectId),
    purgeTasksFromCloud: (projectId, taskIds, sourceUserId, baseUpdatedAtMap, operationId) =>
      facade.purgeTasksFromCloudWithResult(projectId, taskIds, sourceUserId, baseUpdatedAtMap, operationId),
    topologicalSortTasks: (tasks) => facade.topologicalSortTasks(tasks),
    addToRetryQueue: (type, operation, data, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId, lastFailure) =>
      lastFailure === undefined
        ? facade.addToRetryQueue(type, operation, data as RetryQueueData, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId)
        : facade.addToRetryQueue(type, operation, data as RetryQueueData, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId, lastFailure),
    addToRetryQueueDurably: (type, operation, data, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId, lastFailure) =>
      lastFailure === undefined
        ? facade.addToRetryQueueDurably(type, operation, data as RetryQueueData, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId)
        : facade.addToRetryQueueDurably(type, operation, data as RetryQueueData, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId, lastFailure),
    confirmRetryQueuePersistence: () => facade.confirmRetryQueuePersistence(),
  });
}

export interface WireSimpleSyncCoordinatorCallbacksDeps {
  projectSaveFlightCoordinator: ProjectSaveFlightCoordinatorService;
  projectPush: ProjectPushService;
  projectDelete: ProjectDeleteCoordinatorService;
  projectSyncCursor: ProjectSyncCursorService;
  getSupabaseClient: GetSupabaseClientHandler;
  addToRetryQueueDurably: (
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: RetryQueueData,
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ) => Promise<boolean>;
}

export function wireSimpleSyncCoordinatorCallbacks(
  deps: WireSimpleSyncCoordinatorCallbacksDeps,
): void {
  const getSupabaseClient = (): Promise<SupabaseClient | null> => deps.getSupabaseClient();
  const durableRetryHandler: DurableRetryHandler = (
    type,
    operation,
    data,
    projectId,
    sourceUserId,
    taskIdsToDelete,
    _writeIntent,
    taskDeleteBaseUpdatedAtMap,
    operationId,
    lastFailure,
  ) => lastFailure === undefined
    ? deps.addToRetryQueueDurably(type, operation, data, projectId, sourceUserId, taskIdsToDelete, undefined, taskDeleteBaseUpdatedAtMap, operationId)
    : deps.addToRetryQueueDurably(type, operation, data, projectId, sourceUserId, taskIdsToDelete, undefined, taskDeleteBaseUpdatedAtMap, operationId, lastFailure);

  deps.projectSaveFlightCoordinator.durableRetryHandler = durableRetryHandler;
  deps.projectPush.getSupabaseClientHandler = getSupabaseClient;
  deps.projectPush.durableRetryHandler = durableRetryHandler;
  deps.projectDelete.getSupabaseClientHandler = getSupabaseClient;
  deps.projectSyncCursor.getSupabaseClientHandler = getSupabaseClient;
}
