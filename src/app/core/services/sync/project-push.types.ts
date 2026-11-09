import type { SupabaseClient } from '@supabase/supabase-js';
import type { Task, Project, Connection } from '../../../../models';
import type {
  RetryableEntityType,
  RetryableOperation,
  TaskDeleteBaseUpdatedAtMap,
  RetryQueueLastFailure,
} from './retry-queue.service';

export type GetSupabaseClientHandler = () => Promise<SupabaseClient | null>;

export type DurableRetryHandler = (
  type: RetryableEntityType,
  operation: RetryableOperation,
  data: Task | Project | Connection | { id: string },
  projectId?: string,
  sourceUserId?: string,
  taskIdsToDelete?: string[],
  writeIntent?: undefined,
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  operationId?: string,
  lastFailure?: RetryQueueLastFailure,
) => Promise<boolean>;

export type RemoteProjectFreshness = {
  updatedAt: string | null;
  deletedAt: string | null;
};

export type ProjectPushPayloads = {
  insert: {
    id: string;
    owner_id: string;
    title: string;
    description: string | undefined;
    version: number;
    migrated_to_v2: true;
    deleted_at: string | null;
  };
  update: {
    title: string;
    description: string | undefined;
    version: number;
    migrated_to_v2: true;
    deleted_at: string | null;
  };
};

export type ProjectPushPersistenceResult = {
  data: { updated_at?: string | null } | null;
  error: unknown | null;
};

export type ProjectPushStatus = {
  success: boolean;
  retryEnqueued: boolean;
  failureReason?: string;
};

export type ProjectPushRetryContext = {
  get retryEnqueued(): boolean;
  enqueueRetry: (lastFailure?: RetryQueueLastFailure) => Promise<boolean>;
};

export type ProjectPushStatusArgs = {
  fromRetryQueue: boolean;
  sourceUserId?: string;
  taskIdsToDelete?: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationId?: string;
};

export type ProjectPushExecutor = () => Promise<boolean>;
