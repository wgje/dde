import { ProjectShellCacheReloadController } from './project-shell-cache-reload.controller';
import { ProjectShellContentResizeController } from './project-shell-content-resize.controller';
import { createProjectShellDockTakeoverViewModel } from './project-shell-dock-takeover-view-model';
import { ProjectShellFlowIntentController } from './project-shell-flow-intent.controller';
import {
  createProjectShellGraphContext,
  type ProjectShellGraphContext,
} from './project-shell-graph-context.factory';
import { ProjectShellLifecycleController } from './project-shell-lifecycle.controller';
import { ProjectShellNewProjectModalController } from './project-shell-new-project-modal.controller';
import { ProjectShellRouteController } from './project-shell-route.controller';
import { ProjectShellTextViewSwipeController } from './project-shell-text-view-swipe.controller';
import { ProjectShellUiActionsController } from './project-shell-ui-actions.controller';
import { ProjectShellViewActionsController } from './project-shell-view-actions.controller';

function createProjectShellBaseControllers(context: ProjectShellGraphContext) {
  const dockTakeover = createProjectShellDockTakeoverViewModel({
    focusMode: context.dockEngine.focusMode,
    phase: context.dockEngine.focusChromePhase,
    scrimOn: context.dockEngine.focusScrimOn,
  });
  const cacheReload = new ProjectShellCacheReloadController({
    logger: context.logger,
  });
  const newProjectModal = new ProjectShellNewProjectModalController({
    injector: context.injector,
    logger: context.logger,
    toast: context.toast,
  });
  const flowIntent = new ProjectShellFlowIntentController({
    enabled: context.flowIntentLazyLoadEnabled,
    onActivated: source => {
      context.logger.debug('Flow lazy-load intent activated', { source });
    },
  });
  const uiActions = new ProjectShellUiActionsController({
    getTask: taskId => context.projectState.getTask(taskId),
    uiState: context.uiState,
  });
  const contentResize = new ProjectShellContentResizeController(context.uiState);

  return {
    cacheReload,
    contentResize,
    dockTakeover,
    flowIntent,
    newProjectModal,
    uiActions,
  };
}

function createProjectShellRouteController(
  context: ProjectShellGraphContext,
  flowIntent: ProjectShellFlowIntentController,
) {
  return new ProjectShellRouteController({
    activateFlowIntent: source => flowIntent.activate(source),
    flowCommand: context.flowCommand,
    flowIntentActivated: () => flowIntent.flowIntentActivated(),
    flowPrefetchOnlyActivated: flowIntent.flowPrefetchOnlyActivated,
    flowStateAwareRestoreEnabled: context.flowStateAwareRestoreEnabled,
    handoffCoordinator: context.handoffCoordinator,
    projectState: context.projectState,
    route: context.route,
    router: context.router,
    startupLaunchSnapshot: context.startupLaunchSnapshot,
    syncCoordinator: context.syncCoordinator,
    tabSync: context.tabSync,
    taskOpsAdapter: context.taskOpsAdapter,
    toast: context.toast,
    uiState: context.uiState,
    userSession: context.userSession,
  });
}

function createProjectShellInteractionControllers(
  context: ProjectShellGraphContext,
  flowIntent: ProjectShellFlowIntentController,
  routeController: ProjectShellRouteController,
) {
  const viewActions = new ProjectShellViewActionsController({
    activateFlowIntent: source => flowIntent.activate(source),
    flowCommand: context.flowCommand,
    isMobile: () => context.uiState.isMobile(),
    logger: context.logger,
    routeController,
  });
  const textViewSwipe = new ProjectShellTextViewSwipeController({
    isMobile: () => context.uiState.isMobile(),
    switchToFlow: () => viewActions.switchToFlow(),
  });

  return { textViewSwipe, viewActions };
}

function createProjectShellLifecycleController(
  context: ProjectShellGraphContext,
  contentResize: ProjectShellContentResizeController,
  routeController: ProjectShellRouteController,
  textViewSwipe: ProjectShellTextViewSwipeController,
) {
  return new ProjectShellLifecycleController({
    contentResize,
    destroyRef: context.destroyRef,
    getProjects: () => context.projectState.getProjectsWithCurrentData(),
    injector: context.injector,
    routeController,
    routerEvents: context.router.events,
    textViewSwipe,
  });
}

function createProjectShellTemplateState(
  context: ProjectShellGraphContext,
  base: ReturnType<typeof createProjectShellBaseControllers>,
) {
  return {
    collapseAnimating: base.contentResize.collapseAnimating,
    currentFilterLabel: base.uiActions.currentFilterLabel,
    dockTakeoverMainDimmed: base.dockTakeover.mainDimmed,
    dockTakeoverMainFilter: base.dockTakeover.mainFilter,
    dockTakeoverMainHidden: base.dockTakeover.mainHidden,
    dockTakeoverMainNonInteractive: base.dockTakeover.mainNonInteractive,
    dockTakeoverMainOpacity: base.dockTakeover.mainOpacity,
    dockTakeoverMainTransform: base.dockTakeover.mainTransform,
    dockTakeoverMainTransition: base.dockTakeover.mainTransition,
    dockTakeoverPhase: base.dockTakeover.phase,
    flowIntentActivated: base.flowIntent.flowIntentActivated,
    flowPrefetchOnlyActivated: base.flowIntent.flowPrefetchOnlyActivated,
    isFilterOpen: base.uiActions.isFilterOpen,
    projectState: context.projectState,
    shouldLoadFlowNow: base.flowIntent.shouldLoadFlowNow,
    shouldPrefetchFlowChunk: base.flowIntent.shouldPrefetchFlowChunk,
    uiState: context.uiState,
  };
}

export function createProjectShellControllerGraphFromContext(
  context: ProjectShellGraphContext,
) {
  const base = createProjectShellBaseControllers(context);
  const routeController = createProjectShellRouteController(
    context,
    base.flowIntent,
  );
  const interaction = createProjectShellInteractionControllers(
    context,
    base.flowIntent,
    routeController,
  );
  const lifecycle = createProjectShellLifecycleController(
    context,
    base.contentResize,
    routeController,
    interaction.textViewSwipe,
  );

  return {
    controllers: {
      cacheReload: base.cacheReload,
      contentResize: base.contentResize,
      flowIntent: base.flowIntent,
      lifecycle,
      newProjectModal: base.newProjectModal,
      routeController,
      textViewSwipe: interaction.textViewSwipe,
      uiActions: base.uiActions,
      viewActions: interaction.viewActions,
    },
    template: createProjectShellTemplateState(context, base),
  };
}

export function createProjectShellControllerGraph() {
  return createProjectShellControllerGraphFromContext(
    createProjectShellGraphContext(),
  );
}
