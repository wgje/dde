import { describe, expect, it, vi } from 'vitest';
import { applyStartupVersionAction, decideStartupVersionAction } from './startup-version-policy';

describe('decideStartupVersionAction', () => {
  it('should persist current version on first launch without forcing reload', () => {
    const result = decideStartupVersionAction({
      storedVersion: null,
      currentVersion: 'build-b',
      forceClear: false,
    });

    expect(result).toEqual({
      kind: 'store-current-version',
      reason: 'first-launch',
      shouldPersistCurrentVersion: true,
    });
  });

  it('should record version advance without destructive recovery', () => {
    const result = decideStartupVersionAction({
      storedVersion: 'build-a',
      currentVersion: 'build-b',
      forceClear: false,
    });

    expect(result).toEqual({
      kind: 'store-current-version',
      reason: 'version-advanced',
      shouldPersistCurrentVersion: true,
    });
  });

  it('should only clear caches when force clear is explicitly requested', () => {
    const result = decideStartupVersionAction({
      storedVersion: 'build-a',
      currentVersion: 'build-b',
      forceClear: true,
    });

    expect(result).toEqual({
      kind: 'clear-cache-and-reload',
      reason: 'force-clear',
      shouldPersistCurrentVersion: true,
    });
  });

  it('should noop when stored version already matches current build', () => {
    const result = decideStartupVersionAction({
      storedVersion: 'build-a',
      currentVersion: 'build-a',
      forceClear: false,
    });

    expect(result).toEqual({
      kind: 'noop',
      reason: 'up-to-date',
      shouldPersistCurrentVersion: false,
    });
  });

  it('should keep version advance side effects non-destructive', async () => {
    const action = decideStartupVersionAction({
      storedVersion: 'build-a',
      currentVersion: 'build-b',
      forceClear: false,
    });

    const hooks = {
      persistCurrentVersion: vi.fn(),
      clearForceClearFlag: vi.fn(),
      clearRecoveryStorage: vi.fn(),
      clearCaches: vi.fn(async () => undefined),
      unregisterServiceWorkers: vi.fn(async () => undefined),
      reloadCurrentLocation: vi.fn(),
      onVersionAdvanced: vi.fn(),
      onFirstLaunch: vi.fn(),
    };

    const result = await applyStartupVersionAction(action, hooks);

    expect(result).toBe('stored-current-version');
    expect(hooks.persistCurrentVersion).toHaveBeenCalledOnce();
    expect(hooks.onVersionAdvanced).toHaveBeenCalledOnce();
    expect(hooks.clearForceClearFlag).not.toHaveBeenCalled();
    expect(hooks.clearRecoveryStorage).not.toHaveBeenCalled();
    expect(hooks.clearCaches).not.toHaveBeenCalled();
    expect(hooks.unregisterServiceWorkers).not.toHaveBeenCalled();
    expect(hooks.reloadCurrentLocation).not.toHaveBeenCalled();
  });

  it('should execute destructive recovery only for explicit force clear', async () => {
    const action = decideStartupVersionAction({
      storedVersion: 'build-a',
      currentVersion: 'build-b',
      forceClear: true,
    });

    const calls: string[] = [];
    const hooks = {
      persistCurrentVersion: vi.fn(() => calls.push('persist')),
      clearForceClearFlag: vi.fn(() => calls.push('clear-flag')),
      clearRecoveryStorage: vi.fn(() => calls.push('clear-storage')),
      clearCaches: vi.fn(async () => { calls.push('clear-caches'); }),
      unregisterServiceWorkers: vi.fn(async () => { calls.push('unregister-sw'); }),
      reloadCurrentLocation: vi.fn(() => calls.push('reload')),
      onVersionAdvanced: vi.fn(),
      onFirstLaunch: vi.fn(),
    };

    const result = await applyStartupVersionAction(action, hooks);

    expect(result).toBe('reload-scheduled');
    expect(calls).toEqual(['persist', 'clear-flag', 'clear-storage', 'clear-caches', 'unregister-sw', 'reload']);
    expect(hooks.onVersionAdvanced).not.toHaveBeenCalled();
    expect(hooks.onFirstLaunch).not.toHaveBeenCalled();
  });
});
