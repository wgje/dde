export type StartupVersionActionKind =
  | 'noop'
  | 'store-current-version'
  | 'clear-cache-and-reload';

export type StartupVersionActionReason =
  | 'up-to-date'
  | 'first-launch'
  | 'version-advanced'
  | 'force-clear';

export interface StartupVersionActionInput {
  storedVersion: string | null;
  currentVersion: string;
  forceClear: boolean;
}

export interface StartupVersionAction {
  kind: StartupVersionActionKind;
  reason: StartupVersionActionReason;
  shouldPersistCurrentVersion: boolean;
}

export interface StartupVersionActionHooks {
  persistCurrentVersion: () => void;
  clearForceClearFlag: () => void;
  clearRecoveryStorage?: () => void;
  clearCaches: () => Promise<void>;
  unregisterServiceWorkers: () => Promise<void>;
  reloadCurrentLocation: () => void;
  onVersionAdvanced?: () => void;
  onFirstLaunch?: () => void;
}

/**
 * 冷启动期间只允许显式的 force-clear 进入破坏性恢复。
 * 普通版本前进只记录新版本号，避免吞掉桌面图标的第一次启动。
 */
export function decideStartupVersionAction(
  input: StartupVersionActionInput,
): StartupVersionAction {
  if (input.forceClear) {
    return {
      kind: 'clear-cache-and-reload',
      reason: 'force-clear',
      shouldPersistCurrentVersion: true,
    };
  }

  if (!input.storedVersion) {
    return {
      kind: 'store-current-version',
      reason: 'first-launch',
      shouldPersistCurrentVersion: true,
    };
  }

  if (input.storedVersion !== input.currentVersion) {
    return {
      kind: 'store-current-version',
      reason: 'version-advanced',
      shouldPersistCurrentVersion: true,
    };
  }

  return {
    kind: 'noop',
    reason: 'up-to-date',
    shouldPersistCurrentVersion: false,
  };
}

export async function applyStartupVersionAction(
  action: StartupVersionAction,
  hooks: StartupVersionActionHooks,
): Promise<'noop' | 'stored-current-version' | 'reload-scheduled'> {
  if (action.shouldPersistCurrentVersion) {
    hooks.persistCurrentVersion();
  }

  if (action.kind === 'store-current-version') {
    if (action.reason === 'version-advanced') {
      hooks.onVersionAdvanced?.();
    }
    if (action.reason === 'first-launch') {
      hooks.onFirstLaunch?.();
    }
    return 'stored-current-version';
  }

  if (action.kind === 'clear-cache-and-reload') {
    hooks.clearForceClearFlag();
    hooks.clearRecoveryStorage?.();
    await hooks.clearCaches();
    await hooks.unregisterServiceWorkers();
    hooks.reloadCurrentLocation();
    return 'reload-scheduled';
  }

  return 'noop';
}