import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellSignalEffectsDelegatesOptions,
} from './workspace-shell-signal-effects-delegates.factory';
import type {
  WorkspaceShellSignalEffectsLazyLoadDelegate,
  WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
} from './workspace-shell-signal-effects-lazy-load-delegate.factory';
import { GlobalErrorHandler } from '../../../services/global-error-handler.service';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellSessionLifecycleSurfaceCallOptions,
  readWorkspaceShellSessionLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellSignalEffectsOptionsFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellSignalEffectsDelegatesOptions;
type WorkspaceShellSignalEffectsDelegateFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellSignalEffectsLazyLoadDelegate;

async function loadFactories(): Promise<{
  createWorkspaceShellSignalEffectsDelegate?:
    WorkspaceShellSignalEffectsDelegateFactory;
  createWorkspaceShellSignalEffectsSurface?:
    WorkspaceShellSignalEffectsDelegateFactory;
  createWorkspaceShellSignalEffectsOptions?:
    WorkspaceShellSignalEffectsOptionsFactory;
}> {
  const modulePath = './workspace-shell-signal-effects-options.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellSignalEffectsDelegate?:
      WorkspaceShellSignalEffectsDelegateFactory;
    createWorkspaceShellSignalEffectsSurface?:
      WorkspaceShellSignalEffectsDelegateFactory;
    createWorkspaceShellSignalEffectsOptions?:
      WorkspaceShellSignalEffectsOptionsFactory;
  };
}

function createSignalEffectsDelegate(): WorkspaceShellSignalEffectsLazyLoadDelegate {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  } as unknown as WorkspaceShellSignalEffectsLazyLoadDelegate;
}

