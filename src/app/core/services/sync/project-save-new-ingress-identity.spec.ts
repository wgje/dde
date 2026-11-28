import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../models';
import { ActionQueueService } from '../../../../services/action-queue.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { BatchSyncService } from './batch-sync.service';
import { ProjectSaveFlightCoordinatorService } from './project-save-flight-coordinator.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SyncStateService } from './sync-state.service';

const owner = '11111111-1111-4111-8111-111111111111';
const project: Project = {
  id: '22222222-2222-4222-8222-222222222222', name: 'Pending new save', description: '',
  createdDate: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:01:00.000Z',
  version: 2, tasks: [], connections: [],
};
function harness(queueActions: Array<Record<string, any>> = [], changesOverride?: Record<string, unknown>) {
  let resetSession!: () => void;
  let resolveDurable!: (value: string) => void;
  const durable = new Promise<string>(resolve => { resolveDurable = resolve; });
  const enqueueDurablyForOwner = vi.fn(async (_owner: string, action: Record<string, any>) => {
    const queued = { ...action, id: 'action-' + queueActions.length, operationId: 'operation-' + queueActions.length, timestamp: 1, localCommittedAt: 1, retryCount: 0, syncState: 'pending_sync' };
    queueActions.push(queued);
    return queueActions.length === 1 ? durable : queued.id;
  });
  const saveProjectToCloud = vi.fn().mockResolvedValue({ success: true, projectPushed: true });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const injector = Injector.create({ providers: [
    { provide: ProjectSaveFlightCoordinatorService, useClass: ProjectSaveFlightCoordinatorService },
    { provide: BatchSyncService, useValue: { saveProjectToCloud } },
    { provide: ActionQueueService, useValue: { enqueueDurablyForOwner, getActionsForEntity: (type: string, id: string) => queueActions.filter(action => action.entityType === type && action.entityId === id), processQueue: vi.fn().mockResolvedValue(undefined) } },
    { provide: LoggerService, useValue: { category: () => logger } },
    { provide: ChangeTrackerService, useValue: { getProjectChanges: vi.fn(() => changesOverride ?? {
      tasksToCreate: [], tasksToUpdate: [], taskIdsToDelete: [], taskDeleteBaseUpdatedAtMap: {},
      connectionsToCreate: [], connectionsToUpdate: [], connectionsToDelete: [], taskUpdateFieldsById: {},
      hasChanges: false, totalChanges: 0,
    }) } },
    { provide: RetryQueueService, useValue: { length: 0, hasProjectRetryForOwner: () => false } },
    { provide: SessionManagerService, useValue: { getRecentValidationSnapshot: () => ({ userId: owner }) } },
    { provide: SyncStateService, useValue: { update: vi.fn() } },
    { provide: SessionRuntimeResetRegistry, useValue: { register: vi.fn((_owner: string, reset: () => void) => { resetSession = reset; return vi.fn(); }) } },
  ] });
  const service = runInInjectionContext(injector, () => injector.get(ProjectSaveFlightCoordinatorService));
  return { service, saveProjectToCloud, enqueueDurablyForOwner, resolveDurable, queueActions, resetSession };
}

