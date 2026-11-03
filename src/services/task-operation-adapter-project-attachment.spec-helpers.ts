import { expect, it, vi, type Mock } from 'vitest';

import type { Attachment, Project, Task } from '../models';
import type { TaskOperationAdapterService } from './task-operation-adapter.service';
import { getLocalBackupUiRestoreQuiescenceSentinelStorageKey } from './local-backup-ui-restore-writer-quiescence-tracker';
import { LocalBackupUiRestoreWriterQuiescenceService } from './local-backup-ui-restore-writer-quiescence.service';

export interface TaskOperationAdapterProjectAttachmentSpecContext {
  service(): TaskOperationAdapterService;
  createProject(overrides?: Partial<Project>): Project;
  createTask(overrides?: Partial<Task>): Task;
  getProjects(): Project[];
  setActiveProjectId(projectId: string | null): void;
  setProjects(projects: Project[]): void;
  mockChangeTrackerService(): { trackTaskUpdate: Mock };
  mockSyncCoordinatorService(): {
    markLocalChanges: Mock;
    schedulePersist: Mock;
    saveOfflineSnapshotAndWait: Mock;
  };
  mockActionQueueService(): { enqueueDurably: Mock };
}

export function registerTaskOperationAdapterProjectAttachmentSpecs(
  context: TaskOperationAdapterProjectAttachmentSpecContext,
): void {
  it('应先持久化附件 Outbox，再按 projectId 写入非当前项目附件', async () => {
    const placeholder: Attachment = {
      id: 'att-original',
      type: 'file',
      name: 'note.txt',
      url: '',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const uploaded: Attachment = {
      ...placeholder,
      url: 'https://example.com/uploaded-note.txt',
    };
    const activeProject = context.createProject({ id: 'active-project', tasks: [] });
    const targetTask = context.createTask({ id: 'target-task', attachments: [placeholder] });
    const targetProject = context.createProject({ id: 'target-project', tasks: [targetTask] });
    context.setProjects([activeProject, targetProject]);
    context.setActiveProjectId('active-project');

    let releaseDurable!: () => void;
    context.mockActionQueueService().enqueueDurably.mockReturnValueOnce(
      new Promise<string>(resolve => {
        releaseDurable = () => resolve('queued-attachment-update');
      }),
    );

    const completion = context.service().addTaskAttachmentToProject('target-project', 'target-task', uploaded);

    expect(context.mockActionQueueService().enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'task',
      entityId: 'target-task',
      payload: expect.objectContaining({
        projectId: 'target-project',
        task: expect.objectContaining({
          id: 'target-task',
          attachments: [expect.objectContaining({
            id: 'att-original',
            url: 'https://example.com/uploaded-note.txt',
          })],
        }),
      }),
    }));
    expect(context.getProjects().find(project => project.id === 'target-project')?.tasks[0]?.attachments?.[0]?.url)
      .toBe('');

    releaseDurable();
    const result = await completion;

    expect(result).toBe(true);
    const updatedTarget = context.getProjects().find(project => project.id === 'target-project');
    const updatedTask = updatedTarget?.tasks.find(task => task.id === 'target-task');
    expect(updatedTask?.attachments).toHaveLength(1);
    expect(updatedTask?.attachments?.[0]).toEqual(expect.objectContaining({
      id: 'att-original',
      url: 'https://example.com/uploaded-note.txt',
    }));
    expect(context.mockChangeTrackerService().trackTaskUpdate).toHaveBeenCalledWith(
      'target-project',
      expect.objectContaining({ id: 'target-task' }),
      ['attachments'],
    );
    expect(context.mockSyncCoordinatorService().markLocalChanges).toHaveBeenCalledWith('content');
    expect(context.mockSyncCoordinatorService().schedulePersist).toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'target-project',
          tasks: [expect.objectContaining({
            id: 'target-task',
            attachments: [expect.objectContaining({
              id: 'att-original',
              url: 'https://example.com/uploaded-note.txt',
            })],
          })],
        }),
      ]),
      'user-1',
    );
  });

  it('local-only 项目应先确认附件快照落盘，再提交跨项目附件 UI 更新', async () => {
    const attachment: Attachment = {
      id: 'att-durable',
      type: 'file',
      name: 'durable.txt',
      url: 'https://example.com/durable.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const targetTask = context.createTask({ id: 'target-task', attachments: [] });
    const targetProject = context.createProject({
      id: 'target-project',
      syncSource: 'local-only',
      tasks: [targetTask],
    });
    context.setProjects([targetProject]);
    context.setActiveProjectId('target-project');

    let releaseSnapshot!: () => void;
    context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait.mockReturnValueOnce(
      new Promise<void>(resolve => {
        releaseSnapshot = () => resolve();
      }),
    );

    const completion = context.service().addTaskAttachmentToProject(
      'target-project',
      'target-task',
      attachment,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(context.mockActionQueueService().enqueueDurably).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait).toHaveBeenCalled();
    expect(context.getProjects()[0]?.tasks[0]?.attachments ?? []).toEqual([]);
    expect(context.mockChangeTrackerService().trackTaskUpdate).not.toHaveBeenCalled();

    releaseSnapshot();
    await expect(completion).resolves.toBe(true);

    expect(context.getProjects()[0]?.tasks[0]?.attachments).toEqual([
      expect.objectContaining({ id: 'att-durable' }),
    ]);
    expect(context.mockChangeTrackerService().trackTaskUpdate).toHaveBeenCalledWith(
      'target-project',
      expect.objectContaining({ id: 'target-task' }),
      ['attachments'],
    );
  });

  it('云项目附件 Outbox 已持久化后，即时快照失败仍应提交 UI 并等待后台重试', async () => {
    const attachment: Attachment = {
      id: 'att-failed-snapshot',
      type: 'file',
      name: 'failed.txt',
      url: 'https://example.com/failed.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const targetTask = context.createTask({ id: 'target-task', attachments: [] });
    const targetProject = context.createProject({ id: 'target-project', tasks: [targetTask] });
    context.setProjects([targetProject]);
    context.setActiveProjectId('target-project');
    context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait
      .mockRejectedValueOnce(new Error('idb unavailable'));

    const result = await context.service().addTaskAttachmentToProject(
      'target-project',
      'target-task',
      attachment,
    );

    expect(result).toBe(true);
    expect(context.mockActionQueueService().enqueueDurably).toHaveBeenCalled();
    expect(context.getProjects()[0]?.tasks[0]?.attachments).toEqual([
      expect.objectContaining({ id: 'att-failed-snapshot' }),
    ]);
    expect(context.mockChangeTrackerService().trackTaskUpdate).toHaveBeenCalledWith(
      'target-project',
      expect.objectContaining({ id: 'target-task' }),
      ['attachments'],
    );
    expect(context.mockSyncCoordinatorService().markLocalChanges).toHaveBeenCalledWith('content');
    expect(context.mockSyncCoordinatorService().schedulePersist).toHaveBeenCalled();
  });

  it('local-only 项目附件快照落盘失败时仍不提交 UI 更新', async () => {
    const attachment: Attachment = {
      id: 'att-local-only-failed-snapshot',
      type: 'file',
      name: 'local-only-failed.txt',
      url: 'https://example.com/local-only-failed.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const targetTask = context.createTask({ id: 'target-task', attachments: [] });
    const targetProject = context.createProject({
      id: 'target-project',
      syncSource: 'local-only',
      tasks: [targetTask],
    });
    context.setProjects([targetProject]);
    context.setActiveProjectId('target-project');
    context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait
      .mockRejectedValueOnce(new Error('idb unavailable'));

    const result = await context.service().addTaskAttachmentToProject(
      'target-project',
      'target-task',
      attachment,
    );

    expect(result).toBe(false);
    expect(context.mockActionQueueService().enqueueDurably).not.toHaveBeenCalled();
    expect(context.getProjects()[0]?.tasks[0]?.attachments ?? []).toEqual([]);
    expect(context.mockChangeTrackerService().trackTaskUpdate).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().markLocalChanges).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().schedulePersist).not.toHaveBeenCalled();
  });

  it('restore preparation waits for the local attachment snapshot and state commit', async () => {
    const ownerUserId = 'user-1';
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId);
    localStorage.removeItem(sentinelKey);
    const quiescenceService = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    let releaseSnapshot: () => void = () => undefined;
    const snapshotWrite = new Promise<void>(resolve => {
      releaseSnapshot = resolve;
    });
    const attachment: Attachment = {
      id: 'att-restore-writer',
      type: 'file',
      name: 'restore-writer.txt',
      url: 'https://example.com/restore-writer.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const targetTask = context.createTask({ id: 'task-restore-writer', attachments: [] });
    context.setProjects([context.createProject({
      id: 'project-restore-writer',
      syncSource: 'local-only',
      tasks: [targetTask],
    })]);
    context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait.mockImplementationOnce(
      () => snapshotWrite,
    );
    let preparedState: Awaited<ReturnType<typeof quiescenceService.prepare>> | null = null;
    let completion: Promise<boolean> | null = null;
    let preparing: ReturnType<typeof quiescenceService.prepare> | null = null;
    let restorePrepared = false;

    try {
      completion = context.service().addTaskAttachmentToProject(
        'project-restore-writer',
        'task-restore-writer',
        attachment,
      );
      await vi.waitFor(() => expect(
        context.mockSyncCoordinatorService().saveOfflineSnapshotAndWait,
      ).toHaveBeenCalledOnce());

      preparing = quiescenceService.prepare(ownerUserId).then(handle => {
        restorePrepared = true;
        return handle;
      });
      await vi.waitFor(() => expect(localStorage.getItem(sentinelKey)).not.toBeNull());
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(restorePrepared).toBe(false);
      expect(context.getProjects()[0]?.tasks[0]?.attachments ?? []).toEqual([]);

      releaseSnapshot();
      await expect(completion).resolves.toBe(true);
      expect(context.getProjects()[0]?.tasks[0]?.attachments).toEqual([
        expect.objectContaining({ id: 'att-restore-writer' }),
      ]);
      preparedState = await preparing;
      expect(restorePrepared).toBe(true);
    } finally {
      releaseSnapshot();
      await completion?.catch(() => false);
      if (preparing && !preparedState) preparedState = await preparing.catch(() => null);
      await preparedState?.abortBeforeMutation();
    }
  }, 10000);

  it('project-scoped 附件写入找不到任务时应返回 false 且不触发同步', async () => {
    context.setProjects([context.createProject({ id: 'target-project', tasks: [] })]);
    context.setActiveProjectId('target-project');

    const result = await context.service().addTaskAttachmentToProject('target-project', 'missing-task', {
      id: 'att-1',
      type: 'file',
      name: 'note.txt',
      url: 'https://example.com/note.txt',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    expect(result).toBe(false);
    expect(context.mockChangeTrackerService().trackTaskUpdate).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().schedulePersist).not.toHaveBeenCalled();
  });

  it('附件 Outbox 持久化失败时不提交项目 UI 更新', async () => {
    const attachment: Attachment = {
      id: 'att-1',
      type: 'file',
      name: 'note.txt',
      url: 'https://example.com/note.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const targetTask = context.createTask({ id: 'target-task', attachments: [] });
    const targetProject = context.createProject({ id: 'target-project', tasks: [targetTask] });
    context.setProjects([targetProject]);
    context.setActiveProjectId('target-project');
    context.mockActionQueueService().enqueueDurably.mockResolvedValueOnce('');

    const result = await context.service().addTaskAttachmentToProject('target-project', 'target-task', attachment);

    expect(result).toBe(false);
    expect(context.getProjects()[0]?.tasks[0]?.attachments ?? []).toEqual([]);
    expect(context.mockChangeTrackerService().trackTaskUpdate).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().schedulePersist).not.toHaveBeenCalled();
  });
}
