import { expect, it } from 'vitest';

import {
  readWorkspaceShellBaseSurfacesSource,
  readChromeSurfaceSource,
  readDestroyControllerOptionsBlock,
  readFloatingNoticeChromeOptionsBlock,
  readFocusSyncOptionsBlock,
  readNgOnInitStartupOptionsBlock,
  readShellLifecycleDelegatesOptionsBlock,
  readStartupEntryControllersFactorySource,
  readStartupEntryControllersOptionsBlock,
  readToolControllersOptionsBlock,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellNgOnInitBody,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-lazy-lifecycle-delegation.contract.spec-helpers';

export function registerWorkspaceShellLazyLifecycleStartupContractSpecs(): void {
  it('keeps modal action forwarding wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bprivate\s+setModalLoading\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+getModalCoord\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+runModalAction\s*\(/);
    expect(source).not.toMatch(/\n\s+isModalLoading\s*\(/);
  });

  it('keeps search state forwarding wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const baseSurfacesSource = readWorkspaceShellBaseSurfacesSource();

    expect(baseSurfacesSource).toContain('createWorkspaceShellSearchDelegates');
    expect(source).not.toContain('createWorkspaceShellSearchController');
    expect(source).not.toContain('new WorkspaceShellSearchController');
    expect(source).not.toMatch(/\bprivate\s+hasActiveSearchQuery\s*\(/);
    expect(source).not.toContain('hasActiveSearchQuery: () => this.searchController.hasActiveQuery()');
  });

  it('keeps search lazy-load controller implementation out of the static workspace shell chunk', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('WorkspaceShellSearchLazyLoadController');
    expect(source).not.toContain('workspace-shell-search-lazy-load.controller');
    expect(source).not.toMatch(/searchLazyLoad\s*=\s*new\s+/);
  });

  it('keeps mount-state computed business rules out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const sessionRoutingSurfaceSource = readWorkspaceShellSessionRoutingSurfaceSource();

    expect(sessionRoutingSurfaceSource).toContain('createWorkspaceShellFocusSyncSurface');
    expect(source).not.toContain('createWorkspaceShellFocusSyncControllers');
    expect(source).not.toMatch(/readonly\s+coreDataLoaded\s*=\s*computed/);
    expect(source).not.toMatch(/readonly\s+shouldMountFocusMode\s*=\s*computed/);
    expect(source).not.toMatch(/readonly\s+shouldMountDeferredSyncStatus\s*=\s*computed/);
    expect(source).not.toContain("gateState() === 'reviewing'");
    expect(source).not.toContain('hasPendingGateWork() ||');
    expect(source).not.toContain('pendingActionsCount() > 0');
  });

  it('keeps focus sync browser probing out of the workspace shell component', () => {
    const optionsBlock = readFocusSyncOptionsBlock();

    expect(optionsBlock).not.toContain('currentUserId:');
    expect(optionsBlock).not.toContain('getWindow:');
    expect(optionsBlock).not.toContain('typeof window');
    expect(optionsBlock).not.toContain('window)');
  });

  it('keeps tool controller low-level callback wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const baseSurfacesSource = readWorkspaceShellBaseSurfacesSource();
    const optionsBlock = readToolControllersOptionsBlock();

    expect(baseSurfacesSource).toContain('createWorkspaceShellToolSurface');
    expect(source).not.toContain('createWorkspaceShellToolControllers');
    expect(optionsBlock).not.toContain('warning:');
    expect(optionsBlock).not.toContain('dynamicLoadEnabled:');
    expect(optionsBlock).not.toContain('isBlackBoxEnabled:');
    expect(optionsBlock).not.toContain('addBreadcrumb:');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1');
    expect(optionsBlock).not.toContain('this.focusPrefs.isBlackBoxEnabled()');
    expect(optionsBlock).not.toContain('this.toast.warning');
    expect(optionsBlock).not.toContain('this.sentryLazyLoader.addBreadcrumb');
  });

  it('keeps focus chrome signal composition out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const sessionRoutingSurfaceSource = readWorkspaceShellSessionRoutingSurfaceSource();
    const chromeSurfaceSource = readChromeSurfaceSource();

    expect(sessionRoutingSurfaceSource).toContain('createWorkspaceShellChromeSurface');
    expect(source).not.toContain('createWorkspaceShellFocusChromeController');
    expect(chromeSurfaceSource).toContain('createWorkspaceShellFocusChromeController');
    expect(source).not.toContain('new WorkspaceShellFocusChromeController');
    expect(source).not.toContain('createWorkspaceSidebarChromeSignals');
    expect(source).not.toMatch(/readonly\s+focusBlurActive\s*=\s*computed/);
    expect(source).not.toMatch(/private\s+readonly\s+sidebarChrome\s*=/);
    expect(source).not.toContain('dockEngine.focusMode() && this.dockEngine.focusScrimOn()');
  });

  it('keeps floating notice chrome low-level callback wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const sessionRoutingSurfaceSource = readWorkspaceShellSessionRoutingSurfaceSource();
    const optionsBlock = readFloatingNoticeChromeOptionsBlock();

    expect(sessionRoutingSurfaceSource).toContain('createWorkspaceShellChromeSurface');
    expect(source).not.toContain('createWorkspaceShellFloatingNoticeChrome');
    expect(optionsBlock).toContain('uiState: options.uiState');
    expect(optionsBlock).toContain('networkAwareness: options.networkAwareness');
    expect(optionsBlock).toContain('syncCoordinator: options.syncCoordinator');
    expect(optionsBlock).toContain('actionQueue: options.actionQueue');
    expect(optionsBlock).toContain('userSession: options.userSession');
    expect(optionsBlock).not.toContain('isMobile: () => this.isMobile()');
    expect(optionsBlock).not.toContain('isOnline: () => this.networkAwareness.isOnline()');
    expect(optionsBlock).not.toContain('offlineMode: () => this.syncCoordinator.offlineMode()');
    expect(optionsBlock).not.toContain('queueFrozen: () => this.actionQueue.queueFrozen()');
    expect(optionsBlock).not.toContain('currentUserId: () => this.currentUserId()');
    expect(optionsBlock).not.toContain('hintOnlyStartupPlaceholderVisible: () =>');
  });

  it('keeps sync pulse lifecycle wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bprivate\s+resetFocusEntrySyncPulseState\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+dispatchFocusEntrySyncPulseIfReady\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+triggerSyncPulse\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+initializeSyncPulse\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+clearFocusEntrySyncPulseRetry\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+destroySyncPulse\s*\(/);
  });

  it('keeps destroy controller feature flag wiring out of the workspace shell component', () => {
    const optionsBlock = readDestroyControllerOptionsBlock();

    expect(optionsBlock).not.toContain('isResumeInteractionFirstEnabled:');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1');
  });

  it('keeps mobile focus gate forwarding wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bprivate\s+checkGateForMobileProjectEntry\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+warmMobileProjectGateSnapshot\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+flushPendingMobileProjectGateCheck\s*\(/);
  });

  it('keeps startup safety validation out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('WorkspaceShellCriticalFeatureFlagsController');
    expect(source).not.toContain('workspace-shell-critical-feature-flags.controller');
    expect(source).not.toMatch(/\bprivate\s+validateCriticalFeatureFlags\s*\(/);
    expect(source).not.toContain('validateCriticalFlags()');
    expect(source).not.toContain('关键安全开关被禁用');
  });

  it('keeps critical feature flags lazy-load option wiring out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain(
      "import { createWorkspaceShellCriticalFeatureFlagsDelegates",
    );
    expect(source).not.toContain('createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate');

    expect(source).not.toContain('workspace-shell-critical-feature-flags-delegates.factory');
    expect(source).not.toContain('window.location');
  });

  it('keeps startup and Android widget forwarding wrappers out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source.split(/\r?\n/).length).toBeLessThan(1000);
    expect(source).not.toMatch(/\bprivate\s+signalWorkspaceHandoffReady\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+getCurrentStartupEntryIntent\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+flushWidgetWorkspaceGateRecheck\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+consumeStartupEntryIntent\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+captureAndroidWidgetBootstrapFromRoute\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+completeAndroidWidgetBootstrap\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+syncAndroidWidgetBootstrapProcessing\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+restorePendingAndroidWidgetBootstrapFromStorage\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+restoreDeferredStartupEntryIntentFromStorage\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+persistPendingAndroidWidgetBootstrapToStorage\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+persistDeferredStartupEntryIntentToStorage\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+resolveStartupProjectFallbackId\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+resolveMobileRootStartupProjectId\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+shouldNavigateRootStartupToTextProject\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+navigateRootStartupToTextProject\s*\(/);
    expect(source).not.toMatch(/\bprivate\s+commitWorkspaceHandoff\s*\(/);
    expect(source).not.toContain('WorkspaceShellAndroidWidgetLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-android-widget-lazy-load-host.controller');
    expect(source).not.toMatch(/androidWidgetLazyLoad\s*=\s*new\s+/);
  });

  it('keeps Android widget gate mutation construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('workspace-shell-widget-gate-mutation.controller');
    expect(source).not.toMatch(/widgetGateMutation\s*=\s*new\s+/);
  });

  it('keeps Android widget browser storage probing out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('readAndroidWidgetSessionStorage');
    expect(source).not.toContain('window.sessionStorage');
  });

  it('keeps Android widget platform probing out of the workspace shell component', () => {
    const optionsBlock = readStartupEntryControllersOptionsBlock();
    const factorySource = readStartupEntryControllersFactorySource();

    expect(optionsBlock).not.toContain('getWindow:');
    expect(optionsBlock).not.toContain('getDocument:');
    expect(optionsBlock).not.toContain('readRuntimePlatform:');
    expect(optionsBlock).not.toContain('typeof window');
    expect(optionsBlock).not.toContain('typeof document');
    expect(factorySource).not.toContain('typeof window');
    expect(factorySource).not.toContain('typeof document');
  });

  it('keeps startup entry low-level callback wiring out of the workspace shell component', () => {
    const optionsBlock = readStartupEntryControllersOptionsBlock();

    expect(optionsBlock).not.toContain('isBlackBoxEnabled:');
    expect(optionsBlock).not.toContain('setSidebarOpen:');
    expect(optionsBlock).not.toContain('loadBlackBoxRecorder:');
    expect(optionsBlock).not.toContain('applyWidgetGateMutation:');
    expect(optionsBlock).not.toContain('navigate:');
    expect(optionsBlock).not.toContain('preloadSidebarTools:');
    expect(optionsBlock).not.toContain('warningToast:');
    expect(optionsBlock).not.toContain('this.focusPrefs.isBlackBoxEnabled()');
    expect(optionsBlock).not.toContain('this.isSidebarOpen.set(open)');
    expect(optionsBlock).not.toContain('this.sidebarToolsLazyLoad.');
    expect(optionsBlock).not.toContain('this.widgetGateMutation.apply(input)');
    expect(optionsBlock).not.toContain('this.router.navigate');
    expect(optionsBlock).not.toContain('this.toast.warning');
  });

  it('keeps ngOnInit startup sequencing out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const ngOnInitBody = readWorkspaceShellNgOnInitBody();
    const optionsBlock = readNgOnInitStartupOptionsBlock();

    expect(source).not.toContain('workspace-shell-ng-on-init-startup.controller');
    expect(ngOnInitBody).toContain('this.shellLifecycle.ngOnInitStartup.initialize()');
    expect(ngOnInitBody).not.toContain('this.lazyLifecycles.initializeNgOnInitStage()');
    expect(ngOnInitBody).not.toContain('this.authCoord.scheduleSessionBootstrap()');
    expect(ngOnInitBody).not.toContain('this.startupLazyServices.scheduleStartupFontInitialization()');
    expect(ngOnInitBody).not.toContain('this.startupTier.initialize()');
    expect(ngOnInitBody).not.toContain("this.sidebarToolsLazyLoad.scheduleFocusModePreload('startup')");
    expect(ngOnInitBody).not.toContain("this.sidebarToolsLazyLoad.preload('startup')");
    expect(ngOnInitBody).not.toContain('this.focusMountIntent.setup()');
    expect(ngOnInitBody).not.toContain('this.mobileFocusGate.warmMobileProjectGateSnapshot()');
    expect(ngOnInitBody).not.toContain('this.modalCoord.preloadCommonModals()');
    expect(ngOnInitBody).not.toContain('this.startupLazyServices.initializeStartupDiagnosticsLazy()');
    expect(ngOnInitBody).not.toContain('this.criticalFeatureFlags.validate()');
    expect(optionsBlock).not.toContain('isSidebarToolsDynamicLoadEnabled:');
    expect(optionsBlock).not.toContain('isTieredStartupHydration:');
    expect(optionsBlock).not.toContain('legacyStartupRuntimeNudgeMs:');
    expect(optionsBlock).not.toContain('startupDiagnosticsDelayMs:');
    expect(optionsBlock).not.toContain('LEGACY_STARTUP_RUNTIME_NUDGE_MS');
    expect(optionsBlock).not.toContain('IDLE_SCHEDULE_CONFIG.LONG_MS');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1');
    expect(optionsBlock).not.toContain('FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1');
  });

  it('keeps shell lifecycle controller construction out of the workspace shell component', () => {
    const source = readWorkspaceShellSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();

    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(source).not.toContain('createWorkspaceShellLifecycleDelegates');
    expect(source).not.toContain('createWorkspaceShellLifecycleStartupOptions');
    expect(source).not.toContain(
      'createWorkspaceShellLifecycleStartupBootstrapOptions',
    );
    expect(source).not.toContain(
      'createWorkspaceShellLifecycleAfterViewInitOptions',
    );
    expect(source).not.toContain('createWorkspaceShellLifecycleNgOnInitOptions');
    expect(source).not.toContain('createWorkspaceShellLifecycleDestroyOptions');
    expect(source).not.toContain('createWorkspaceShellStartupBootstrapController');
    expect(source).not.toContain('createWorkspaceShellNgOnInitStartupController');
    expect(source).not.toContain('createWorkspaceShellDestroyController');
  });

  it('keeps shell lifecycle option wiring behind the lifecycle surface factory', () => {
    const optionsBlock = readShellLifecycleDelegatesOptionsBlock();

    expect(optionsBlock).toContain('...options');
    expect(optionsBlock).toContain('...sessionLifecycle');
    expect(optionsBlock).not.toContain('startupBootstrap:');
    expect(optionsBlock).not.toContain('ngOnInitStartup:');
    expect(optionsBlock).not.toContain('destroyController:');
    expect(optionsBlock).not.toContain('createWorkspaceShellStartupBootstrapController');
    expect(optionsBlock).not.toContain('createWorkspaceShellNgOnInitStartupController');
    expect(optionsBlock).not.toContain('createWorkspaceShellDestroyController');
  });
}
