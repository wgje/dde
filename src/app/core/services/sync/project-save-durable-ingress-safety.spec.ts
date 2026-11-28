import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../../models';
import { AUTH_CONFIG } from '../../../../config';
import { ActionQueueService } from '../../../../services/action-queue.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { BatchSyncService } from './batch-sync.service';
import { ProjectSaveFlightCoordinatorService } from './project-save-flight-coordinator.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SyncStateService } from './sync-state.service';

const owner = 'owner-A';
const task: Task = { id: 'task-A', title: 'T', content: 'new edit', stage: 1, parentId: null,
  order: 1, rank: 1, status: 'active', x: 0, y: 0, displayId: '1',
  createdDate: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:01:00.000Z' };
const project: Project = { id: 'project-A', name: 'P', description: '', tasks: [task], connections: [],
  createdDate: task.createdDate, updatedAt: task.updatedAt, version: 1 };

function harness(withQueue = true, leafTask?: Task, fieldEvidence: string[] = ['content']) {
  const saveProjectToCloud = vi.fn().mockResolvedValue({ success: true });
  const enqueueDurablyForOwner = vi.fn().mockResolvedValue('durable-action');
  const queue = { enqueueDurablyForOwner, getActionsForEntity: vi.fn((type: string) =>
    type === 'task' && leafTask ? [{ entityType: 'task', entityId: task.id, operationId: 'leaf-operation',
      type: 'update', payload: { sourceUserId: owner, projectId: project.id, task: leafTask, writeIntent: 'task_text_update' } }] : []) };
  const providers = [
    { provide: ProjectSaveFlightCoordinatorService, useClass: ProjectSaveFlightCoordinatorService },
    { provide: BatchSyncService, useValue: { saveProjectToCloud } },
    { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
    { provide: ChangeTrackerService, useValue: { getProjectChanges: () => ({ tasksToCreate: [], tasksToUpdate: [task],
      taskIdsToDelete: [], taskDeleteBaseUpdatedAtMap: {}, connectionsToCreate: [], connectionsToUpdate: [],
      connectionsToDelete: [], taskUpdateFieldsById: { [task.id]: fieldEvidence } }) } },
    { provide: RetryQueueService, useValue: {} },
    { provide: SessionManagerService, useValue: {} },
    { provide: SyncStateService, useValue: {} },
    { provide: SessionRuntimeResetRegistry, useValue: { register: vi.fn() } },
    ...(withQueue ? [{ provide: ActionQueueService, useValue: queue }] : []),
  ];
  const injector = Injector.create({ providers });
  return { service: runInInjectionContext(injector, () => injector.get(ProjectSaveFlightCoordinatorService)),
    enqueueDurablyForOwner, saveProjectToCloud, queue };
}

describe('project durable ingress fail-closed safety', () => {
  it('returns synchronously-local failure without resolving queue or invoking remote writes for local mode', async () => {
    const h = harness();
    const result = await h.service.save(project, AUTH_CONFIG.LOCAL_MODE_USER_ID);
    expect(result.success).toBe(false);
    expect(h.queue.getActionsForEntity).not.toHaveBeenCalled();
    expect(h.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(h.saveProjectToCloud).not.toHaveBeenCalled();
  });
  it('never sends an untracked first RPC when durable queue is not provided', async () => {
    const h = harness(false);
    expect((await h.service.save(project, owner)).success).toBe(false);
    expect(h.saveProjectToCloud).not.toHaveBeenCalled();
  });
  it('freezes the queued project and nested task before the caller mutates it', async () => {
    const h = harness();
    const working = structuredClone(project);
    await h.service.save(working, owner);
    const queued = h.enqueueDurablyForOwner.mock.calls[0]?.[1] as unknown as { payload: { project: Project } };
    working.tasks[0].content = 'later edit'; working.name = 'later name';
    expect(queued.payload.project.name).toBe('P');
    expect(queued.payload.project.tasks[0].content).toBe('new edit');
  });
  it('retains newer edits even when an older same-owner task action is already pending', async () => {
    const h = harness(true, { ...task, content: 'older edit', updatedAt: '2026-11-27T00:00:00.000Z' });
    await h.service.save(structuredClone(project), owner);
    const queued = h.enqueueDurablyForOwner.mock.calls[0]?.[1] as unknown as { payload: { writePlan: { taskUpsertIds: string[] } } };
    expect(queued.payload.writePlan.taskUpsertIds).toEqual([task.id]);
  });

  it('retains unclassified local edits instead of acknowledging a metadata-only plan', async () => {
    const h = harness(true, undefined, []);
    const result = await h.service.save(structuredClone(project), owner);
    expect(result.success).toBe(false);
    expect(h.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(result.failureReason).toContain('write intent');
  });
});