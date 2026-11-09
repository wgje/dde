import { beforeEach, expect, it } from 'vitest';

import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';

type DockEngineAutoLaneSpecContext = DockEngineSpecContext & {
  seedConnection(projectId: string, source: string, target: string): void;
};

export function registerDockEngineAutoLaneSpecs(context: DockEngineAutoLaneSpecContext): void {
  let service: DockEngineService;
  const { seedTask, seedConnection } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('auto lane inference should mark parent-child tasks as combo-select relation', async () => {
    seedTask('A', { projectId: 'project-1', stage: 1, order: 1 });
    seedTask('B', { projectId: 'project-1', stage: 2, order: 1, parentId: 'A' });

    await service.dockTask('A');
    await service.dockTask('B');

    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(b?.lane).toBe('combo-select');
    expect((b?.relationReason ?? '')).toContain('parent-child');
    expect((b?.relationScore ?? 0) > 0).toBe(true);
  });

  it('auto lane inference should treat cross-project tasks as backup by default', async () => {
    seedTask('A', { projectId: 'project-1' });
    seedTask('B', { projectId: 'project-2' });

    await service.dockTask('A');
    await service.dockTask('B');

    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(b?.lane).toBe('backup');
    expect(b?.relationReason).toBe('auto:cross-project-default-backup');
  });

  it('auto lane inference should treat direct connection tasks as combo-select relation', async () => {
    seedTask('A', { projectId: 'project-1' });
    seedTask('B', { projectId: 'project-1' });
    seedConnection('project-1', 'A', 'B');

    await service.dockTask('A');
    await service.dockTask('B');

    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(b?.lane).toBe('combo-select');
    expect((b?.relationReason ?? '')).toContain('direct-connection');
  });

  it('auto lane inference should keep tree distance scoring beyond depth 10', async () => {
    let parentId: string | null = null;
    for (let index = 0; index <= 11; index += 1) {
      const id = `tree-${index}`;
      seedTask(id, {
        projectId: 'project-1',
        parentId,
      });
      parentId = id;
    }

    await service.dockTask('tree-0');
    await service.dockTask('tree-11');

    const deepEntry = service.entries().find(entry => entry.taskId === 'tree-11');
    expect((deepEntry?.relationReason ?? '')).toContain('tree-distance:11');
    expect((deepEntry?.relationScore ?? 0) > 0).toBe(true);
  });
}
