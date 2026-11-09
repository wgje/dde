import { WorkspaceShellStartupBootstrapController } from './workspace-shell-startup-bootstrap.controller';

export interface WorkspaceShellSignalSetter<T> {
  set(value: T): void;
}

export interface WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks> {
  isMobile: () => boolean;
  isSidebarOpen: WorkspaceShellSignalSetter<boolean>;
  lazyLifecycles: { initializeConstructorStage(): void };
  conflictHandler: { setup(): void };
  sidebarToggleEvent: { setup(): void };
  storageEscape: { setup(): void; teardown(): void };
  beforeUnloadController: { setup(): void };
  modalCallbacks: { createCallbacks(): TModalCallbacks | Promise<TModalCallbacks> };
  modalCoord: { initCallbacks(callbacks: TModalCallbacks): void };
  appLifecycle: { initialize(): void };
  userSession: { prehydrateFromSnapshot(): void };
  androidWidgetLazyLoad: { restoreAll(): void };
  signalEffects: { setup(): void };
  /** 模态回调懒加载失败告警通道（可选，缺省时保持静默兼容旧调用方） */
  warn?: (message: string, error: unknown) => void;
}

export function createWorkspaceShellStartupBootstrapController<TModalCallbacks>(
  options: WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>,
): WorkspaceShellStartupBootstrapController<TModalCallbacks> {
  return new WorkspaceShellStartupBootstrapController<TModalCallbacks>({
    isMobile: options.isMobile,
    setSidebarOpen: (open) => options.isSidebarOpen.set(open),
    initializeSwUpdateLifecycle: () =>
      options.lazyLifecycles.initializeConstructorStage(),
    setupConflictHandler: () => options.conflictHandler.setup(),
    setupSidebarToggleEvent: () => options.sidebarToggleEvent.setup(),
    setupStorageEscape: () => options.storageEscape.setup(),
    setupBeforeUnload: () => options.beforeUnloadController.setup(),
    createModalCallbacks: () => options.modalCallbacks.createCallbacks(),
    initModalCallbacks: (callbacks) => options.modalCoord.initCallbacks(callbacks),
    initializeAppLifecycle: () => options.appLifecycle.initialize(),
    prehydrateUserSessionFromSnapshot: () =>
      options.userSession.prehydrateFromSnapshot(),
    restoreAndroidWidgetState: () => options.androidWidgetLazyLoad.restoreAll(),
    setupSignalEffects: () => options.signalEffects.setup(),
    warn: options.warn,
  });
}
