import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effect, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobalErrorHandler } from '../../../services/global-error-handler.service';
import type {
  WorkspaceShellSignalEffectsLazyLoadDelegate,
  WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
} from './workspace-shell-signal-effects-lazy-load-delegate.factory';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type { WorkspaceShellRouteSyncController } from './workspace-shell-route-sync.controller';
import {
  isWidgetBootstrapAttemptCurrent,
} from './workspace-shell-android-widget-bootstrap-processing.controller';
import { createWorkspaceShellSignalEffectsSurface } from './workspace-shell-signal-effects-surface.factory';

function createSignalEffectsDelegate(): WorkspaceShellSignalEffectsLazyLoadDelegate {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  } as unknown as WorkspaceShellSignalEffectsLazyLoadDelegate;
}
describe('workspace shell signal effects surface', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('owns grouped shell dependency adaptation outside the options factory', () => {
    const optionsSource = readFileSync(
      join(__dirname, 'workspace-shell-signal-effects-options.factory.ts'),
      'utf8',
    );
    const surfaceSource = readFileSync(
      join(__dirname, 'workspace-shell-signal-effects-surface.factory.ts'),
      'utf8',
    );

    expect(surfaceSource).toContain('createWorkspaceShellModalEffectsController');
    expect(surfaceSource).toContain(
      'createWorkspaceShellDataProtectionReminderLazyLoadDelegate',
    );
    expect(optionsSource).not.toContain('GlobalErrorHandler');
    expect(optionsSource).not.toContain('createWorkspaceShellModalEffectsController');
    expect(optionsSource).not.toContain(
      'createWorkspaceShellDataProtectionReminderLazyLoadDelegate',
    );
    expect(optionsSource).not.toContain(
      'export function createWorkspaceShellSignalEffectsSurface',
    );
    expect(optionsSource).not.toMatch(/setTimeout|setInterval/);
  });

  it('creates signal-effects delegates from grouped shell surfaces', async () => {
    let mappedOptions!: WorkspaceShellSignalEffectsLazyLoadDelegateOptions;
    const delegate = createSignalEffectsDelegate();
    const routeUrl = signal('/projects/project-1/text');
    const routeSyncController = { syncStateFromRoute: vi.fn() } as unknown as WorkspaceShellRouteSyncController;
    const warn = vi.fn();
    const errorHandler = { recoverableError: vi.fn(() => null) };
    const modal = {
      isOpen: vi.fn((type: 'login' | 'migration') => type === 'login'),
      getData: vi.fn(() => ({ returnUrl: '/projects/project-1/text' })),
      closeByType: vi.fn(),
    };
    const modalCoord = {
      loginReturnUrl: null as string | null,
      loginModalRef: null,
      openErrorRecoveryModal: vi.fn(),
      openLoginModal: vi.fn(),
      openMigrationModal: vi.fn(),
    };
    const dataProtectionReminderController = { syncFromState: vi.fn() };
    const createDataProtectionReminderController = vi.fn().mockResolvedValue(dataProtectionReminderController);
    const sessionInitialized = signal(true);
    const currentOwner = signal<string | null>('user-a');
    const authService = { sessionInitialized: vi.fn(() => sessionInitialized()) };
    const userSession = { currentUserId: vi.fn(() => currentOwner()) };
    const deferredBootstrapAttempts: Array<() => void> = [];
    const completeBootstrap = vi.fn();
    const lazyServiceRefs = {
      exportService: { needsExportReminder: vi.fn(() => false) },
    };
    const toast = {
      dismiss: vi.fn(),
      info: vi.fn(),
      messages: vi.fn(() => []),
      warning: vi.fn(),
    };
    const startupTier = { isTierReady: vi.fn((tier: 'p1' | 'p2') => tier === 'p2') };
    const focusSyncControllers = {
      focusEntrySyncPulse: {
        clearRetry: vi.fn(),
        dispatchIfReady: vi.fn(),
        handleOwnerChange: vi.fn(),
        reset: vi.fn(),
      },
      focusProbeController: { sync: vi.fn() },
      mountState: {
        coreDataLoaded: vi.fn(() => true),
      } as unknown as WorkspaceShellMountStateController,
      startupTierHydration: {
        markAuthReadyIfReady: vi.fn(),
        warmupInteractionIfReady: vi.fn(),
        startSyncHydrationIfReady: vi.fn(),
      },
      syncPulseLifecycle: {
        clearFocusEntrySyncPulseRetry: vi.fn(),
        destroy: vi.fn(),
        dispatchFocusEntrySyncPulseIfReady: vi.fn(),
        initialize: vi.fn(),
        isReady: vi.fn(() => true),
        resetFocusEntrySyncPulse: vi.fn(),
        sync: vi.fn(),
        syncEffect: vi.fn(),
        trigger: vi.fn().mockResolvedValue(null),
      },
    };
    const injector = {
      get: vi.fn((token: unknown) => {
        if (token === GlobalErrorHandler) {
          return errorHandler;
        }
        throw new Error(`Unexpected injector token: ${String(token)}`);
      }),
    };

    const result = createWorkspaceShellSignalEffectsSurface({
      injector,
      registerEffect: vi.fn(),
      modal,
      modalCoord,
      dataProtectionReminder: { createDataProtectionReminderController },
      lazyServiceRefs,
      toast,
      sessionLaunchControllers: {
        launchSnapshotController: { sync: vi.fn() },
        sessionTransition: {
          setupSessionHandlers: vi.fn(),
          cleanup: vi.fn(),
        },
      },
      routing: {
        routeUrl,
        routeSyncController,
      },
      projectState: {
        projects: vi.fn(() => [{ id: 'project-1' }]),
        activeProjectId: vi.fn(() => 'project-1'),
      },
      startupEntryControllers: {
        androidWidgetLazyLoad: {
          captureFromRoute: vi.fn(),
          syncProcessing: vi.fn((generation: number) => {
            deferredBootstrapAttempts.push(() => {
              if (isWidgetBootstrapAttemptCurrent(generation)) completeBootstrap();
            });
          }),
        },
        startupEntryIntentController: { sync: vi.fn() },
      },
      handoffControllers: {
        effect: { sync: vi.fn() },
        readiness: { commitWorkspaceHandoffIfReady: vi.fn() },
      },
      bootStage: { isWorkspaceHandoffReady: vi.fn(() => true) },
      focusSyncControllers,
      startupTier,
      remoteCallbacks: { registerIfReady: vi.fn() },
      projectSubscription: { sync: vi.fn() },
      destroyed: vi.fn(() => false),
      authService,
      userSession,
      warn,
      createSignalEffectsLazyLoadDelegate: options => {
        mappedOptions = options;
        return delegate;
      },
    });

    expect(result).toBe(delegate);
    expect(injector.get).toHaveBeenCalledWith(GlobalErrorHandler);
    expect(mappedOptions.routeUrl?.()).toBe('/projects/project-1/text');
    mappedOptions.syncStateFromRoute?.();
    expect(routeSyncController.syncStateFromRoute).toHaveBeenCalledTimes(1);
    mappedOptions.modalEffects?.syncLoginRequest();
    expect(modal.closeByType).toHaveBeenCalledWith('login');
    expect(modalCoord.loginReturnUrl).toBe('/projects/project-1/text');
    expect(modalCoord.openLoginModal).toHaveBeenCalledTimes(1);
    expect(mappedOptions.dataProtectionReminder?.syncFromState)
      .toEqual(expect.any(Function));
    mappedOptions.dataProtectionReminder?.syncFromState();
    await vi.waitFor(() => {
      expect(createDataProtectionReminderController).toHaveBeenCalledTimes(1);
      expect(dataProtectionReminderController.syncFromState).toHaveBeenCalledTimes(1);
    });
    expect(mappedOptions.isStartupTierReady?.('p1')).toBe(false);
    expect(mappedOptions.isStartupTierReady?.('p2')).toBe(true);
    TestBed.configureTestingModule({});
    TestBed.runInInjectionContext(() => {
      effect(() => mappedOptions.syncAndroidWidgetBootstrapProcessing?.());
    });
    TestBed.flushEffects();
    currentOwner.set('user-b');
    TestBed.flushEffects();
    currentOwner.set('user-a');
    TestBed.flushEffects();
    deferredBootstrapAttempts[0]();
    expect(completeBootstrap).not.toHaveBeenCalled();
    deferredBootstrapAttempts[1]();
    expect(completeBootstrap).not.toHaveBeenCalled();
    deferredBootstrapAttempts[2]();
    expect(completeBootstrap).toHaveBeenCalledTimes(1);
    expect(authService.sessionInitialized).toHaveBeenCalledTimes(3);
    expect(userSession.currentUserId).toHaveBeenCalledTimes(3);
    expect(authService.sessionInitialized.mock.invocationCallOrder[0])
      .toBeLessThan(userSession.currentUserId.mock.invocationCallOrder[0]);
  });
});
