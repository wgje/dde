import { beforeEach, expect, it } from 'vitest';

import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';

export function registerDockEngineBasicDockingSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  const { seedTask } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('only first drag auto-sets main task in a focus session', async () => {
    seedTask('A');
    seedTask('B');

    await service.dockTask('A');
    await service.dockTask('B');

    const a = service.entries().find(entry => entry.taskId === 'A');
    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(a?.isMain).toBe(true);
    expect(b?.isMain).toBe(false);
  });

  it('dockTask should reject non-active tasks', async () => {
    seedTask('archived-task', { status: 'completed' });
    await service.dockTask('archived-task');
    expect(service.entries().length).toBe(0);
  });

  it('dockTaskFromExternalDrag should always dock into backup lane with manual zone source', async () => {
    seedTask('drag-task', { projectId: 'project-1' });

    await service.dockTaskFromExternalDrag('drag-task', 'flow');

    const entry = service.entries().find(item => item.taskId === 'drag-task');
    expect(entry?.lane).toBe('backup');
    expect(entry?.zoneSource).toBe('manual');
    expect(entry?.sourceSection).toBe('flow');
    expect(entry?.relationScore).toBe(20);
    expect(entry?.relationReason).toBe('manual:backup');
  });
}
