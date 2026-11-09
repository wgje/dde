import { describe, expect, it } from 'vitest';

import {
  registerWorkspaceShellLazyLifecycleStartupContractSpecs,
} from './workspace-shell-lazy-lifecycle-startup.contract.spec-helpers';
import {
  readBeforeUnloadOptionsBlock,
  readInteractionLazyLoadOptionsBlock,
  readLazyLifecycleGroupSource,
  readShellLifecycleDelegatesOptionsBlock,
  readProjectSubscriptionOptionsBlock,
  readRemoteCallbacksOptionsBlock,
  readSessionLaunchOptionsBlock,
  readSignalEffectsOptionsBlock,
  readSidebarToggleOptionsBlock,
  readStorageEscapeOptionsBlock,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSessionLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-lazy-lifecycle-delegation.contract.spec-helpers';

describe('WorkspaceShell lazy lifecycle delegation contract', () => {
  it('keeps lazy lifecycle resolver wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('workspace-shell-lazy-lifecycle-host.controller');
    expect(source).not.toContain('workspace-shell-keyboard-shortcuts-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-keyboard-shortcuts-lazy-load-resolver.controller');
    expect(source).not.toContain('workspace-shell-startup-breadcrumb-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-startup-breadcrumb-lazy-load-resolver.controller');
    expect(source).not.toContain('workspace-shell-sw-update-lifecycle-host.controller');
    expect(source).not.toContain('workspace-shell-sw-update-lifecycle.controller');
    expect(source).not.toContain('this.keyboardShortcuts.initialize()');
    expect(source).not.toContain('this.keyboardShortcuts.teardown()');
    expect(source).not.toContain('this.startupBreadcrumb.initialize()');
    expect(source).not.toContain('this.startupBreadcrumb.teardown()');
    expect(source).not.toContain('this.swUpdateLifecycle.initialize()');
    expect(source).not.toContain('this.swUpdateLifecycle.teardown()');
  });

  it('keeps lazy lifecycle group construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('createWorkspaceShellLazyLifecycleDelegates');
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellLazyLifecycleGroupController\s*\}\s+from\s+['"][^'"]*workspace-shell-lazy-lifecycle-group\.controller['"]/,
    );
    expect(source).not.toMatch(/lazyLifecycles\s*=\s*new\s+/);
  });

  it('keeps concrete lazy lifecycle hosts out of the static group chunk', () => {
    const source = readLazyLifecycleGroupSource();

    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellKeyboardShortcutsLazyLoadHostController\s*\}\s+from\s+['"][^'"]*workspace-shell-keyboard-shortcuts-lazy-load-host\.controller['"]/,
    );
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellStartupBreadcrumbLazyLoadHostController\s*\}\s+from\s+['"][^'"]*workspace-shell-startup-breadcrumb-lazy-load-host\.controller['"]/,
    );
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellSwUpdateLifecycleHostController\s*\}\s+from\s+['"][^'"]*workspace-shell-sw-update-lifecycle-host\.controller['"]/,
    );
  });

  it('keeps signal effects controller out of the static workspace shell chunk', () => {
    const source = readWorkspaceShellSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const sessionLifecycleSource = readWorkspaceShellSessionLifecycleSurfaceSource();

    expect(lifecycleGraphSource).toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(sessionLifecycleSource).toContain('createWorkspaceShellSignalEffectsSurface');
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellSignalEffectsController\s*\}\s+from\s+['"][^'"]*workspace-shell-signal-effects\.controller['"]/,
    );
    expect(source).not.toContain('WorkspaceShellSignalEffectsLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-signal-effects-lazy-load-host.controller');
    expect(source).not.toMatch(/signalEffects\s*=\s*new\s+/);
  });

  it('keeps signal effect option wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const optionsBlock = readSignalEffectsOptionsBlock();

    expect(source).not.toContain(
      "import { GlobalErrorHandler } from './services/global-error-handler.service'",
    );
    expect(source).not.toContain('private readonly errorHandler');
    expect(optionsBlock).not.toContain('errorHandler: this.errorHandler');
    expect(optionsBlock).not.toContain('syncStateFromRoute:');
    expect(optionsBlock).not.toContain('captureAndroidWidgetBootstrapFromRoute:');
    expect(optionsBlock).not.toContain('syncAndroidWidgetBootstrapProcessing:');
    expect(optionsBlock).not.toContain('commitWorkspaceHandoff:');
    expect(optionsBlock).not.toContain('currentUserId:');
    expect(optionsBlock).toContain('...options');
    expect(optionsBlock).not.toContain('routeUrl: this.routing.routeUrl');
    expect(optionsBlock).not.toContain(
      'routeSyncController: this.routing.routeSyncController',
    );
    expect(optionsBlock).not.toContain('startupTierState: {');
  });

  it('keeps remote callback registration controller out of the static workspace shell chunk', () => {
    const source = readWorkspaceShellSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const sessionLifecycleSource = readWorkspaceShellSessionLifecycleSurfaceSource();

    expect(lifecycleGraphSource).toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(sessionLifecycleSource).toContain('createWorkspaceShellRemoteCallbacksDelegate');
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellRemoteCallbacksController\s*\}\s+from\s+['"][^'"]*workspace-shell-remote-callbacks\.controller['"]/,
    );
    expect(source).not.toContain('WorkspaceShellRemoteCallbacksLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-remote-callbacks-lazy-load-host.controller');
    expect(source).not.toMatch(/remoteCallbacks\s*=\s*new\s+/);
    expect(source).not.toMatch(/\bprivate\s+isRemoteCallbacksReady\s*\(/);
  });

  it('keeps remote callback deferred option wiring out of the workspace shell component', () => {
    const optionsBlock = readRemoteCallbacksOptionsBlock();

    expect(optionsBlock).not.toContain('isResumeInteractionFirstEnabled:');
    expect(optionsBlock).not.toContain('isTieredStartupHydrationEnabled:');
    expect(optionsBlock).not.toContain('isEnabled:');
    expect(optionsBlock).not.toContain('isTieredStartupHydration:');
    expect(optionsBlock).not.toContain('isStartupTierP2Ready:');
    expect(optionsBlock).not.toContain('refreshActiveProjectSilent:');
    expect(optionsBlock).not.toContain('currentUserId:');
    expect(optionsBlock).not.toContain('coreDataLoaded:');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1');
  });

  it('keeps project subscription controller construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const sessionLifecycleSource = readWorkspaceShellSessionLifecycleSurfaceSource();

    expect(lifecycleGraphSource).toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(sessionLifecycleSource).toContain('createWorkspaceShellProjectSubscriptionDelegate');
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellProjectSubscriptionController\s*\}\s+from\s+['"][^'"]*workspace-shell-project-subscription\.controller['"]/,
    );
    expect(source).not.toMatch(
      /import\s+\{\s*createWorkspaceShellProjectSubscriptionController\s*\}\s+from\s+['"][^'"]*workspace-shell-project-subscription\.factory['"]/,
    );
    expect(source).not.toMatch(/projectSubscription\s*=\s*new\s+/);
  });

  it('keeps project subscription option wiring out of the workspace shell component', () => {
    const optionsBlock = readProjectSubscriptionOptionsBlock();

    expect(optionsBlock).not.toContain('isResumeInteractionFirstEnabled:');
    expect(optionsBlock).not.toContain('isTieredStartupHydrationEnabled:');
    expect(optionsBlock).not.toContain('isEnabled:');
    expect(optionsBlock).not.toContain('coreDataLoaded:');
    expect(optionsBlock).not.toContain('isTieredStartupHydration:');
    expect(optionsBlock).not.toContain('isStartupTierP2Ready:');
    expect(optionsBlock).not.toContain('currentUserId:');
    expect(optionsBlock).not.toContain('activeProjectId:');
    expect(optionsBlock).not.toContain('subscribeToProject:');
    expect(optionsBlock).not.toContain('unsubscribeFromProject:');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1');
  });

  it('keeps session transition and launch snapshot construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const sessionLifecycleSource = readWorkspaceShellSessionLifecycleSurfaceSource();

    expect(lifecycleGraphSource).toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(sessionLifecycleSource).toContain('createWorkspaceShellSessionLaunchSurface');
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellSessionTransitionLazyLoadController\s*\}\s+from\s+['"][^'"]*workspace-shell-session-transition-lazy-load\.controller['"]/,
    );
    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellLaunchSnapshotController\s*\}\s+from\s+['"][^'"]*workspace-shell-launch-snapshot\.controller['"]/,
    );
    expect(source).not.toMatch(/sessionTransition\s*=\s*new\s+/);
    expect(source).not.toMatch(/launchSnapshotController\s*=\s*new\s+/);
    expect(source).not.toContain('launchSnapshotWriteBlocked');
  });

  it('keeps session launch option wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const optionsBlock = readSessionLaunchOptionsBlock();

    expect(source).not.toContain('completeCrossTabSessionRestore:');
    expect(source).not.toContain('resetFocusEntrySyncPulseState:');
    expect(source).not.toContain('cancelPendingLaunchSnapshotPersist:');
    expect(source).not.toContain('subscribeToSessionRestored:');
    expect(source).not.toContain('subscribeToSessionInvalidated:');
    expect(source).not.toContain('getPersistOwnerDuringAuthSettle:');
    expect(source).not.toContain('schedulePersistDeferred:');
    expect(optionsBlock).toContain('...options');
    expect(optionsBlock).not.toContain('routeUrl: this.routing.routeUrl');
    expect(optionsBlock).not.toContain(
      'launchSnapshot: this.launchSnapshotSurface.launchSnapshot',
    );
    expect(optionsBlock).not.toContain(
      'syncPulseLifecycle: this.focusSyncControllers.syncPulseLifecycle',
    );
    expect(optionsBlock).not.toContain(
      'routeState: { routeUrl: this.routing.routeUrl }',
    );
    expect(optionsBlock).not.toContain('routeUrl: () => this.routing.routeUrl()');
    expect(optionsBlock).not.toContain('isTieredStartupHydration:');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1');
  });

  it('keeps startup entry intent host construction and route parsing out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellStartupEntryIntentLazyLoadHostController\s*\}\s+from\s+['"][^'"]*workspace-shell-startup-entry-intent-lazy-load-host\.controller['"]/,
    );
    expect(source).not.toMatch(/startupEntryIntentController\s*=\s*new\s+/);
    expect(source).not.toMatch(/\bprivate\s+currentStartupEntryIntent\s*\(/);
    expect(source).not.toMatch(/\bresolveStartupEntryIntent\b/);
  });

  it('keeps data protection reminder construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellDataProtectionReminderController\s*\}\s+from\s+['"][^'"]*workspace-shell-data-protection-reminder\.controller['"]/,
    );
    expect(source).not.toMatch(/dataProtectionReminder\s*=\s*new\s+/);
  });

  it('keeps data protection reminder low-level callback wiring out of the workspace shell component', () => {
    const optionsBlock = readSignalEffectsOptionsBlock();

    expect(optionsBlock).toContain('...options');
    expect(optionsBlock).not.toContain('dataProtectionReminder: {');
    expect(optionsBlock).not.toContain('exportService:');
    expect(optionsBlock).not.toContain('exportService: this.lazyServiceRefs.exportService');
    expect(optionsBlock).not.toContain('currentUserId:');
  });

  it('keeps conflict handler construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const optionsBlock = readShellLifecycleDelegatesOptionsBlock();

    expect(source).not.toContain('workspace-shell-conflict-handler.controller');
    expect(source).not.toContain('createWorkspaceShellConflictHandlerController');
    expect(source).not.toMatch(/private\s+readonly\s+conflictHandler\s*=/);
    expect(source).not.toMatch(/conflictHandler\s*=\s*new\s+/);
    expect(optionsBlock).not.toContain('conflictHandler: this.conflictHandler');
  });

  it('keeps sign-out controller construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('workspace-shell-sign-out.controller');
    expect(source).not.toMatch(/signOutController\s*=\s*new\s+/);
  });

  it('keeps before-unload controller construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('workspace-shell-before-unload.controller');
    expect(source).not.toMatch(/beforeUnloadController\s*=\s*new\s+/);
  });

  it('keeps before-unload browser probing out of the workspace shell component', () => {
    const optionsBlock = readBeforeUnloadOptionsBlock();

    expect(optionsBlock).not.toContain('isBrowser:');
    expect(optionsBlock).not.toContain('typeof window');
  });

  it('keeps storage escape low-level option wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const sessionRoutingSurfaceSource = readWorkspaceShellSessionRoutingSurfaceSource();
    const optionsBlock = readStorageEscapeOptionsBlock();

    expect(sessionRoutingSurfaceSource).toContain('createWorkspaceShellStorageEscapeDelegates');
    expect(source).not.toContain('createWorkspaceShellStorageEscapeLazyLoadDelegate');
    expect(optionsBlock).not.toContain('onStorageFailure:');
    expect(optionsBlock).not.toContain('getProjects:');
    expect(optionsBlock).not.toContain('setStorageEscapeData:');
    expect(optionsBlock).not.toContain('openStorageEscapeModalImperative:');
    expect(optionsBlock).not.toContain('closeStorageEscapeModal:');
    expect(optionsBlock).not.toContain('new Date().toISOString()');
  });

  it('keeps focus mount intent controller construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('workspace-shell-focus-mount-intent.controller');
    expect(source).not.toMatch(/focusMountIntent\s*=\s*new\s+/);
  });

  it('keeps modal effects controller construction and login data casting out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellModalEffectsController\s*\}\s+from\s+['"][^'"]*workspace-shell-modal-effects\.controller['"]/,
    );
    expect(source).not.toMatch(/modalEffects\s*=\s*new\s+/);
    expect(source).not.toContain('type LoginData');
    expect(source).not.toContain("getData('login') as LoginData");
  });

  it('keeps full actions controller out of the static workspace shell chunk', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(
      /import\s+\{\s*WorkspaceShellActionsController\s*\}\s+from\s+['"][^'"]*workspace-shell-actions\.controller['"]/,
    );
  });

  it('keeps sidebar resize lazy host state out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('createWorkspaceShellSidebarResizeLazyLoadDelegate');
    expect(source).not.toContain('workspace-shell-sidebar-resize-lazy-load-delegate.factory');
    expect(source).not.toContain('sidebarResizePromise');
    expect(source).not.toContain('sidebarResizeInstance');
    expect(source).not.toContain('sidebarResizeGestureId');
    expect(source).not.toContain('sidebarResizePending');
    expect(source).not.toContain('startSidebarResizeLazy');
    expect(source).not.toContain('loadSidebarResizeController');
    expect(source).not.toContain('createSidebarResizeController');
    expect(source).not.toContain('WorkspaceShellSidebarResizeDeferredLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-sidebar-resize-deferred-lazy-load-host.controller');
    expect(source).not.toContain('WorkspaceShellSidebarResizeDelegationLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-sidebar-resize-delegation-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-sidebar-resize-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-sidebar-resize-delegation.controller');
    expect(source).not.toMatch(/sidebarResize\s*=\s*new\s+/);
    expect(source).not.toMatch(/\bget\s+isResizingAny\s*\(/);
    expect(source).not.toMatch(/\bstartSidebarResize\s*\(/);
    expect(source).not.toMatch(/\bstartContentResize\s*\(/);
    expect(source).not.toMatch(/\bonDocumentMouseMove\s*\(/);
    expect(source).not.toMatch(/\bonDocumentMouseUp\s*\(/);
    expect(source).not.toContain("@HostListener('document:mousemove'");
    expect(source).not.toContain("@HostListener('document:mouseup'");
  });

  it('keeps modal callback wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('createWorkspaceShellAuthModalLazyLoadDelegate');
    expect(source).not.toContain('workspace-shell-auth-modal-lazy-load-delegate.factory');
    expect(source).not.toContain('private createModalCallbacks');
    expect(source).not.toContain('handleLoginFromModal: data =>');
    expect(source).not.toContain('confirmCreateProject: (name, desc)');
  });

  it('keeps consumed modal lazy-load delegates out of leftover workspace shell aliases', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('private readonly authModal = this.interactionDelegates.authModal');
    expect(source).not.toContain('private readonly modalCoordLazyLoad = this.modalLazyLoad.coordinator');
  });

  it('keeps pure lifecycle wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bprivate\s+initializeKeyboardShortcuts\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownKeyboardShortcuts\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+initializeStartupBreadcrumb\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownStartupBreadcrumb\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+initializeSwUpdateLifecycle\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownSwUpdateLifecycle\s*\(/);
  });

  it('keeps lazy tool forwarding wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bprivate\s+scheduleStartupFontInitialization\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+initializeStartupDiagnosticsLazy\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+loadFocusSessionTriggerComponent\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+loadBlackBoxRecorderComponent\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+preloadFocusMode\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+scheduleFocusModePreload\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+preloadSidebarTools\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+preloadSidebarFocusModeAssets\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+scheduleSidebarFocusModePreload\s*\(/);
  });

  it('keeps focus and sidebar tool lazy-load host creation out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('WorkspaceShellFocusToolsLazyLoadHostController');
    expect(source).not.toContain('WorkspaceShellSidebarToolsLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-focus-tools-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-sidebar-tools-lazy-load-host.controller');
    expect(source).not.toMatch(
      /focusToolsLazyLoad\s*=\s*createWorkspaceShellDeferredController/,
    );
    expect(source).not.toMatch(
      /sidebarToolsLazyLoad\s*=\s*createWorkspaceShellDeferredController/,
    );
  });

  it('keeps interaction lazy-load delegate creation out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('createWorkspaceShellDeferredController');
    expect(source).not.toContain('WorkspaceShellTouchGestureLazyLoadController');
    expect(source).not.toContain('WorkspaceShellActionsLazyLoadHostController');
    expect(source).not.toContain('WorkspaceShellViewportResizeLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-touch-gesture-lazy-load.controller');
    expect(source).not.toContain('workspace-shell-actions-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-viewport-resize-lazy-load-host.controller');
    expect(source).not.toContain('listenToDocument: (eventName, listener)');
    expect(source).not.toContain('listenToWindow: (eventName, listener)');
    expect(source).not.toContain('document.addEventListener(eventName, listener)');
    expect(source).not.toContain('window.addEventListener(eventName, listener)');
  });

  it('keeps interaction lazy-load browser target probing out of the workspace shell component', () => {
    const optionsBlock = readInteractionLazyLoadOptionsBlock();

    expect(optionsBlock).not.toContain('getDocument:');
    expect(optionsBlock).not.toContain('getWindow:');
    expect(optionsBlock).not.toContain('typeof document');
    expect(optionsBlock).not.toContain('typeof window');
  });

  it('keeps pure setup and teardown wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bprivate\s+setupRouteSync\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+syncStateFromRoute\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+setupBeforeUnloadHandler\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+setupSidebarToggleListener\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+setupStorageFailureHandler\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+setupConflictHandler\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+setupFocusMountIntentListener\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownFocusMountIntentListener\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownSidebarResize\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownViewportResize\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+teardownSessionTransition\s*\(/);
    expect(source).not.toMatch(/\bcheckMobile\s*\(/);
    expect(source).not.toContain("@HostListener('window:resize'");
  });

  it('keeps sidebar-toggle browser target probing out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const optionsBlock = readSidebarToggleOptionsBlock();

    expect(source).not.toContain('new WorkspaceShellSidebarToggleEventController');
    expect(optionsBlock).not.toContain('getWindow:');
    expect(optionsBlock).not.toContain('typeof window');
  });

  it('keeps migrated public shell action wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\n\s+updateUrlForProject\s*\(/);
    expect(source).not.toMatch(/\n\s+toggleSidebar\s*\(/);
    expect(source).not.toMatch(/\n\s+onSidebarTouchStart\s*\(/);
    expect(source).not.toMatch(/\n\s+onSidebarTouchMove\s*\(/);
    expect(source).not.toMatch(/\n\s+onSidebarTouchEnd\s*\(/);
    expect(source).not.toMatch(/\n\s+onMainTouchStart\s*\(/);
    expect(source).not.toMatch(/\n\s+onMainTouchMove\s*\(/);
    expect(source).not.toMatch(/\n\s+onMainTouchEnd\s*\(/);
    expect(source).not.toMatch(/\n\s+onSidebarToolsIntent\s*\(/);
    expect(source).not.toMatch(/\n\s+onSidebarVoiceTranscribed\s*\(/);
    expect(source).not.toMatch(/\n\s+continueAndroidWidgetManualCallback\s*\(/);
    expect(source).not.toMatch(/\n\s+useAndroidWidgetIntentFallback\s*\(/);
    expect(source).not.toMatch(/\n\s+dismissAndroidWidgetManualCallback\s*\(/);
    expect(source).not.toMatch(/\n\s+showInstallPrompt\s*\(/);
    expect(source).not.toMatch(/\n\s+onPwaPromptVisibleChange\s*\(/);
    expect(source).not.toMatch(/\n\s+showBlockingStartupHintOverlay\s*\(/);
    expect(source).not.toMatch(/\n\s+showCompactStartupHintBanner\s*\(/);
    expect(source).not.toMatch(/\n\s+isMobileOfflineNoticeVisible\s*\(/);
    expect(source).not.toMatch(/\n\s+showMobileDemoBanner\s*\(/);
    expect(source).not.toMatch(/\n\s+resolveMobileFloatingNoticeBaseTopOffsetPx\s*\(/);
    expect(source).not.toMatch(/\n\s+installPromptTop\s*\(/);
    expect(source).not.toMatch(/\n\s+compactStartupHintBannerTop\s*\(/);
    expect(source).not.toMatch(/\n\s+compressDisplayId\s*\(/);
    expect(source).not.toMatch(/\n\s+setActiveProjectId\s*\(/);
    expect(source).not.toMatch(/\n\s+hintOnlyStartupPlaceholderVisible\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+offlineMode\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+sessionExpired\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+isMobile\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+sidebarWidth\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+projects\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+activeProject\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+deletedTasks\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+currentUserId\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+searchResults\s*\(/);
    expect(source).not.toMatch(/\n\s+get\s+filteredProjects\s*\(/);
  });

  registerWorkspaceShellLazyLifecycleStartupContractSpecs();
});
