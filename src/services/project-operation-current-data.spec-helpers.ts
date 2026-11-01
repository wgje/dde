import { expect, it } from 'vitest';

import type { Connection, Project, Task } from '../models';
import {
  createProject,
  type ProjectOperationServiceSpecContext,
} from './project-operation.test-harness';

export type ProjectOperationCurrentDataSpecContext = Pick<
  ProjectOperationServiceSpecContext,
  'service' | 'mockProjectState' | 'mockSyncCoordinator' | 'mockUserSession' | 'mockActionQueue'
>;

function createAuthoritativeProject(
  projectId: string,
  overrides: Partial<Project> = {},
): Project {
  const now = '2026-07-17T00:00:00.000Z';
  const primaryTask: Task = {
    id: `${projectId}-task-1`,
    title: 'Must survive',
    content: 'must survive',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: now,
    updatedAt: now,
    displayId: '1',
    attachments: [],
  };
  const linkedTask: Task = {
    id: `${projectId}-task-2`,
    title: 'Linked task',
    content: 'still linked',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 2,
    status: 'active',
    x: 120,
    y: 0,
    createdDate: now,
    updatedAt: now,
    displayId: '2',
    attachments: [],
  };
  const connection: Connection = {
    id: `${projectId}-conn-1`,
    source: primaryTask.id,
    target: linkedTask.id,
    title: 'Must survive link',
    updatedAt: now,
  };

  return createProject({
    id: projectId,
    name: `${projectId} name`,
    updatedAt: now,
    tasks: [primaryTask, linkedTask],
    connections: [connection],
    ...overrides,
  });
}

function createMetadataShell(project: Project, overrides: Partial<Project> = {}): Project {
  return createProject({
    ...project,
    tasks: [],
    connections: [],
    ...overrides,
  });
}

export function configureProjectStateData(
  mockProjectState: ProjectOperationCurrentDataSpecContext['mockProjectState'],
  shellProjects: Project[],
  currentProjects: Project[] | Project[][] = shellProjects,
  options: { legacyProjects?: Project[] } = {},
): void {
  const currentProjectSnapshots = Array.isArray((currentProjects as unknown[])[0])
    ? currentProjects as Project[][]
    : [currentProjects as Project[]];
  const legacyProjects = options.legacyProjects;

  mockProjectState.projects.mockReturnValue(shellProjects);
  let currentProjectsCallCount = 0;
  mockProjectState.getProjectsWithCurrentData.mockImplementation(() => {
    const index = Math.min(currentProjectsCallCount, currentProjectSnapshots.length - 1);
    currentProjectsCallCount += 1;
    return currentProjectSnapshots[index] ?? currentProjectSnapshots.at(-1) ?? [];
  });
  mockProjectState.getProjectWithCurrentData.mockImplementation((projectId: string) => {
    const index = Math.min(currentProjectsCallCount, currentProjectSnapshots.length - 1);
    const projects = currentProjectSnapshots[index] ?? currentProjectSnapshots.at(-1) ?? [];
    return projects.find(project => project.id === projectId);
  });
  if (legacyProjects) {
    mockProjectState.getProject.mockImplementation((projectId: string) =>
      legacyProjects.find(project => project.id === projectId));
  }
}

