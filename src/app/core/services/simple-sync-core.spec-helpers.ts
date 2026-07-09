import { expect, it } from 'vitest';

import { SimpleSyncService } from './simple-sync.service';

interface SimpleSyncCoreSpecContext {
  service: () => SimpleSyncService;
  mockRetryQueueService: () => {
    clear: (...args: unknown[]) => unknown;
  };
}

export function registerSimpleSyncCoreSpecs(
  context: SimpleSyncCoreSpecContext,
): void {
  it('destroy 不应清空 RetryQueue，避免应用退出时丢失待同步 outbox', () => {
    context.service().destroy();

    expect(context.mockRetryQueueService().clear).not.toHaveBeenCalled();
  });
}
