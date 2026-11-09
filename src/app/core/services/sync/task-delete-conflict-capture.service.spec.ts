import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ProjectDataService } from './project-data.service';
import { TaskDeleteConflictCaptureService } from './task-delete-conflict-capture.service';

describe('TaskDeleteConflictCaptureService', () => {
  const localProject = {
    id: 'project-1',
    name: 'Local',
    description: '',
    createdDate: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T01:00:00.000Z',
    version: 3,
    tasks: [
      {
        id: 'task-current',
        title: 'Current task',
        content: 'Current task content',
        stage: null,
        parentId: null,
        order: 0,
        rank: 0,
        status: 'active' as const,
        x: 0,
        y: 0,
        createdDate: '2026-06-15T00:00:00.000Z',
        displayId: 'T1',
      },
      {
        id: 'task-peer',
        title: 'Peer task',
        content: 'Peer task content',
        stage: null,
        parentId: null,
        order: 1,
        rank: 1,
        status: 'active' as const,
        x: 100,
        y: 0,
        createdDate: '2026-06-15T00:00:00.000Z',
        displayId: 'T2',
      },
    ],
    connections: [{ id: 'connection-current', source: 'task-current', target: 'task-peer' }],
  };
  const staleProject = {
    ...localProject,
    tasks: [{ ...localProject.tasks[0], content: 'Stale shell content' }],
    connections: [],
  };
  const remoteProject = {
    ...localProject,
    name: 'Remote',
    version: 4,
    updatedAt: '2026-06-15T04:00:00.000Z',
    tasks: [{ id: 'task-1', updatedAt: '2026-06-15T03:00:00.000Z' }],
  };
  const saveConflict = vi.fn(async () => true);
  const loadFullProjectOptimized = vi.fn(async () => remoteProject);
  const getProject = vi.fn(() => staleProject);
  const getProjectWithCurrentData = vi.fn(() => localProject);

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        TaskDeleteConflictCaptureService,
        {
          provide: ProjectStateService,
          useValue: { getProject, getProjectWithCurrentData },
        },
        { provide: ProjectDataService, useValue: { loadFullProjectOptimized } },
        { provide: ConflictStorageService, useValue: { saveConflict } },
        { provide: LoggerService, useValue: { category: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() })) } },
      ],
    });
  });

  it('persists only the conflicted delete subset with a refreshed remote baseline', async () => {
    const service = TestBed.inject(TaskDeleteConflictCaptureService);

    await expect(service.capture({
      projectId: 'project-1',
      taskIds: ['task-1'],
      sourceUserId: 'user-1',
      baseUpdatedAtMap: { 'task-1': '2026-06-15T01:00:00.000Z' },
    })).resolves.toBe(true);

    expect(saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      ownerUserId: 'user-1',
      localProject,
      remoteProject,
      remoteSnapshotFresh: true,
      pendingTaskDeleteIds: ['task-1'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-1': '2026-06-15T03:00:00.000Z',
      },
      acknowledged: false,
    }));
    expect(getProjectWithCurrentData).toHaveBeenCalledWith('project-1');
    expect(getProject).not.toHaveBeenCalled();
  });

  it('uses RPC remoteUpdatedAt when the remote task is already a tombstone', async () => {
    loadFullProjectOptimized.mockResolvedValueOnce({ ...remoteProject, tasks: [] });
    const service = TestBed.inject(TaskDeleteConflictCaptureService);

    await service.capture({
      projectId: 'project-1',
      taskIds: ['task-1'],
      sourceUserId: 'user-1',
      baseUpdatedAtMap: { 'task-1': '2026-06-15T01:00:00.000Z' },
      remoteUpdatedAt: '2026-06-15T05:00:00.000Z',
    });

    expect(saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-1': '2026-06-15T05:00:00.000Z',
      },
    }));
  });
});