export function registerProjectOperationCurrentDataSpecs(
  getContext: () => ProjectOperationCurrentDataSpecContext,
): void {
  it('认证用户重命名项目在 metadata shell 基线上应保留 current tasks/connections', async () => {
    const {
      service,
      mockActionQueue,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = getContext();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    const currentProject = createAuthoritativeProject('proj-shell-rename', { syncSource: 'synced' });
    const renamedCurrentProject = createProject({
      ...currentProject,
      name: 'Renamed Project',
      syncSource: 'synced',
      pendingSync: true,
    });

    configureProjectStateData(
      mockProjectState,
      [createMetadataShell(currentProject)],
      [[currentProject], [currentProject], [renamedCurrentProject]],
    );

    const result = await service.renameProject(currentProject.id, 'Renamed Project');

    expect(result).toBe(true);
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: currentProject.id,
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: renamedCurrentProject.id,
          name: 'Renamed Project',
          tasks: renamedCurrentProject.tasks,
          connections: renamedCurrentProject.connections,
          pendingSync: true,
          syncSource: 'synced',
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: renamedCurrentProject.id,
        name: 'Renamed Project',
        tasks: renamedCurrentProject.tasks,
        connections: renamedCurrentProject.connections,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: renamedCurrentProject.id,
        name: 'Renamed Project',
        tasks: renamedCurrentProject.tasks,
        connections: renamedCurrentProject.connections,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it.each([
    {
      name: '更新项目元数据',
      invoke: (context: ProjectOperationCurrentDataSpecContext, projectId: string) =>
        context.service.updateProjectMetadata(projectId, { description: 'updated description' }),
      updatedProject: (project: Project) => createProject({
        ...project,
        description: 'updated description',
        syncSource: 'synced',
        pendingSync: true,
      }),
    },
    {
      name: '更新流程图 URL',
      invoke: (context: ProjectOperationCurrentDataSpecContext, projectId: string) =>
        context.service.updateProjectFlowchartUrl(
          projectId,
          'https://flow.example/full.png',
          'https://flow.example/thumb.png',
        ),
      updatedProject: (project: Project) => createProject({
        ...project,
        flowchartUrl: 'https://flow.example/full.png',
        flowchartThumbnailUrl: 'https://flow.example/thumb.png',
        syncSource: 'synced',
        pendingSync: true,
      }),
    },
  ])('认证用户%s在 metadata shell 基线上应保留 current tasks/connections', async ({
    invoke,
    updatedProject,
  }) => {
    const context = getContext();
    const {
      mockActionQueue,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = context;
    mockUserSession.currentUserId.mockReturnValue('user-1');
    const currentProject = createAuthoritativeProject('proj-shell-update', { syncSource: 'synced' });
    const expectedProject = updatedProject(currentProject);

    configureProjectStateData(
      mockProjectState,
      [createMetadataShell(currentProject)],
      [[currentProject], [currentProject], [expectedProject]],
    );

    const result = await invoke(context, currentProject.id);

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: currentProject.id,
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: expectedProject.id,
          tasks: expectedProject.tasks,
          connections: expectedProject.connections,
          pendingSync: true,
          syncSource: 'synced',
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: expectedProject.id,
        tasks: expectedProject.tasks,
        connections: expectedProject.connections,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: expectedProject.id,
        tasks: expectedProject.tasks,
        connections: expectedProject.connections,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it('认证用户新增项目时应从 current data 而非 metadata shell 生成快照与 finalize payload', async () => {
    const {
      service,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = getContext();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    const retainedProject = createAuthoritativeProject('proj-add-retained', { syncSource: 'synced' });
    const newProject = createProject({ id: 'proj-add-new', name: 'Added Project' });
    const expectedLocalProject = createProject({
      ...newProject,
      syncSource: 'synced',
      pendingSync: true,
    });

    configureProjectStateData(
      mockProjectState,
      [createMetadataShell(retainedProject)],
      [[retainedProject], [retainedProject], [retainedProject, expectedLocalProject]],
    );

    const result = await service.addProject(newProject);

    expect(result).toEqual({ success: true });
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: expectedLocalProject.id,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: expectedLocalProject.id,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it('认证用户删除项目时应从 current data 保留 remaining project，并使用 current baseUpdatedAt', async () => {
    const {
      service,
      mockActionQueue,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = getContext();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    const retainedProject = createAuthoritativeProject('proj-delete-retained', { syncSource: 'synced' });
    const projectToDelete = createAuthoritativeProject('proj-delete-target', {
      syncSource: 'synced',
      updatedAt: '2026-07-17T09:15:00.000Z',
    });
    const deleteShell = createMetadataShell(projectToDelete, {
      updatedAt: '2000-01-01T00:00:00.000Z',
    });

    configureProjectStateData(
      mockProjectState,
      [createMetadataShell(retainedProject), deleteShell],
      [
        [retainedProject, projectToDelete],
        [retainedProject, projectToDelete],
        [retainedProject],
      ],
    );

    const result = await service.deleteProject(projectToDelete.id);

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'delete',
      entityType: 'project',
      entityId: projectToDelete.id,
      payload: expect.objectContaining({
        baseUpdatedAt: '2026-07-17T09:15:00.000Z',
      }),
    }));
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
    ]);
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
    ]);
  });

  it.each([
    {
      name: '导入新项目',
      existingProjects: () => [] as Project[],
      importedProject: createAuthoritativeProject('proj-import-new-shell', { name: 'Imported New' }),
      expectedQueueType: 'create' as const,
    },
    {
      name: '替换现有导入项目',
      existingProjects: () => [createAuthoritativeProject('proj-import-existing-shell', { name: 'Existing Current' })],
      importedProject: createAuthoritativeProject('proj-import-existing-shell', { name: 'Imported Replacement' }),
      expectedQueueType: 'update' as const,
    },
  ])('认证用户%s时应保留 current data baseline 与 imported payload', async ({
    existingProjects,
    importedProject,
    expectedQueueType,
  }) => {
    const {
      service,
      mockActionQueue,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = getContext();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    const retainedProject = createAuthoritativeProject('proj-import-retained', { syncSource: 'synced' });
    const existingImportedProjects = existingProjects();
    const shellProjects = [
      createMetadataShell(retainedProject),
      ...existingImportedProjects.map(project => createMetadataShell(project)),
    ];
    const expectedImportedLocalProject = createProject({
      ...importedProject,
      syncSource: 'synced',
      pendingSync: true,
    });

    configureProjectStateData(
      mockProjectState,
      shellProjects,
      [
        [retainedProject, ...existingImportedProjects],
        [retainedProject, ...existingImportedProjects],
        [retainedProject, expectedImportedLocalProject],
      ],
    );

    const result = await service.upsertImportedProject(importedProject);

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: expectedQueueType,
      entityType: 'project',
      entityId: importedProject.id,
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: expectedImportedLocalProject.id,
          tasks: expectedImportedLocalProject.tasks,
          connections: expectedImportedLocalProject.connections,
          pendingSync: true,
          syncSource: 'synced',
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: expectedImportedLocalProject.id,
        tasks: expectedImportedLocalProject.tasks,
        connections: expectedImportedLocalProject.connections,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: expectedImportedLocalProject.id,
        tasks: expectedImportedLocalProject.tasks,
        connections: expectedImportedLocalProject.connections,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it('本地模式导入项目时应从 current data 而非 metadata shell 生成 snapshot 与 finalize payload', async () => {
    const {
      service,
      mockProjectState,
      mockSyncCoordinator,
    } = getContext();
    const retainedProject = createAuthoritativeProject('proj-import-local-retained');
    const importedProject = createAuthoritativeProject('proj-import-local-shell', { name: 'Imported Local' });
    const expectedImportedProject = createProject({
      ...importedProject,
      syncSource: 'local-only',
      pendingSync: false,
    });

    configureProjectStateData(
      mockProjectState,
      [createMetadataShell(retainedProject)],
      [
        [retainedProject],
        [retainedProject],
        [retainedProject, expectedImportedProject],
      ],
    );

    const result = await service.upsertImportedProject(importedProject);

    expect(result).toEqual({ success: true });
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: expectedImportedProject.id,
        tasks: expectedImportedProject.tasks,
        connections: expectedImportedProject.connections,
        syncSource: 'local-only',
        pendingSync: false,
      }),
    ]);
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: expectedImportedProject.id,
        tasks: expectedImportedProject.tasks,
        connections: expectedImportedProject.connections,
        syncSource: 'local-only',
        pendingSync: false,
      }),
    ]);
  });

  it('认证用户导入项目队列写入失败时应按 current data 回写离线快照，而不是 shell 列表', async () => {
    const {
      service,
      mockActionQueue,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = getContext();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    const retainedProject = createAuthoritativeProject('proj-import-failure-retained', { syncSource: 'synced' });
    const existingProject = createAuthoritativeProject('proj-import-failure-existing', { syncSource: 'synced' });
    const importedProject = createAuthoritativeProject('proj-import-failure-existing', { name: 'Imported Failed' });

    configureProjectStateData(
      mockProjectState,
      [createMetadataShell(retainedProject), createMetadataShell(existingProject)],
      [[retainedProject, existingProject]],
    );
    mockActionQueue.enqueueDurably.mockResolvedValueOnce('');

    const result = await service.upsertImportedProject(importedProject);

    expect(result).toEqual({ success: false, error: '离线导入队列未能写入' });
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({
        id: retainedProject.id,
        tasks: retainedProject.tasks,
        connections: retainedProject.connections,
      }),
      expect.objectContaining({
        id: existingProject.id,
        tasks: existingProject.tasks,
        connections: existingProject.connections,
      }),
    ]);
  });
}
