import { expect, it } from 'vitest';

import type { TaskOperationAdapterService } from './task-operation-adapter.service';

export interface TaskOperationAdapterLifecycleSpecContext {
  service(): TaskOperationAdapterService;
}

export function registerTaskOperationAdapterLifecycleSpecs(
  context: TaskOperationAdapterLifecycleSpecContext,
): void {
  it('warmup 应幂等且不抛错', async () => {
    const service = context.service();

    await expect(service.warmup()).resolves.toBeUndefined();

    const p1 = service.warmup();
    const p2 = service.warmup();
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();
  });
}
