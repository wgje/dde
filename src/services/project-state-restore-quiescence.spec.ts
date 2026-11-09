import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../models';
import { AUTH_CONFIG } from '../config/auth.config';
import { ConnectionStore, ProjectStore, TaskStore } from '../app/core/state/stores';
import { LayoutService } from './layout.service';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  LocalBackupUiRestoreWriterPausedError,
  LocalBackupUiRestoreWriterQuiescenceService,
  localBackupUiRestoreWriterQuiescence,
} from './local-backup-ui-restore-writer-quiescence.service';
import { runWithLocalBackupUiRestoreWriterAuthorization } from './local-backup-ui-restore-writer-quiescence-tracker';
import { AuthService } from './auth.service';
import { ProjectStateService } from './project-state.service';
import { UiStateService } from './ui-state.service';

const RESTORE_RUN_ID = '11111111-1111-4111-8111-111111111111';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: 'body',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-11-03T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  };
}

function makeProject(task: Task, overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-11-03T00:00:00.000Z',
    tasks: [task],
    connections: [],
    ...overrides,
  };
}

function createProjectState(currentUserId: string = AUTH_CONFIG.LOCAL_MODE_USER_ID): ProjectStateService {
  const injector = Injector.create({
    providers: [
      { provide: AuthService, useValue: { currentUserId: () => currentUserId } },
      { provide: TaskStore, useValue: new TaskStore() },
      { provide: ProjectStore, useValue: new ProjectStore() },
      { provide: ConnectionStore, useValue: new ConnectionStore() },
      { provide: LayoutService, useValue: {} },
      { provide: UiStateService, useValue: { filterMode: () => 'all' } },
    ],
  });
  return runInInjectionContext(injector, () => new ProjectStateService());
}

describe('ProjectStateService restore quiescence', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('blocks owner project and entity mutations until their restore source is authorized', () => {
    const ownerUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const service = createProjectState();
    const currentTask = makeTask();
    service.setProjects([makeProject(currentTask)]);
    service.setActiveProjectId('project-1');
    localStorage.setItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId),
      JSON.stringify({ ownerUserId, runId: RESTORE_RUN_ID, state: 'quiesced' }),
    );
    const nextTask = makeTask({ content: 'concurrent edit' });

    expect(() => service.updateTask(nextTask, 'project-1'))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.updateProjects(projects => projects.map(project => ({
      ...project,
      name: 'concurrent rename',
    })))).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.setProjectsMetadataOnly([makeProject(currentTask, { name: 'metadata' })]))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.setActiveProjectId(null)).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.clearData()).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(service.getTask('task-1')?.content).toBe('body');
    expect(service.projects()[0]?.name).toBe('Project');
    expect(service.activeProjectId()).toBe('project-1');

    runWithLocalBackupUiRestoreWriterAuthorization(
      ownerUserId,
      RESTORE_RUN_ID,
      'external-source',
      () => expect(() => service.setProjects([makeProject(nextTask, { name: 'wrong source' })]))
        .toThrow(LocalBackupUiRestoreWriterPausedError),
    );
    expect(service.getTask('task-1')?.content).toBe('body');

    runWithLocalBackupUiRestoreWriterAuthorization(
      ownerUserId,
      RESTORE_RUN_ID,
      'project-state',
      () => service.setProjects([makeProject(nextTask, { name: 'restored' })]),
    );
    expect(service.getTask('task-1')?.content).toBe('concurrent edit');
    expect(service.projects()[0]?.name).toBe('restored');
  });

  it('lets a project-state writer already active before pausing finish before quiescence', async () => {
    const ownerUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const service = createProjectState();
    service.setProjects([makeProject(makeTask())]);
    let releaseWrite = (): void => undefined;
    let markWriteStarted = (): void => undefined;
    const writeStarted = new Promise<void>(resolve => {
      markWriteStarted = resolve;
    });
    const heldWrite = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    const quiescenceService = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    let prepared: Awaited<ReturnType<typeof quiescenceService.prepare>> | null = null;
    let writer: Promise<void> | null = null;
    let prepare: ReturnType<typeof quiescenceService.prepare> | null = null;

    try {
      writer = localBackupUiRestoreWriterQuiescence.runAsync(ownerUserId, 'project-state', async continuation => {
        markWriteStarted();
        await heldWrite;
        service.updateProjects(
          projects => projects.map(project => ({ ...project, name: 'finished' })),
          undefined,
          continuation,
        );
      });
      await writeStarted;
      prepare = quiescenceService.prepare(ownerUserId);
      const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId);
      await vi.waitFor(() => expect(localStorage.getItem(sentinelKey)).not.toBeNull());

      expect(() => service.updateProjects(projects => projects.map(project => ({
        ...project,
        name: 'unrelated same-owner write',
      })))).toThrow(LocalBackupUiRestoreWriterPausedError);
      expect(service.projects()[0]?.name).toBe('Project');

      releaseWrite();
      await writer;
      prepared = await prepare;

      expect(service.projects()[0]?.name).toBe('finished');
      expect(() => service.updateProjects(projects => projects.map(project => ({
        ...project,
        name: 'too late',
      })))).toThrow(LocalBackupUiRestoreWriterPausedError);
    } finally {
      releaseWrite();
      await writer?.catch(() => undefined);
      if (prepare && !prepared) prepared = await prepare.catch(() => null);
      await prepared?.abortBeforeMutation();
    }
  }, 10000);

  it('fails closed when the restore marker owner differs from the authenticated ProjectState owner', () => {
    const transactionOwner = 'restore-owner-a';
    const service = createProjectState('authenticated-owner-b');
    const currentTask = makeTask();
    service.setProjects([makeProject(currentTask)]);
    localStorage.setItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(transactionOwner),
      JSON.stringify({ ownerUserId: transactionOwner, runId: RESTORE_RUN_ID, state: 'quiesced' }),
    );

    expect(() => runWithLocalBackupUiRestoreWriterAuthorization(
      transactionOwner,
      RESTORE_RUN_ID,
      'project-state',
      () => service.replaceProjectsForRestore(
        transactionOwner,
        [makeProject(makeTask({ content: 'wrong owner write' }), { name: 'foreign' })],
      ),
    )).toThrow('project state write owner does not match the authenticated owner');

    expect(service.projects()[0]?.name).toBe('Project');
    expect(service.getTask('task-1')?.content).toBe('body');
  });
});
