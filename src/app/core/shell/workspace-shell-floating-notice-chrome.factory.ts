import {
  WorkspaceShellFloatingNoticeChromeController,
  type WorkspaceShellFloatingNoticeChromeControllerOptions,
} from './workspace-shell-floating-notice-chrome.controller';

export interface WorkspaceShellFloatingNoticeChromeFactoryOptions
  extends Pick<
    WorkspaceShellFloatingNoticeChromeControllerOptions,
    'getLocalStorage' | 'installPromptVisible' | 'isDemoBannerDismissed'
  > {
  uiState: { isMobile(): boolean };
  networkAwareness: { isOnline(): boolean };
  syncCoordinator: { offlineMode(): boolean };
  actionQueue: { queueFrozen(): boolean };
  userSession: {
    currentUserId(): string | null;
    isHintOnlyStartupPlaceholderVisible(): boolean;
  };
  createController?: (
    options: WorkspaceShellFloatingNoticeChromeControllerOptions,
  ) => WorkspaceShellFloatingNoticeChromeController;
}

export function createWorkspaceShellFloatingNoticeChrome(
  options: WorkspaceShellFloatingNoticeChromeFactoryOptions,
): WorkspaceShellFloatingNoticeChromeController {
  const {
    actionQueue,
    createController = controllerOptions =>
      new WorkspaceShellFloatingNoticeChromeController(controllerOptions),
    getLocalStorage,
    installPromptVisible,
    isDemoBannerDismissed,
    networkAwareness,
    syncCoordinator,
    uiState,
    userSession,
  } = options;

  return createController({
    currentUserId: () => userSession.currentUserId(),
    getLocalStorage,
    hintOnlyStartupPlaceholderVisible: () =>
      userSession.isHintOnlyStartupPlaceholderVisible(),
    installPromptVisible,
    isDemoBannerDismissed,
    isMobile: () => uiState.isMobile(),
    isOnline: () => networkAwareness.isOnline(),
    offlineMode: () => syncCoordinator.offlineMode(),
    queueFrozen: () => actionQueue.queueFrozen(),
  });
}
