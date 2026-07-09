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
  WorkspaceShellWidgetGateMutation,
  WorkspaceShellWidgetGateMutationController,
} from './workspace-shell-widget-gate-mutation.controller';
import type { WorkspaceShellSidebarToolsHostDelegate } from './workspace-shell-sidebar-tools-lazy-load-host.controller';

type WorkspaceShellBlackBoxService =
  WorkspaceShellWidgetGateMutationFactoryOptions['blackBoxService'] & {
    createDurably(content: { content: string }): Promise<
      { ok: true } | { ok: false; error: { message: string } }
    >;
  };

type WorkspaceShellWidgetGateMutationProxyOptions = Pick<
  WorkspaceShellWidgetGateMutationFactoryOptions,
  'blackBoxService' | 'logger' | 'sidebarOpen' | 'warn'
> & {
  sidebarToolsLazyLoad: WorkspaceShellSidebarToolsHostDelegate;
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

  return {
    toolLazyLoad,
    toolTemplateBindings: toolLazyLoad.templateBindings,
    sidebarToolsLazyLoad,
    widgetGateMutation: createWorkspaceShellWidgetGateMutationProxy({
      blackBoxService,
      logger,
      sidebarOpen,
      sidebarToolsLazyLoad,
      warn,
    }),
  };
}

function createWorkspaceShellWidgetGateMutationProxy(
  options: WorkspaceShellWidgetGateMutationProxyOptions,
): Pick<WorkspaceShellWidgetGateMutationController, 'apply'> {
  let widgetGateMutationPromise: Promise<WorkspaceShellWidgetGateMutationController> | null = null;
  const getWidgetGateMutation = (): Promise<WorkspaceShellWidgetGateMutationController> => {
    widgetGateMutationPromise ??= import('./workspace-shell-widget-gate-mutation.factory')
      .then(({ createWorkspaceShellWidgetGateMutationController }) =>
        createWorkspaceShellWidgetGateMutationController({
          sidebarOpen: options.sidebarOpen,
          preloadSidebarTools: (reason) => options.sidebarToolsLazyLoad.preload(reason),
          blackBoxService: options.blackBoxService,
          logger: options.logger,
          warn: options.warn,
        })
      );
    return widgetGateMutationPromise;
  };

  return {
    apply: async (intent: WorkspaceShellWidgetGateMutation) => {
      const controller = await getWidgetGateMutation();
      await controller.apply(intent);
    },
  };
}
