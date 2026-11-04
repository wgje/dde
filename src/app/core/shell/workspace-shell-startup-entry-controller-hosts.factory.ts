import type { WritableSignal } from '@angular/core';

import type { Project } from '../../../models';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  createWorkspaceShellAndroidWidgetLazyLoadController,
  type WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
} from './workspace-shell-android-widget-lazy-load.factory';
import type { WorkspaceShellAndroidWidgetLazyLoadDelegate } from './workspace-shell-android-widget-lazy-load-delegate.factory';
import {
  WorkspaceShellMobileRootStartupNavigationController,
  type WorkspaceShellMobileRootStartupNavigationControllerOptions,
} from './workspace-shell-mobile-root-startup-navigation.controller';
import {
  createWorkspaceShellStartupEntryIntentController,
  type WorkspaceShellStartupEntryIntentControllerLike,
  type WorkspaceShellStartupEntryIntentFactoryOptions,
} from './workspace-shell-startup-entry-intent.factory';

type AndroidWidgetBootstrapSignal = WritableSignal<AndroidWidgetBootstrapRequest | null>;
type AndroidWidgetCallbackSignal = WritableSignal<AndroidWidgetBootstrapCallbackResult | null>;
type DeferredStartupEntryIntentSignal = WritableSignal<StartupEntryIntent | null>;

type StartupEntryIntentOptions = Omit<
  WorkspaceShellStartupEntryIntentFactoryOptions,
  | 'deferredStartupEntryIntent'
  | 'createStartupEntryIntentController'
  | 'navigate'
  | 'persistDeferredStartupEntryIntent'
  | 'resolveMobileRootProjectId'
>;

type AndroidWidgetOptions = Omit<
  WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
  | 'deferredStartupEntryIntent'
  | 'navigate'
  | 'pendingBootstrap'
  | 'pendingCallback'
  | 'resolveConsumedStartupEntryNavigation'
>;

type MobileRootNavigationOptions = Omit<
  WorkspaceShellMobileRootStartupNavigationControllerOptions,
  'startupEntryIntent'
>;

export interface WorkspaceShellStartupEntryControllersFactoryOptions
  extends StartupEntryIntentOptions,
    AndroidWidgetOptions,
    MobileRootNavigationOptions {
  navigate: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions['navigate'];
  createAndroidWidgetLazyLoadController?: (
    options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
  ) => WorkspaceShellAndroidWidgetLazyLoadDelegate;
  createMobileRootStartupNavigation?: (
    options: WorkspaceShellMobileRootStartupNavigationControllerOptions,
  ) => WorkspaceShellMobileRootStartupNavigationController;
  createStartupEntryIntentController?: (
    options: WorkspaceShellStartupEntryIntentFactoryOptions,
  ) => WorkspaceShellStartupEntryIntentControllerLike;
  projects: () => readonly Pick<Project, 'id'>[];
}

export function createWorkspaceShellMobileRootStartupNavigationControllerHost(
  options: WorkspaceShellStartupEntryControllersFactoryOptions,
  startupEntryIntentResolver: () => StartupEntryIntent | null,
): WorkspaceShellMobileRootStartupNavigationController {
  const createController = options.createMobileRootStartupNavigation
    ?? (controllerOptions =>
      new WorkspaceShellMobileRootStartupNavigationController(controllerOptions));

  return createController({
    activeProjectId: options.activeProjectId,
    isMobile: options.isMobile,
    navigateToTextProject: options.navigateToTextProject,
    projects: options.projects,
    routeUrl: options.routeUrl,
    startupEntryIntent: startupEntryIntentResolver,
    startupLaunchSnapshot: options.startupLaunchSnapshot,
    warn: options.warn,
  });
}

export function createWorkspaceShellAndroidWidgetLazyLoadControllerHost(
  options: WorkspaceShellStartupEntryControllersFactoryOptions,
  managed: {
    deferredStartupEntryIntent: DeferredStartupEntryIntentSignal;
    pendingAndroidWidgetBootstrap: AndroidWidgetBootstrapSignal;
    pendingAndroidWidgetManualCallback: AndroidWidgetCallbackSignal;
    resolveConsumedStartupEntryNavigation: () => unknown[];
  },
): WorkspaceShellAndroidWidgetLazyLoadDelegate {
  const createController = options.createAndroidWidgetLazyLoadController
    ?? createWorkspaceShellAndroidWidgetLazyLoadController;

  return createController({
    ...options,
    deferredStartupEntryIntent: managed.deferredStartupEntryIntent,
    pendingBootstrap: managed.pendingAndroidWidgetBootstrap,
    pendingCallback: managed.pendingAndroidWidgetManualCallback,
    resolveConsumedStartupEntryNavigation: managed.resolveConsumedStartupEntryNavigation,
  });
}

export function createWorkspaceShellStartupEntryIntentControllerHost(
  options: WorkspaceShellStartupEntryControllersFactoryOptions,
  managed: {
    deferredStartupEntryIntent: DeferredStartupEntryIntentSignal;
    persistDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
    resolveMobileRootProjectId: () => string | null;
  },
): WorkspaceShellStartupEntryIntentControllerLike {
  const createController = options.createStartupEntryIntentController
    ?? createWorkspaceShellStartupEntryIntentController;
  const {
    createAndroidWidgetLazyLoadController,
    createMobileRootStartupNavigation,
    createStartupEntryIntentController: createStartupEntryIntent,
    ...controllerOptions
  } = options;

  void createAndroidWidgetLazyLoadController;
  void createMobileRootStartupNavigation;
  void createStartupEntryIntent;

  return createController({
    ...controllerOptions,
    deferredStartupEntryIntent: managed.deferredStartupEntryIntent,
    persistDeferredStartupEntryIntent: managed.persistDeferredStartupEntryIntent,
    resolveMobileRootProjectId: managed.resolveMobileRootProjectId,
  });
}
