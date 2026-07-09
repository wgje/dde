import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSignalEffectsDelegates,
} from './workspace-shell-signal-effects-delegates.factory';
import type {
  WorkspaceShellSignalEffectsLazyLoadDelegate,
  WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
} from './workspace-shell-signal-effects-lazy-load-delegate.factory';

function createSignalEffectsDelegate(): WorkspaceShellSignalEffectsLazyLoadDelegate {
  return {
    setup: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellSignalEffectsDelegates', () => {
  it('maps shell services and delegates into signal effects lazy-load options', async () => {
    let mappedOptions!: WorkspaceShellSignalEffectsLazyLoadDelegateOptions;
    const signalEffects = createSignalEffectsDelegate();
    const modalEffects = {
      syncRecoverableError: vi.fn(),
      syncLoginRequest: vi.fn(),
      syncMigrationRequest: vi.fn(),
    };
    const dataProtectionReminder = { syncFromState: vi.fn() };
    const launchSnapshotController = { sync: vi.fn() };
    const routeSyncController = { syncStateFromRoute: vi.fn() };
    const androidWidgetLazyLoad = {
      captureFromRoute: vi.fn().mockResolvedValue(true),
      syncProcessing: vi.fn(),
    };
    const startupEntryIntentController = { sync: vi.fn() };
    const handoffEffect = { sync: vi.fn() };
    const focusProbeController = { sync: vi.fn() };
    const startupTierHydration = {
      markAuthReadyIfReady: vi.fn(),
      warmupInteractionIfReady: vi.fn(),
      startSyncHydrationIfReady: vi.fn(),
    };
    const startupTierState = {
      coreDataLoaded: vi.fn(() => true),
      isTierReady: vi.fn((tier: 'p1' | 'p2') => tier === 'p2'),
    };
    const remoteCallbacks = { registerIfReady: vi.fn() };
    const projectSubscription = { sync: vi.fn() };
    const focusEntrySyncPulse = { handleOwnerChange: vi.fn() };
    const syncPulseLifecycle = { sync: vi.fn() };
    const sessionTransition = { setupSessionHandlers: vi.fn() };
    const userSession = { currentUserId: vi.fn().mockReturnValue('user-1') };
    const warn = vi.fn();

    const delegate = createWorkspaceShellSignalEffectsDelegates({
      registerEffect: vi.fn(),
      modalEffects,
      dataProtectionReminder,
      launchSnapshotController,
      route: {
        routeState: {
          routeUrl: () => '/projects/project-1/text',
        },
        projectState: {
          projects: () => [{ id: 'project-1' }],
          activeProjectId: () => 'project-1',
        },
        routeSyncController,
      },
      runtime: { androidWidgetLazyLoad },
      startupEntryIntent: startupEntryIntentController,
      handoff: {
        effect: handoffEffect,
        bootStage: { isWorkspaceHandoffReady: () => true },
        readiness: { commitWorkspaceHandoffIfReady: vi.fn() },
      },
      focus: {
        probe: focusProbeController,
        entryPulse: focusEntrySyncPulse,
      },
      startupTierState,
      startupTier: startupTierHydration,
      remoteCallbackRegistration: remoteCallbacks,
      projectSubscription,
      isDestroyed: () => false,
      syncPulse: syncPulseLifecycle,
      session: {
        userSession,
        transition: sessionTransition,
      },
      warn,
      createSignalEffectsLazyLoadDelegate: options => {
        mappedOptions = options;
        return signalEffects;
      },
    });

    expect(delegate).toBe(signalEffects);
    expect(mappedOptions.projects?.()).toEqual([{ id: 'project-1' }]);
    expect(mappedOptions.activeProjectId?.()).toBe('project-1');
    expect(mappedOptions.routeUrl?.()).toBe('/projects/project-1/text');
    expect(mappedOptions.currentUserId?.()).toBe('user-1');
    expect(mappedOptions.coreDataLoaded?.()).toBe(true);
    expect(mappedOptions.isStartupTierReady?.('p1')).toBe(false);
    expect(mappedOptions.isStartupTierReady?.('p2')).toBe(true);
    mappedOptions.syncStateFromRoute?.();
    await expect(
      mappedOptions.captureAndroidWidgetBootstrapFromRoute?.('/projects/project-1/text'),
    ).resolves.toBe(true);
    mappedOptions.syncAndroidWidgetBootstrapProcessing?.();
    mappedOptions.commitWorkspaceHandoff?.();
    mappedOptions.focusEntrySyncPulse?.handleOwnerChange('user-1');
    mappedOptions.syncPulseEffect?.sync();
    const syncEffectError = new Error('sync effect failed');
    mappedOptions.onEffectError?.('launch-snapshot', syncEffectError);
    const asyncEffectError = new Error('async effect failed');
    mappedOptions.onAsyncEffectError?.('android-widget-bootstrap-capture', asyncEffectError);

    expect(routeSyncController.syncStateFromRoute).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.captureFromRoute).toHaveBeenCalledWith('/projects/project-1/text');
    expect(androidWidgetLazyLoad.syncProcessing).toHaveBeenCalledTimes(1);
    expect(focusEntrySyncPulse.handleOwnerChange).toHaveBeenCalledWith('user-1');
    expect(syncPulseLifecycle.sync).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell signal effect 执行失败',
      {
        effect: 'launch-snapshot',
        error: syncEffectError,
      },
    );
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell signal effect 异步执行失败',
      {
        effect: 'android-widget-bootstrap-capture',
        error: asyncEffectError,
      },
    );
  });
});
