import { vi } from 'vitest';

import {
  WorkspaceShellStartupEntryIntentController,
  type WorkspaceShellStartupEntryIntentControllerOptions,
} from './workspace-shell-startup-entry-intent.controller';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';

export function startupIntent(input: Partial<StartupEntryIntent>): StartupEntryIntent {
  return {
    entry: 'widget',
    intent: 'open-workspace',
    rawIntent: 'open-workspace',
    widgetGateEntryId: null,
    ...input,
  };
}

export function widgetWorkspaceIntent(
  input: Partial<StartupEntryIntent> = {},
): StartupEntryIntent {
  return startupIntent(input);
}

export function blackBoxRecorderIntent(): StartupEntryIntent {
  return startupIntent({
    entry: 'shortcut',
    intent: 'open-blackbox-recorder',
    rawIntent: 'open-blackbox-recorder',
  });
}

export function focusToolsIntent(): StartupEntryIntent {
  return startupIntent({
    entry: 'shortcut',
    intent: 'open-focus-tools',
    rawIntent: 'open-focus-tools',
  });
}

export function twaWorkspaceIntent(
  input: Partial<StartupEntryIntent> = {},
): StartupEntryIntent {
  return startupIntent({
    entry: 'twa',
    intent: 'open-workspace',
    rawIntent: 'open-workspace',
    ...input,
  });
}

export function markGateReadIntent(widgetGateEntryId: string): StartupEntryIntent {
  return startupIntent({
    intent: 'mark-gate-read',
    rawIntent: 'mark-gate-read',
    widgetGateEntryId,
  });
}

export function expectGateReadApplied(
  applyWidgetGateMutation: ReturnType<typeof vi.fn>,
  widgetGateEntryId: string,
): void {
  expect(applyWidgetGateMutation).toHaveBeenCalledWith({
    intent: 'mark-gate-read',
    widgetGateEntryId,
  });
}

export function createStartupEntryIntentController(
  overrides: Partial<WorkspaceShellStartupEntryIntentControllerOptions> = {},
) {
  const applyWidgetGateMutation = vi.fn();
  const clearDeferredStartupEntryIntent = vi.fn();
  const loadBlackBoxRecorder = vi.fn();
  const navigate = vi.fn();
  const preloadSidebarTools = vi.fn();
  const primeWidgetWorkspaceGateSync = vi.fn();
  const recheckGate = vi.fn();
  const refreshFocusSessionFromCloud = vi.fn();
  const setSidebarOpen = vi.fn();
  const warn = vi.fn();
  let applicationReady = overrides.isApplicationReady?.() ?? false;
  let currentUserId = overrides.currentUserId ? overrides.currentUserId() : 'user-1';
  let routeUrl = overrides.routeUrl?.() ?? '/projects/project-1?entry=widget&intent=open-workspace';
  let currentStartupEntryIntent: StartupEntryIntent | null = null;
  let deferredStartupEntryIntent: StartupEntryIntent | null = null;
  const controller = new WorkspaceShellStartupEntryIntentController({
    routeUrl: () => routeUrl,
    currentStartupEntryIntent: () => currentStartupEntryIntent,
    deferredStartupEntryIntent: () => deferredStartupEntryIntent,
    currentUserId: () => currentUserId,
    isApplicationReady: () => applicationReady,
    isBlackBoxEnabled: () => true,
    setSidebarOpen,
    preloadSidebarTools,
    loadBlackBoxRecorder,
    applyWidgetGateMutation,
    primeWidgetWorkspaceGateSync,
    refreshFocusSessionFromCloud,
    recheckGate,
    clearDeferredStartupEntryIntent,
    resolveMobileRootProjectId: () => 'project-root',
    navigate,
    warn,
    ...overrides,
  });

  return {
    applyWidgetGateMutation,
    clearDeferredStartupEntryIntent,
    controller,
    loadBlackBoxRecorder,
    navigate,
    preloadSidebarTools,
    primeWidgetWorkspaceGateSync,
    recheckGate,
    refreshFocusSessionFromCloud,
    setApplicationReady: (ready: boolean) => {
      applicationReady = ready;
    },
    setCurrentStartupEntryIntent: (intent: StartupEntryIntent | null) => {
      currentStartupEntryIntent = intent;
    },
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setDeferredStartupEntryIntent: (intent: StartupEntryIntent | null) => {
      deferredStartupEntryIntent = intent;
    },
    setRouteUrl: (url: string) => {
      routeUrl = url;
    },
    setSidebarOpen,
    warn,
  };
}
