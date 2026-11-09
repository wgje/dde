import { beforeEach, describe, type Mock } from 'vitest';

import type { ActionQueueService, EnqueueParams } from './action-queue.service';
import { registerActionQueueProcessingLeaseSpecs } from './action-queue-processing-lease.spec-helpers';
import { registerActionQueueProcessingOwnerTransitionSpecs } from './action-queue-processing-owner-transition.spec-helpers';

export interface ActionQueueProcessingRetrySpecContext {
  service(): ActionQueueService;
  setNetworkStatus(online: boolean): void;
  triggerNetworkEvent(online: boolean): void;
  setVisibilityState(state: 'visible' | 'hidden'): void;
  createTestProjectAction(): EnqueueParams;
  createTestTaskAction(): EnqueueParams;
  setCurrentUserId(userId: string | null): void;
  mockSyncWriterLeaseService: {
    isFeatureEnabled: Mock;
    requestLease: Mock;
  };
  mockLoggerDebug: Mock;
  mockLoggerWarn: Mock;
  mockToastWarning: Mock;
  mockLeaseRelease: Mock;
  mockSentryAddBreadcrumb: Mock;
}

export function registerActionQueueProcessingRetrySpecs(context: ActionQueueProcessingRetrySpecContext): void {
  let service: ActionQueueService;

  beforeEach(() => {
    service = context.service();
  });

  describe('处理器注册和执行', () => {
    registerActionQueueProcessingLeaseSpecs({
      context,
      service: () => service,
    });
    registerActionQueueProcessingOwnerTransitionSpecs({
      context,
      service: () => service,
    });
  });
}
