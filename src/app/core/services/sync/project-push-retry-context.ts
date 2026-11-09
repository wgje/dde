import type { Project } from '../../../../models';
import type { RetryQueueLastFailure, TaskDeleteBaseUpdatedAtMap } from './retry-queue.service';
import type {
  DurableRetryHandler,
  ProjectPushRetryContext,
} from './project-push.types';

export interface ProjectPushRetryOptions {
  durableRetryHandler: DurableRetryHandler | null;
  project: Project;
  fromRetryQueue: boolean;
  sourceUserId?: string;
  taskIdsToDelete?: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationId?: string;
}

export async function enqueueProjectPushRetry(
  options: ProjectPushRetryOptions,
  lastFailure?: RetryQueueLastFailure,
): Promise<boolean> {
  const {
    durableRetryHandler,
    project,
    fromRetryQueue,
    sourceUserId,
    taskIdsToDelete,
    taskDeleteBaseUpdatedAtMap,
    operationId,
  } = options;
  if (fromRetryQueue || !durableRetryHandler) {
    return false;
  }

  const args: Parameters<DurableRetryHandler> = [
    'project',
    'upsert',
    project,
    undefined,
    sourceUserId,
    taskIdsToDelete,
    undefined,
  ];
  if (taskDeleteBaseUpdatedAtMap !== undefined || operationId !== undefined || lastFailure !== undefined) {
    args.push(taskDeleteBaseUpdatedAtMap);
  }
  if (operationId !== undefined || lastFailure !== undefined) {
    args.push(operationId);
  }
  if (lastFailure !== undefined) {
    args.push(lastFailure);
  }

  return durableRetryHandler(...args);
}

export function createProjectPushRetryContext(options: ProjectPushRetryOptions): ProjectPushRetryContext {
  let retryEnqueued = false;
  return {
    get retryEnqueued(): boolean {
      return retryEnqueued;
    },
    enqueueRetry: async (lastFailure?: RetryQueueLastFailure): Promise<boolean> => {
      retryEnqueued = await enqueueProjectPushRetry(options, lastFailure);
      return retryEnqueued;
    },
  };
}
