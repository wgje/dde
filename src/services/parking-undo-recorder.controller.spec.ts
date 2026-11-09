import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../models';
import { ParkingUndoRecorderController } from './parking-undo-recorder.controller';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-01-01T00:00:00.000Z',
    tasks: [],
    connections: [],
    ...overrides,
  };
}

describe('ParkingUndoRecorderController', () => {
  it('captures one snapshot per project for candidate task ids', () => {
    const projectA = project({ id: 'project-a' });
    const projectB = project({ id: 'project-b' });
    const createProjectSnapshot = vi.fn((input: Project) => ({
      tasks: input.tasks,
      connections: input.connections,
    }));
    const controller = new ParkingUndoRecorderController({
      findProjectId: taskId => taskId === 'task-3' ? 'project-b' : 'project-a',
      getProject: projectId => projectId === 'project-b' ? projectB : projectA,
      createProjectSnapshot,
      recordAction: vi.fn(),
    });

    const snapshots = controller.captureSnapshots(['task-1', 'task-2', null, 'task-3']);

    expect([...snapshots.keys()]).toEqual(['project-a', 'project-b']);
    expect(createProjectSnapshot).toHaveBeenCalledTimes(2);
  });

  it('records task-park undo actions only when a project snapshot changed', () => {
    const changedProject = project({
      id: 'changed',
      tasks: [{ id: 'task-after' } as Project['tasks'][number]],
    });
    const unchangedProject = project({ id: 'unchanged' });
    const recordAction = vi.fn();
    const controller = new ParkingUndoRecorderController({
      findProjectId: vi.fn(),
      getProject: projectId => projectId === 'changed' ? changedProject : unchangedProject,
      createProjectSnapshot: input => ({
        tasks: input.tasks,
        connections: input.connections,
      }),
      recordAction,
    });
    const beforeSnapshots = new Map<string, Partial<Project>>([
      ['changed', { tasks: [], connections: [] }],
      ['unchanged', { tasks: [], connections: [] }],
      ['missing', { tasks: [], connections: [] }],
    ]);

    controller.recordAction(beforeSnapshots);

    expect(recordAction).toHaveBeenCalledOnce();
    expect(recordAction).toHaveBeenCalledWith({
      type: 'task-park',
      projectId: 'changed',
      data: {
        before: { tasks: [], connections: [] },
        after: { tasks: changedProject.tasks, connections: changedProject.connections },
      },
    });
  });
});
