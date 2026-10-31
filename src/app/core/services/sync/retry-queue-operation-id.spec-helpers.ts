import { registerRetryQueueOperationIdCasRefreshUnknownOutcomeSpecs } from './retry-queue-operation-id-cas.spec-helpers';
import {
  registerRetryQueueOperationIdReplayLeadSpecs,
  registerRetryQueueOperationIdReplayTailSpecs,
  type RetryQueueOperationIdSpecContext,
} from './retry-queue-operation-id-replay.spec-helpers';

export type { RetryQueueOperationIdSpecContext } from './retry-queue-operation-id-replay.spec-helpers';

export function registerRetryQueueOperationIdSpecs(
  getContext: () => RetryQueueOperationIdSpecContext,
): void {
  registerRetryQueueOperationIdReplayLeadSpecs(getContext);
  registerRetryQueueOperationIdCasRefreshUnknownOutcomeSpecs(getContext);
  registerRetryQueueOperationIdReplayTailSpecs(getContext);
}