describe('new project save durable ingress boundary', () => {
  it('does not dispatch a first RPC before a new save operation is durable', async () => {
    const h = harness();
    const result = h.service.save(project, owner);
    await Promise.resolve(); await Promise.resolve();
    expect(h.saveProjectToCloud).not.toHaveBeenCalled();
    expect(h.enqueueDurablyForOwner).toHaveBeenCalledWith(owner, expect.objectContaining({
      entityType: 'project', entityId: project.id,
    }));
    h.resolveDurable('durable-parent-action');
    await result;
  });
  it('does not start any RPC when durable intent persistence fails', async () => {
    const h = harness();
    const result = h.service.save(project, owner);
    h.resolveDurable('');
    expect((await result).success).toBe(false);
    expect(h.saveProjectToCloud).not.toHaveBeenCalled();
  });
  it('deduplicates the same pending snapshot after a new coordinator is created, but keeps a fresh edit under a distinct frozen operation', async () => {
    const h = harness();
    const initial = h.service.save(project, owner);
    await Promise.resolve(); await Promise.resolve();
    h.resolveDurable('initial'); await initial;
    const afterReload = harness(h.queueActions);
    const repeated = await afterReload.service.save(project, owner);
    expect(repeated.success).toBe(false);
    expect(afterReload.enqueueDurablyForOwner).not.toHaveBeenCalled();
    const fresh = await afterReload.service.save({ ...project, name: 'Fresh edit', updatedAt: '2026-11-27T00:02:00.000Z' }, owner);
    expect(fresh.success).toBe(false);
    expect(afterReload.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    expect(afterReload.queueActions).toHaveLength(2);
    expect(afterReload.queueActions[0].operationId).not.toBe(afterReload.queueActions[1].operationId);
    expect((afterReload.queueActions[0].payload as Record<string, unknown>)['project']).toEqual(project);
  });

  it('does not adopt foreign-owner leaf actions as write coverage', async () => {
    const task = { id: 'task-1', title: 'T', content: 'edit', stage: 0, parentId: null, order: 0, rank: 0, status: 'active' as const, x: 0, y: 0, displayId: '1', createdDate: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:01:00.000Z' };
    const foreignLeaf = { id: 'leaf', operationId: 'leaf-op', entityType: 'task', entityId: task.id, payload: { sourceUserId: 'user-else', writeIntent: 'task_text_update' } };
    const h = harness([foreignLeaf], { tasksToCreate: [], tasksToUpdate: [{ id: task.id }], taskIdsToDelete: [], taskDeleteBaseUpdatedAtMap: {}, connectionsToCreate: [], connectionsToUpdate: [], connectionsToDelete: [], taskUpdateFieldsById: { [task.id]: ['content'] }, hasChanges: true, totalChanges: 1 });
    const result = h.service.save({ ...project, tasks: [task] }, owner);
    await Promise.resolve(); await Promise.resolve();
    const enqueue = h.enqueueDurablyForOwner.mock.calls[0];
    expect(enqueue?.[0]).toBe(owner);
    const payload = enqueue?.[1]?.payload as Record<string, unknown>;
    expect(payload['writePlan']).toMatchObject({ taskUpsertIds: ['task-1'] });
    h.resolveDurable('durable'); await result;
  });

  it('does not return a successful current-owner result when the session generation changes during durable enqueue', async () => {
    const h = harness();
    const result = h.service.save(project, owner);
    await Promise.resolve(); await Promise.resolve();
    h.resetSession();
    h.resolveDurable('saved-for-original-owner');
    const outcome = await result;
    expect(outcome.success).toBe(false);
    expect(outcome.failureReason).toContain('original owner after session change');
    expect(h.queueActions).toHaveLength(1);
    expect(h.saveProjectToCloud).not.toHaveBeenCalled();
  });

  it('leaves same-owner durable leaf actions as the sole owner of their explicit task writes', async () => {
    const task = { id: 'task-owned-by-leaf', title: 'T', content: 'edit', stage: 0, parentId: null, order: 0, rank: 0, status: 'active' as const, x: 0, y: 0, displayId: '1', createdDate: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:01:00.000Z' };
    const ownedLeaf = { id: 'leaf', operationId: 'leaf-op', type: 'update', entityType: 'task', entityId: task.id, payload: { sourceUserId: owner, projectId: project.id, task: structuredClone(task), writeIntent: 'task_text_update' } };
    const h = harness([ownedLeaf], { tasksToCreate: [], tasksToUpdate: [{ id: task.id }], taskIdsToDelete: [], taskDeleteBaseUpdatedAtMap: {}, connectionsToCreate: [], connectionsToUpdate: [], connectionsToDelete: [], taskUpdateFieldsById: { [task.id]: ['content'] }, hasChanges: true, totalChanges: 1 });
    const result = h.service.save({ ...project, tasks: [task] }, owner);
    await Promise.resolve(); await Promise.resolve();
    const payload = h.enqueueDurablyForOwner.mock.calls[0]?.[1]?.payload as Record<string, unknown>;
    expect(payload['writePlan']).toMatchObject({ taskUpsertIds: [], taskWriteIntents: {} });
    h.resolveDurable('durable'); await result;
  });

  it('persists delete IDs and their exact CAS baselines with the durable write plan', async () => {
    const changes = { tasksToCreate: [], tasksToUpdate: [], taskIdsToDelete: ['deleted-task'], taskDeleteBaseUpdatedAtMap: { 'deleted-task': '2026-11-27T00:00:00.123456Z' }, connectionsToCreate: [], connectionsToUpdate: [], connectionsToDelete: [], taskUpdateFieldsById: {}, hasChanges: true, totalChanges: 1 };
    const h = harness([], changes);
    const result = h.service.save(project, owner);
    await Promise.resolve(); await Promise.resolve();
    const action = h.enqueueDurablyForOwner.mock.calls[0]?.[1];
    expect(action?.payload.taskIdsToDelete).toEqual(['deleted-task']);
    expect(action?.payload.taskDeleteBaseUpdatedAtMap).toEqual({ 'deleted-task': '2026-11-27T00:00:00.123456Z' });
    expect(action?.payload.writePlan.taskDeleteIds).toEqual(['deleted-task']);
    h.resolveDurable('durable'); await result;
  });

});