describe('workspace shell signal effects options', () => {
  it('builds signal-effects delegate options from shell dependencies', async () => {
    const { createWorkspaceShellSignalEffectsOptions } = await loadFactories();

    expect(createWorkspaceShellSignalEffectsOptions).toEqual(expect.any(Function));

    const injector = { get: vi.fn() };
    const registerEffect = vi.fn();
    const modalEffects = {
      syncRecoverableError: vi.fn(),
      syncLoginRequest: vi.fn(),
      syncMigrationRequest: vi.fn(),
    };
    const dataProtectionReminder = { syncFromState: vi.fn() };
    const launchSnapshotController = { sync: vi.fn() };
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const projectState = {
      projects: vi.fn(() => [{ id: 'project-1' }]),
      activeProjectId: vi.fn(() => 'project-1'),
    };
    const routeSyncController = { syncStateFromRoute: vi.fn() };
    const androidWidgetLazyLoad = {
      captureFromRoute: vi.fn(),
      syncProcessing: vi.fn(),
    };
    const startupEntryIntentController = { sync: vi.fn() };
    const startupEntryControllers = {
      androidWidgetLazyLoad,
      startupEntryIntentController,
    };
    const handoffEffect = { sync: vi.fn() };
    const handoffReadiness = { commitWorkspaceHandoffIfReady: vi.fn() };
    const handoffControllers = {
      effect: handoffEffect,
      readiness: handoffReadiness,
    };
    const bootStage = { isWorkspaceHandoffReady: vi.fn(() => true) };
    const focusProbeController = { sync: vi.fn() };
    const focusEntrySyncPulse = { handleOwnerChange: vi.fn() };
    const startupTierHydration = {
      markAuthReadyIfReady: vi.fn(),
      warmupInteractionIfReady: vi.fn(),
      startSyncHydrationIfReady: vi.fn(),
    };
    const syncPulseLifecycle = { sync: vi.fn() };
    const focusSyncControllers = {
      focusEntrySyncPulse,
      focusProbeController,
      mountState: {
        coreDataLoaded: vi.fn(() => true),
      },
      startupTierHydration,
      syncPulseLifecycle,
    };
    const startupTierState = {
      isTierReady: vi.fn((tier: 'p1' | 'p2') => tier === 'p2'),
    };
    const remoteCallbacks = { registerIfReady: vi.fn() };
    const projectSubscription = { sync: vi.fn() };
    const destroyed = vi.fn(() => false);
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const sessionTransition = { setupSessionHandlers: vi.fn() };
    const sessionLaunchControllers = {
      launchSnapshotController,
      sessionTransition,
    };
    const warn = vi.fn();

    const options = createWorkspaceShellSignalEffectsOptions?.({
      injector,
      registerEffect,
      modalEffects,
      dataProtectionReminder,
      sessionLaunchControllers,
      routeUrl,
      projectState,
      routeSyncController,
      startupEntryControllers,
      handoffControllers,
      bootStage,
      focusSyncControllers,
      startupTierState,
      remoteCallbacks,
      projectSubscription,
      destroyed,
      userSession,
      warn,
    });

    expect(options).toEqual({
      registerEffect,
      modalEffects,
      dataProtectionReminder,
      launchSnapshotController,
      route: {
        routeState: { routeUrl },
        projectState,
        routeSyncController,
      },
      runtime: { androidWidgetLazyLoad },
      startupEntryIntent: startupEntryIntentController,
      handoff: {
        effect: handoffEffect,
        bootStage,
        readiness: handoffReadiness,
      },
      focus: {
        probe: focusProbeController,
        entryPulse: focusEntrySyncPulse,
      },
      startupTierState: {
        coreDataLoaded: expect.any(Function),
        isTierReady: startupTierState.isTierReady,
      },
      startupTier: startupTierHydration,
      remoteCallbackRegistration: remoteCallbacks,
      projectSubscription,
      isDestroyed: destroyed,
      syncPulse: syncPulseLifecycle,
      session: {
        userSession,
        transition: sessionTransition,
      },
      warn,
    });
    expect(options?.startupTierState.coreDataLoaded()).toBe(true);
  });

  it('creates signal-effects delegates from shell dependencies in one factory call', async () => {
    const { createWorkspaceShellSignalEffectsDelegate } = await loadFactories();

    expect(createWorkspaceShellSignalEffectsDelegate).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellSignalEffectsLazyLoadDelegateOptions;
    const delegate = createSignalEffectsDelegate();
    const startupEntryControllers = {
      androidWidgetLazyLoad: {
        captureFromRoute: vi.fn(),
        syncProcessing: vi.fn(),
      },
      startupEntryIntentController: { sync: vi.fn() },
    };
    const focusSyncControllers = {
      focusEntrySyncPulse: { handleOwnerChange: vi.fn() },
      focusProbeController: { sync: vi.fn() },
      mountState: {
        coreDataLoaded: vi.fn(() => true),
      },
      startupTierHydration: {
        markAuthReadyIfReady: vi.fn(),
        warmupInteractionIfReady: vi.fn(),
        startSyncHydrationIfReady: vi.fn(),
      },
      syncPulseLifecycle: { sync: vi.fn() },
    };

    const result = createWorkspaceShellSignalEffectsDelegate?.({
      injector: { get: vi.fn() },
      registerEffect: vi.fn(),
      modalEffects: {
        syncRecoverableError: vi.fn(),
        syncLoginRequest: vi.fn(),
        syncMigrationRequest: vi.fn(),
      },
      dataProtectionReminder: { syncFromState: vi.fn() },
      sessionLaunchControllers: {
        launchSnapshotController: { sync: vi.fn() },
        sessionTransition: { setupSessionHandlers: vi.fn() },
      },
      routeUrl: vi.fn(() => '/projects/project-1/text'),
      projectState: {
        projects: vi.fn(() => [{ id: 'project-1' }]),
        activeProjectId: vi.fn(() => 'project-1'),
      },
      routeSyncController: { syncStateFromRoute: vi.fn() },
      startupEntryControllers,
      handoffControllers: {
        effect: { sync: vi.fn() },
        readiness: { commitWorkspaceHandoffIfReady: vi.fn() },
      },
      bootStage: { isWorkspaceHandoffReady: vi.fn(() => true) },
      focusSyncControllers,
      startupTierState: {
        isTierReady: vi.fn((tier: 'p1' | 'p2') => tier === 'p2'),
      },
      remoteCallbacks: { registerIfReady: vi.fn() },
      projectSubscription: { sync: vi.fn() },
      destroyed: vi.fn(() => false),
      userSession: { currentUserId: vi.fn(() => 'user-1') },
      warn: vi.fn(),
      createSignalEffectsLazyLoadDelegate: (
        options: WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
      ) => {
        mappedOptions = options;
        return delegate;
      },
    });

    expect(result).toBe(delegate);
    expect(mappedOptions.routeUrl).toEqual(expect.any(Function));
    if (!mappedOptions.routeUrl) {
      throw new Error('Expected signal-effects routeUrl mapping');
    }
    expect(mappedOptions.routeUrl()).toBe('/projects/project-1/text');
    expect(mappedOptions.startupEntryIntentController)
      .toBe(startupEntryControllers.startupEntryIntentController);
    expect(mappedOptions.currentUserId).toEqual(expect.any(Function));
    if (!mappedOptions.currentUserId) {
      throw new Error('Expected signal-effects currentUserId mapping');
    }
    expect(mappedOptions.currentUserId()).toBe('user-1');
    expect(mappedOptions.coreDataLoaded?.()).toBe(true);
    expect(mappedOptions.isStartupTierReady?.('p1')).toBe(false);
    expect(mappedOptions.isStartupTierReady?.('p2')).toBe(true);
  });

  it('creates signal-effects delegates from grouped shell surfaces', async () => {
    const { createWorkspaceShellSignalEffectsSurface } = await loadFactories();

    expect(createWorkspaceShellSignalEffectsSurface).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellSignalEffectsLazyLoadDelegateOptions;
    const delegate = createSignalEffectsDelegate();
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const routeSyncController = { syncStateFromRoute: vi.fn() };
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
    const createDataProtectionReminderController = vi.fn()
      .mockResolvedValue(dataProtectionReminderController);
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const lazyServiceRefs = {
      exportService: { needsExportReminder: vi.fn(() => false) },
    };
    const toast = {
      dismiss: vi.fn(),
      info: vi.fn(),
      messages: vi.fn(() => []),
      warning: vi.fn(),
    };
    const dataProtectionReminder = {
      createDataProtectionReminderController,
    };
    const startupTier = {
      isTierReady: vi.fn((tier: 'p1' | 'p2') => tier === 'p2'),
    };
    const focusSyncControllers = {
      focusEntrySyncPulse: { handleOwnerChange: vi.fn() },
      focusProbeController: { sync: vi.fn() },
      mountState: {
        coreDataLoaded: vi.fn(() => true),
      },
      startupTierHydration: {
        markAuthReadyIfReady: vi.fn(),
        warmupInteractionIfReady: vi.fn(),
        startSyncHydrationIfReady: vi.fn(),
      },
      syncPulseLifecycle: { sync: vi.fn() },
    };
    const injector = {
      get: vi.fn((token: unknown) => {
        if (token === GlobalErrorHandler) {
          return errorHandler;
        }
        throw new Error(`Unexpected injector token: ${String(token)}`);
      }),
    };

    const result = createWorkspaceShellSignalEffectsSurface?.({
      injector,
      registerEffect: vi.fn(),
      modal,
      modalCoord,
      dataProtectionReminder,
      lazyServiceRefs,
      toast,
      sessionLaunchControllers: {
        launchSnapshotController: { sync: vi.fn() },
        sessionTransition: { setupSessionHandlers: vi.fn() },
      },
      routing: {
        router: {},
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
          syncProcessing: vi.fn(),
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
      userSession,
      warn,
      createSignalEffectsLazyLoadDelegate: (
        options: WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
      ) => {
        mappedOptions = options;
        return delegate;
      },
    });

    expect(result).toBe(delegate);
    expect(injector.get).toHaveBeenCalledWith(GlobalErrorHandler);
    expect(mappedOptions.routeUrl?.()).toBe('/projects/project-1/text');
    mappedOptions.syncStateFromRoute?.();
    expect(routeSyncController.syncStateFromRoute).toHaveBeenCalledTimes(1);
    expect(mappedOptions.modalEffects).toEqual(expect.any(Object));
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
  });

  it('keeps signal-effects option wiring outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const lifecycleGraphOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellLifecycleGraph',
    );
    const sessionLifecycleSource =
      readWorkspaceShellSessionLifecycleSurfaceSource();
    const sessionLifecycleBlock = readWorkspaceShellLifecycleGraphCallOptions(
      'createWorkspaceShellSessionLifecycleSurface',
    );
    const signalEffectsBlock =
      readWorkspaceShellSessionLifecycleSurfaceCallOptions(
      'createWorkspaceShellSignalEffectsSurface',
    );

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource)
      .toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(graphSource).not.toContain('createWorkspaceShellSignalEffectsSurface');
    expect(sessionLifecycleSource)
      .toContain('createWorkspaceShellSignalEffectsSurface');
    expect(source).not.toContain('createWorkspaceShellModalEffectsController');
    expect(source).not.toContain('private readonly modalEffects');
    expect(source).not.toContain(
      "import { GlobalErrorHandler } from './services/global-error-handler.service'",
    );
    expect(source).not.toContain('private readonly errorHandler');
    expect(signalEffectsBlock).not.toContain('errorHandler: this.errorHandler');
    expect(lifecycleGraphOptions).toContain('...context');
    expect(lifecycleGraphOptions).toContain('...base');
    expect(sessionLifecycleBlock).toContain('...options');
    expect(signalEffectsBlock).toContain('...options');
    expect(signalEffectsBlock).not.toContain('modalEffects: {');
    expect(source).not.toContain(
      'createWorkspaceShellDataProtectionReminderLazyLoadDelegate',
    );
    expect(source).not.toContain('private readonly dataProtectionReminder');
    expect(lifecycleGraphOptions).toContain('...sessionRouting');
    expect(signalEffectsBlock).not.toContain('dataProtectionReminder: {');
    expect(signalEffectsBlock).not.toContain(
      'exportService: this.lazyServiceRefs.exportService',
    );
    expect(source).not.toContain('createWorkspaceShellSignalEffectsOptions');
    expect(source).not.toContain('private readonly signalEffectsOptions');
    expect(source).not.toContain('createWorkspaceShellSignalEffectsDelegates');
    expect(source).not.toContain(
      'private readonly handoffEffect = this.handoffControllers.effect',
    );
    expect(source).not.toContain('handoffEffect: this.handoffEffect');
    expect(source).not.toContain('handoffReadiness: this.handoffReadiness');
    expect(source).not.toMatch(
      /createWorkspaceShellSignalEffectsDelegates\(\{\s*registerEffect:/s,
    );
    expect(source).not.toMatch(
      /route:\s*\{\s*routeState:\s*\{ routeUrl: this\.routeUrl \}/s,
    );
    expect(lifecycleGraphOptions).toContain('...interaction');
    expect(signalEffectsBlock).not.toContain('routeUrl: this.routing.routeUrl');
    expect(signalEffectsBlock).not.toContain(
      'routeSyncController: this.routing.routeSyncController',
    );
    expect(lifecycleGraphOptions).toContain('...startupTemplate');
    expect(signalEffectsBlock).not.toContain('androidWidgetLazyLoad:');
    expect(signalEffectsBlock).not.toContain(
      'this.startupEntryControllers.androidWidgetLazyLoad',
    );
    expect(signalEffectsBlock).not.toContain('startupEntryIntentController:');
    expect(signalEffectsBlock).not.toContain(
      'this.startupEntryControllers.startupEntryIntentController',
    );
    expect(signalEffectsBlock).toContain('sessionLaunchControllers');
    expect(signalEffectsBlock).not.toContain(
      'launchSnapshotController: this.launchSnapshotController',
    );
    expect(signalEffectsBlock).not.toContain(
      'sessionTransition: this.sessionTransition',
    );
    expect(lifecycleGraphOptions).toContain('...sessionRouting');
    expect(signalEffectsBlock).not.toContain(
      'focusProbeController: this.focusProbeController',
    );
    expect(signalEffectsBlock).not.toContain(
      'focusEntrySyncPulse: this.focusEntrySyncPulse',
    );
    expect(signalEffectsBlock).not.toContain(
      'startupTierHydration: this.startupTierHydration',
    );
    expect(signalEffectsBlock).not.toContain(
      'syncPulseLifecycle: this.syncPulseLifecycle',
    );
    expect(lifecycleGraphOptions).toContain('...context');
    expect(signalEffectsBlock).not.toContain('startupTierState: {');
    expect(signalEffectsBlock).not.toContain(
      'isTierReady: tier => this.startupTier.isTierReady(tier)',
    );
    expect(signalEffectsBlock).toContain('projectSubscription');
    expect(signalEffectsBlock).toContain('remoteCallbacks');
    expect(signalEffectsBlock).toContain('sessionLaunchControllers');
    expect(signalEffectsBlock).toContain('destroyed: options.runtime');
  });
});
