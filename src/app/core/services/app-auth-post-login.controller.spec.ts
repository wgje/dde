import { describe, expect, it, vi } from 'vitest';
import {
  AppAuthPostLoginController,
  type AppAuthPostLoginControllerOptions,
} from './app-auth-post-login.controller';

function createOptions(
  overrides: Partial<AppAuthPostLoginControllerOptions> = {},
): AppAuthPostLoginControllerOptions {
  return {
    storeCurrentUserId: vi.fn(),
    loadPostAuthUserData: vi.fn().mockResolvedValue(undefined),
    isAuthSubmissionCurrent: vi.fn(() => true),
    showLoginSuccess: vi.fn(),
    nextMigrationGeneration: vi.fn(() => 1),
    setReloginMode: vi.fn(),
    finishSuccessfulLogin: vi.fn(),
    currentMigrationGeneration: vi.fn(() => 1),
    currentUserId: vi.fn(() => 'user-1'),
    localModeUserId: 'local-user',
    getMigrationService: vi.fn().mockResolvedValue({
      checkMigrationNeeded: vi.fn(() => false),
    }),
    getProjectDataService: vi.fn().mockResolvedValue({
      loadProjectListMetadataFromCloud: vi.fn().mockResolvedValue([]),
    }),
    warn: vi.fn(),
    showMigrationModal: vi.fn(),
    ...overrides,
  };
}

describe('AppAuthPostLoginController', () => {
  it('completes the current login before scheduling migration inspection', async () => {
    vi.useFakeTimers();
    const options = createOptions();
    const controller = new AppAuthPostLoginController(options);

    try {
      await controller.initializeSuccessfulLoginSession('user-1', null, 7, {
        closeSettings: true,
      });

      expect(options.isAuthSubmissionCurrent).toHaveBeenNthCalledWith(1, 7, [null, 'user-1']);
      expect(options.storeCurrentUserId).toHaveBeenCalledWith('user-1');
      expect(options.loadPostAuthUserData).toHaveBeenCalledWith('user-1', null);
      expect(options.isAuthSubmissionCurrent).toHaveBeenNthCalledWith(2, 7, [null, 'user-1']);
      expect(options.showLoginSuccess).toHaveBeenCalledOnce();
      expect(options.setReloginMode).toHaveBeenCalledWith(false);
      expect(options.finishSuccessfulLogin).toHaveBeenCalledWith('user-1', {
        closeSettings: true,
      });

      await vi.runAllTimersAsync();
      expect(options.getMigrationService).toHaveBeenCalledOnce();
      expect(options.getProjectDataService).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not persist an owner or start loading when the login submission is already stale', async () => {
    const options = createOptions({
      isAuthSubmissionCurrent: vi.fn(() => false),
    });
    const controller = new AppAuthPostLoginController(options);

    await controller.initializeSuccessfulLoginSession('user-1', 'old-user', 7);

    expect(options.storeCurrentUserId).not.toHaveBeenCalled();
    expect(options.loadPostAuthUserData).not.toHaveBeenCalled();
    expect(options.showLoginSuccess).not.toHaveBeenCalled();
    expect(options.nextMigrationGeneration).not.toHaveBeenCalled();
    expect(options.setReloginMode).not.toHaveBeenCalled();
    expect(options.finishSuccessfulLogin).not.toHaveBeenCalled();
  });

  it('stops after post-auth loading when the login submission becomes stale', async () => {
    const options = createOptions({
      isAuthSubmissionCurrent: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
    });
    const controller = new AppAuthPostLoginController(options);

    await controller.initializeSuccessfulLoginSession('user-1', 'old-user', 7);

    expect(options.storeCurrentUserId).toHaveBeenCalledWith('user-1');
    expect(options.loadPostAuthUserData).toHaveBeenCalledWith('user-1', 'old-user');
    expect(options.showLoginSuccess).not.toHaveBeenCalled();
    expect(options.nextMigrationGeneration).not.toHaveBeenCalled();
    expect(options.setReloginMode).not.toHaveBeenCalled();
    expect(options.finishSuccessfulLogin).not.toHaveBeenCalled();
  });

  it('retries migration inspection when currentUserId switches after the initial check', async () => {
    vi.useFakeTimers();
    let currentUserId: string | null = 'old-user';
    const remoteProjects = [{ id: 'proj-remote', syncSource: 'synced' as const }];
    const checkMigrationNeeded = vi.fn(() => true);
    const loadProjectListMetadataFromCloud = vi.fn().mockResolvedValue(remoteProjects);
    const options = createOptions({
      currentUserId: vi.fn(() => currentUserId),
      getMigrationService: vi.fn().mockResolvedValue({
        checkMigrationNeeded,
      }),
      getProjectDataService: vi.fn().mockResolvedValue({
        loadProjectListMetadataFromCloud,
      }),
    });
    const controller = new AppAuthPostLoginController(options);

    try {
      await controller.initializeSuccessfulLoginSession('user-1', 'old-user', 7);

      await vi.runOnlyPendingTimersAsync();
      expect(options.getMigrationService).not.toHaveBeenCalled();
      expect(options.getProjectDataService).not.toHaveBeenCalled();

      currentUserId = 'user-1';
      await vi.advanceTimersByTimeAsync(250);

      expect(options.getMigrationService).toHaveBeenCalledOnce();
      expect(options.getProjectDataService).toHaveBeenCalledOnce();
      expect(loadProjectListMetadataFromCloud).toHaveBeenCalledWith('user-1');
      expect(checkMigrationNeeded).toHaveBeenCalledWith(remoteProjects);
      expect(options.showMigrationModal).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('allows a later login to reschedule migration inspection after pending retries are cancelled', async () => {
    vi.useFakeTimers();
    let currentUserId: string | null = null;
    let currentMigrationGeneration = 0;
    const loadProjectListMetadataFromCloud = vi.fn().mockResolvedValue([]);
    const options = createOptions({
      currentUserId: vi.fn(() => currentUserId),
      nextMigrationGeneration: vi.fn(() => ++currentMigrationGeneration),
      currentMigrationGeneration: vi.fn(() => currentMigrationGeneration),
      getProjectDataService: vi.fn().mockResolvedValue({
        loadProjectListMetadataFromCloud,
      }),
    });
    const controller = new AppAuthPostLoginController(options);

    try {
      await controller.initializeSuccessfulLoginSession('user-1', null, 7);
      await vi.advanceTimersByTimeAsync(0);

      controller.cancelPendingMigrationCheck();
      await vi.advanceTimersByTimeAsync(1000);

      expect(options.getMigrationService).not.toHaveBeenCalled();
      expect(loadProjectListMetadataFromCloud).not.toHaveBeenCalled();

      vi.clearAllMocks();
      currentUserId = 'user-2';

      await controller.initializeSuccessfulLoginSession('user-2', null, 8);
      await vi.advanceTimersByTimeAsync(0);

      expect(options.getMigrationService).toHaveBeenCalledOnce();
      expect(options.getProjectDataService).toHaveBeenCalledOnce();
      expect(loadProjectListMetadataFromCloud).toHaveBeenCalledWith('user-2');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
