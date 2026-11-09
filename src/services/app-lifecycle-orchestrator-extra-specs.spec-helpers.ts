import { vi } from 'vitest';

import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { registerAppLifecycleAutoReloadSpecs } from './app-lifecycle-orchestrator-auto-reload.spec-helpers';
import { registerAppLifecycleFocusGateSpecs } from './app-lifecycle-orchestrator-focus-gate.spec-helpers';
import { registerAppLifecycleVersionPromptSpecs } from './app-lifecycle-orchestrator-version-prompt.spec-helpers';

type SpecMock = ReturnType<typeof vi.fn>;

export interface AppLifecycleOrchestratorExtraSpecsContext {
  service: () => AppLifecycleOrchestratorService;
  sessionManager: () => {
    validateOrRefreshOnResume: SpecMock;
    getRecentValidationSnapshot: SpecMock;
  };
  simpleSync: () => {
    recoverAfterResume: SpecMock;
    suspendTransport: SpecMock;
  };
  sentry: () => {
    addBreadcrumb: SpecMock;
    setMeasurement: SpecMock;
    captureException: SpecMock;
    captureMessage: SpecMock;
  };
  toast: () => {
    info: SpecMock;
    warning: SpecMock;
  };
  focusStartupProbe: () => {
    recheckGate: SpecMock;
    hasPendingGateWork: SpecMock;
  };
  syncCoordinator: () => {
    hasPendingLocalChanges: SpecMock;
    flushPendingPersistToCloud: SpecMock;
    refreshBlackBoxWatermarkIfNeeded: SpecMock;
  };
  reloadViaForceClearCache: SpecMock;
}

export function registerAppLifecycleOrchestratorExtraSpecs(
  context: AppLifecycleOrchestratorExtraSpecsContext,
): void {
  registerAppLifecycleAutoReloadSpecs({
    service: context.service,
    sessionManager: context.sessionManager,
    simpleSync: context.simpleSync,
    sentry: context.sentry,
    toast: context.toast,
    reloadViaForceClearCache: context.reloadViaForceClearCache,
  });

  registerAppLifecycleVersionPromptSpecs({
    service: context.service,
    toast: context.toast,
    reloadViaForceClearCache: context.reloadViaForceClearCache,
  });

  registerAppLifecycleFocusGateSpecs({
    service: context.service,
    focusStartupProbe: context.focusStartupProbe,
    simpleSync: context.simpleSync,
    sessionManager: context.sessionManager,
    syncCoordinator: context.syncCoordinator,
  });
}
