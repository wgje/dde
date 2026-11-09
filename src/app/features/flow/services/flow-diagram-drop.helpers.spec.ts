import { describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';
import type { Task } from '../../../../models';
import type { ActiveProjectOwner, ProjectStateService } from '../../../../services/project-state.service';
import type { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { writeTaskDragPayload } from '../../../../utils/task-drag-payload';
import { installFlowDiagramDropHandlers } from './flow-diagram-drop.helpers';

function createTask(id = 'shared-task'): Task {
  return { id, title: id, content: '', status: 'active', stage: 1, order: 0, rank: 0,
    x: 0, y: 0, parentId: null, displayId: id, createdDate: '', attachments: [], tags: [] };
}

function createDataTransfer(owner: ActiveProjectOwner | null): DataTransfer {
  const values = new Map<string, string>();
  const dataTransfer = { setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '' } as unknown as DataTransfer;
  writeTaskDragPayload(dataTransfer, { v: 1, type: 'task', taskId: 'shared-task',
    projectId: owner?.projectId ?? null, source: 'flow', ...(owner ? { projectOwner: owner } : {}) });
  return dataTransfer;
}

function dispatchDrop(div: HTMLDivElement, dataTransfer: DataTransfer): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientX: { value: 4 }, clientY: { value: 6 } });
  div.dispatchEvent(event);
}

function createHarness(current: ActiveProjectOwner) {
  const diagramDiv = document.createElement('div');
  const getTask = vi.fn(() => createTask());
  const isCurrent = vi.fn((owner: ActiveProjectOwner) => owner.projectId === current.projectId
    && owner.generation === current.generation);
  const onDrop = vi.fn();
  const cleanup = installFlowDiagramDropHandlers({ diagram: new go.Diagram(), diagramDiv,
    projectState: { getTask, isActiveProjectOwnerCurrent: isCurrent } as unknown as ProjectStateService,
    logger: { error: vi.fn() },
    sentryLazyLoader: { captureException: vi.fn() } as unknown as SentryLazyLoaderService, onDrop });
  return { cleanup, diagramDiv, getTask, onDrop };
}

describe('flow diagram drop ownership', () => {
  it.each([
    ['A to B', { projectId: 'project-a', generation: 1 }, { projectId: 'project-b', generation: 2 }],
    ['A to B to A', { projectId: 'project-a', generation: 1 }, { projectId: 'project-a', generation: 3 }],
  ] as const)('rejects stale %s payload before same-id task resolution', (_label, payloadOwner, currentOwner) => {
    const harness = createHarness(currentOwner);
    dispatchDrop(harness.diagramDiv, createDataTransfer(payloadOwner));
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.onDrop).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it('preserves duplicate-project ownership and rejects ownerless legacy input', () => {
    const owner = { projectId: 'project-a', generation: 4 } as const;
    const harness = createHarness(owner);
    dispatchDrop(harness.diagramDiv, createDataTransfer(owner));
    expect(harness.getTask).toHaveBeenCalledWith('shared-task');
    expect(harness.onDrop).toHaveBeenCalledOnce();
    harness.getTask.mockClear();
    dispatchDrop(harness.diagramDiv, createDataTransfer(null));
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.onDrop).toHaveBeenCalledOnce();
    harness.cleanup();
  });
});
