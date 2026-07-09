export { beforeEach, describe, expect, it, vi } from 'vitest';
export { PermanentFailureError } from '../../../utils/permanent-failure-error';
export {
  createMockConnection,
  createMockProject,
  createMockTask,
  expectDeferredCallback,
  readRetryQueueFromIdb,
  setVisibilityState,
} from './simple-sync.test-harness';
export type { MockFn, RetryQueueItem } from './simple-sync.test-harness';
export type { Task, Project, Connection } from '../../../models';
export type { BlackBoxEntry } from '../../../models/focus';
export type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
