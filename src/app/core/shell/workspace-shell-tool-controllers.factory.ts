import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

import {
  createWorkspaceShellToolLazyLoadDelegates,
  type WorkspaceShellToolLazyLoadDelegateOptions,
  type WorkspaceShellToolLazyLoadDelegates,
  type WorkspaceShellToolLazyLoadTemplateBindings,
} from './workspace-shell-tool-lazy-load-delegates.factory';
import type {
  WorkspaceShellWidgetGateMutationFactoryOptions,
} from './workspace-shell-widget-gate-mutation.factory';
import type {
  WorkspaceShellWidgetGateMutationController,
} from './workspace-shell-widget-gate-mutation.controller';
import {
  WorkspaceShellWidgetGateMutationLazyLoadController,
} from './workspace-shell-widget-gate-mutation-lazy-load.controller';
import type { WorkspaceShellSidebarToolsHostDelegate } from './workspace-shell-sidebar-tools-lazy-load-host.controller';

type WorkspaceShellBlackBoxService =
  WorkspaceShellWidgetGateMutationFactoryOptions['blackBoxService'] & {
    createDurably(content: { content: string }): Promise<
      { ok: true } | { ok: false; error: { message: string } }
    >;
  };

export interface WorkspaceShellToolControllersOptions
  extends Omit<
    WorkspaceShellToolLazyLoadDelegateOptions,
    | 'addBreadcrumb'
    | 'createBlackBoxEntry'
    | 'dynamicLoadEnabled'
    | 'isBlackBoxEnabled'
    | 'warning'
  >,
  Omit<
    WorkspaceShellWidgetGateMutationFactoryOptions,
    'blackBoxService' | 'preloadSidebarTools' | 'warn'
  > {
  blackBoxService: WorkspaceShellBlackBoxService;
  toast: {
    warning: WorkspaceShellToolLazyLoadDelegateOptions['warning'];
  };
  focusPrefs: {
    isBlackBoxEnabled: WorkspaceShellToolLazyLoadDelegateOptions['isBlackBoxEnabled'];
  };
  sentryLazyLoader: {
    addBreadcrumb: WorkspaceShellToolLazyLoadDelegateOptions['addBreadcrumb'];
  };
  warn: WorkspaceShellToolLazyLoadDelegateOptions['warn'];
  createToolLazyLoadDelegates?: (
    options: WorkspaceShellToolLazyLoadDelegateOptions
  ) => WorkspaceShellToolLazyLoadDelegates;
}

export interface WorkspaceShellToolControllers {
  readonly toolLazyLoad: WorkspaceShellToolLazyLoadDelegates;
  readonly toolTemplateBindings: WorkspaceShellToolLazyLoadTemplateBindings;
  readonly sidebarToolsLazyLoad: WorkspaceShellSidebarToolsHostDelegate;
  readonly widgetGateMutation: Pick<WorkspaceShellWidgetGateMutationController, 'apply'>;
  readonly panelToolsIntent?: WorkspaceShellPanelToolsIntentHolder;
}

export interface WorkspaceShellPanelToolsIntentSubscription {
  readonly unregister: () => void;
}

export interface WorkspaceShellPanelToolsIntentHolder {
  readonly register: (handler: () => void) => WorkspaceShellPanelToolsIntentSubscription;
  readonly emit: () => void;
}

export function createWorkspaceShellPanelToolsIntentHolder(): WorkspaceShellPanelToolsIntentHolder {
  let handler: (() => void) | null = null;
  let generation = 0;
  let pendingEmit = false;

  return {
    register(registeredHandler: () => void): WorkspaceShellPanelToolsIntentSubscription {
      if (typeof registeredHandler !== 'function') {
        throw new TypeError('Panel tools intent holder requires a handler function');
      }

      const registeredGeneration = ++generation;
      handler = registeredHandler;
      if (pendingEmit) {
        pendingEmit = false;
        registeredHandler();
      }

      return {
        unregister: () => {
          if (
            handler === registeredHandler
            && generation === registeredGeneration
          ) {
            handler = null;
            generation += 1;
          }
        },
      };
    },
    emit: () => {
      if (handler) {
        handler();
        return;
      }
      pendingEmit = true;
    },
  };
}

export function createWorkspaceShellToolControllers(
  options: WorkspaceShellToolControllersOptions,
): WorkspaceShellToolControllers {
  const {
    blackBoxService,
    createToolLazyLoadDelegates = createWorkspaceShellToolLazyLoadDelegates,
    focusPrefs,
    logger,
    sentryLazyLoader,
    sidebarOpen,
    toast,
    warn,
    ...toolDelegateOptions
  } = options;
  const toolLazyLoad = createToolLazyLoadDelegates({
    ...toolDelegateOptions,
    warning: (title, message) => toast.warning(title, message),
    dynamicLoadEnabled: () => FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1,
    isBlackBoxEnabled: () => focusPrefs.isBlackBoxEnabled(),
    addBreadcrumb: (breadcrumb) => sentryLazyLoader.addBreadcrumb(breadcrumb),
    createBlackBoxEntry: (content) =>
      blackBoxService.createDurably({ content }),
    warn,
  });
  const sidebarToolsLazyLoad = toolLazyLoad.sidebarToolsLazyLoad;
  const panelToolsIntent = createWorkspaceShellPanelToolsIntentHolder();

  return {
    toolLazyLoad,
    toolTemplateBindings: toolLazyLoad.templateBindings,
    sidebarToolsLazyLoad,
    widgetGateMutation: new WorkspaceShellWidgetGateMutationLazyLoadController({
      loadController: () => import('./workspace-shell-widget-gate-mutation.factory')
        .then(({ createWorkspaceShellWidgetGateMutationController }) =>
          createWorkspaceShellWidgetGateMutationController({
            sidebarOpen,
            preloadSidebarTools: reason => sidebarToolsLazyLoad.preload(reason),
            blackBoxService,
            logger,
            warn,
          })
        ),
    }),
    panelToolsIntent,
  };
}
