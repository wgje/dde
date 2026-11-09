import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectConflictCaptureService } from './project-conflict-capture.service';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { createProject } from './project-operation.test-harness';

describe('ProjectConflictCaptureService owner/Auth fence', () => {
  const identity = { ownerUserId: 'owner-a', generation: 4, authFence: 'fence-a' };
  const coordinator = {
    loadSingleProjectFromCloud: vi.fn(), captureConflict: vi.fn(),
    clearActiveConflict: vi.fn(),
  };
  const conflictStorage = { saveConflict: vi.fn() };
  const auth = {
    currentUserId: vi.fn((): string | null => identity.ownerUserId),
    captureAuthIdentityFence: vi.fn(() => identity.authFence),
  };
  const session = {
    currentUserId: vi.fn(() => identity.ownerUserId),
    getCurrentSessionGeneration: vi.fn(() => identity.generation),
    isSessionContextCurrent: vi.fn((generation: number, ownerUserId: string) =>
      generation === identity.generation && ownerUserId === identity.ownerUserId),
  };
  let service: ProjectConflictCaptureService;

  beforeEach(() => {
    vi.clearAllMocks();
    identity.ownerUserId = 'owner-a';
    identity.generation = 4;
    identity.authFence = 'fence-a';
    conflictStorage.saveConflict.mockResolvedValue(true);
    coordinator.captureConflict.mockResolvedValue(undefined);
    const injector = Injector.create({ providers: [
      ProjectConflictCaptureService,
      { provide: SyncCoordinatorService, useValue: coordinator },
      { provide: ConflictStorageService, useValue: conflictStorage },
      { provide: AuthService, useValue: auth },
      { provide: UserSessionService, useValue: session },
      { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn() }) } },
    ] });
    service = runInInjectionContext(injector, () => injector.get(ProjectConflictCaptureService));
  });

  it('same-owner relogin during remote load suppresses conflict save', async () => {
    const remote = deferred<ReturnType<typeof createProject> | null>();
    coordinator.loadSingleProjectFromCloud.mockReturnValueOnce(remote.promise);
    const localProject = createProject({ id: 'project-auth-load' });
    const context = { ownerUserId: 'owner-a', sessionGeneration: 4, authFence: 'fence-a' };

    const resultPromise = service.tryLoadRemoteConflictProject(localProject.id, localProject, context);
    identity.authFence = 'fence-b';
    remote.resolve(createProject({ id: localProject.id, version: 8 }));

    await expect(resultPromise).resolves.toBeUndefined();
    expect(conflictStorage.saveConflict).not.toHaveBeenCalled();
  });

  it('same-owner relogin during fallback save suppresses active-conflict clear', async () => {
    const save = deferred<boolean>();
    conflictStorage.saveConflict.mockReturnValueOnce(save.promise);
    coordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);
    const localProject = createProject({ id: 'project-auth-fallback' });
    const context = { ownerUserId: 'owner-a', sessionGeneration: 4, authFence: 'fence-a' };

    const resultPromise = service.captureConflictWithRemoteFallback(
      localProject, undefined, undefined, context,
    );
    await vi.waitFor(() => expect(conflictStorage.saveConflict).toHaveBeenCalledOnce());
    identity.authFence = 'fence-b';
    save.resolve(true);

    await expect(resultPromise).resolves.toBe(false);
    expect(coordinator.clearActiveConflict).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
