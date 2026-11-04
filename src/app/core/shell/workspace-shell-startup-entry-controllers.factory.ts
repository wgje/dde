import { signal, type WritableSignal } from '@angular/core';

import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  createWorkspaceShellAndroidWidgetLazyLoadControllerHost,
  createWorkspaceShellMobileRootStartupNavigationControllerHost,
  createWorkspaceShellStartupEntryIntentControllerHost,
  type WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controller-hosts.factory';
import {
  createWorkspaceShellStartupEntryIntentResolver,
} from './workspace-shell-startup-entry-intent.factory';

export type {
  WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controller-hosts.factory';

type AndroidWidgetBootstrapSignal = WritableSignal<AndroidWidgetBootstrapRequest | null>;
type AndroidWidgetCallbackSignal = WritableSignal<AndroidWidgetBootstrapCallbackResult | null>;
type DeferredStartupEntryIntentSignal = WritableSignal<StartupEntryIntent | null>;
type StartupEntryIntentController = ReturnType<
  typeof createWorkspaceShellStartupEntryIntentControllerHost
>;

export interface WorkspaceShellStartupEntryControllers {
  readonly androidWidgetLazyLoad:
    ReturnType<typeof createWorkspaceShellAndroidWidgetLazyLoadControllerHost>;
  readonly deferredStartupEntryIntent: DeferredStartupEntryIntentSignal;
  readonly mobileRootStartupNavigation:
    ReturnType<typeof createWorkspaceShellMobileRootStartupNavigationControllerHost>;
  readonly pendingAndroidWidgetBootstrap: AndroidWidgetBootstrapSignal;
  readonly pendingAndroidWidgetManualCallback: AndroidWidgetCallbackSignal;
  readonly startupEntryIntentController: StartupEntryIntentController;
  readonly startupEntryIntentResolver: () => StartupEntryIntent | null;
}

function createStartupEntrySignals(): {
  deferredStartupEntryIntent: DeferredStartupEntryIntentSignal;
  pendingAndroidWidgetBootstrap: AndroidWidgetBootstrapSignal;
  pendingAndroidWidgetManualCallback: AndroidWidgetCallbackSignal;
} {
  return {
    deferredStartupEntryIntent: signal<StartupEntryIntent | null>(null),
    pendingAndroidWidgetBootstrap: signal<AndroidWidgetBootstrapRequest | null>(null),
    pendingAndroidWidgetManualCallback: signal<AndroidWidgetBootstrapCallbackResult | null>(null),
  };
}

export function createWorkspaceShellStartupEntryControllers(
  options: WorkspaceShellStartupEntryControllersFactoryOptions,
): WorkspaceShellStartupEntryControllers {
  const {
    deferredStartupEntryIntent,
    pendingAndroidWidgetBootstrap,
    pendingAndroidWidgetManualCallback,
  } = createStartupEntrySignals();
  const startupEntryIntentResolver = createRouteStartupEntryIntentResolver(options);
  const mobileRootStartupNavigation =
    createWorkspaceShellMobileRootStartupNavigationControllerHost(
      options,
      startupEntryIntentResolver,
    );

  const startupEntryIntentControllerRef = createStartupEntryIntentControllerRef();
  const androidWidgetLazyLoad =
    createWorkspaceShellAndroidWidgetLazyLoadControllerHost(options, {
      deferredStartupEntryIntent,
      pendingAndroidWidgetBootstrap,
      pendingAndroidWidgetManualCallback,
      resolveConsumedStartupEntryNavigation: () => {
        if (!startupEntryIntentControllerRef.current) {
          throw new Error('Startup entry intent controller is not initialized');
        }

        return startupEntryIntentControllerRef.current
          .resolveConsumedStartupEntryNavigation();
      },
    });

  const startupEntryIntentController =
    composeStartupEntryTeardownWithMobileRoot(
      createWorkspaceShellStartupEntryIntentControllerHost(options, {
        deferredStartupEntryIntent,
        persistDeferredStartupEntryIntent: intent =>
          androidWidgetLazyLoad.persistDeferredStartupEntryIntent(intent),
        resolveMobileRootProjectId: () =>
          mobileRootStartupNavigation.resolveMobileRootStartupProjectId(),
      }),
      mobileRootStartupNavigation,
    );
  startupEntryIntentControllerRef.current = startupEntryIntentController;

  return {
    androidWidgetLazyLoad,
    deferredStartupEntryIntent,
    mobileRootStartupNavigation,
    pendingAndroidWidgetBootstrap,
    pendingAndroidWidgetManualCallback,
    startupEntryIntentController,
    startupEntryIntentResolver,
  };
}

function createStartupEntryIntentControllerRef(): {
  current: StartupEntryIntentController | null;
} {
  return { current: null };
}

function createRouteStartupEntryIntentResolver(
  options: WorkspaceShellStartupEntryControllersFactoryOptions,
): () => StartupEntryIntent | null {
  return createWorkspaceShellStartupEntryIntentResolver({ routeUrl: options.routeUrl });
}

function composeStartupEntryTeardownWithMobileRoot(
  startupEntryIntentController: StartupEntryIntentController,
  mobileRootStartupNavigation: ReturnType<
    typeof createWorkspaceShellMobileRootStartupNavigationControllerHost
  >,
): StartupEntryIntentController {
  let tornDown = false;

  return {
    flushWidgetWorkspaceGateRecheck: () =>
      startupEntryIntentController.flushWidgetWorkspaceGateRecheck(),
    resetPrimeState: () => startupEntryIntentController.resetPrimeState(),
    resolveConsumedStartupEntryNavigation: () =>
      startupEntryIntentController.resolveConsumedStartupEntryNavigation(),
    sync: () => startupEntryIntentController.sync(),
    teardown: () => {
      if (tornDown) return;
      tornDown = true;

      const failures: unknown[] = [];
      try {
        mobileRootStartupNavigation.destroy();
      } catch (error) {
        failures.push(error);
      }

      try {
        startupEntryIntentController.teardown();
      } catch (error) {
        failures.push(error);
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures);
    },
  };
}
