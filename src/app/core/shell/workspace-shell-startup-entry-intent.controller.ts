import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { resolveWidgetWorkspaceGatePrimeKey } from './workspace-shell-android-widget-bootstrap.helpers';
import { resolveWorkspaceStartupEntryIntentAction } from './workspace-shell-startup-intent.helpers';
import {
  resolveConsumedStartupEntryNavigation,
  type ConsumedStartupEntryNavigationCommands,
} from './workspace-shell-startup-route.helpers';

export interface WorkspaceShellStartupEntryIntentControllerOptions {
  routeUrl: () => string;
  currentStartupEntryIntent: () => StartupEntryIntent | null;
  deferredStartupEntryIntent: () => StartupEntryIntent | null;
  currentUserId: () => string | null;
  isApplicationReady: () => boolean;
  isBlackBoxEnabled: () => boolean;
  setSidebarOpen: (open: boolean) => void;
  preloadSidebarTools: (reason: 'intent') => void;
  loadBlackBoxRecorder: () => Promise<void> | void;
  applyWidgetGateMutation: (input: {
    intent: 'mark-gate-read' | 'mark-gate-complete';
    widgetGateEntryId: string | null;
  }) => Promise<unknown> | unknown;
  primeWidgetWorkspaceGateSync: () => void;
  refreshFocusSessionFromCloud: (userId: string | null) => unknown;
  recheckGate: (options: { source: 'widget-open-workspace'; reloadLocal: false }) => Promise<void> | void;
  clearDeferredStartupEntryIntent: () => void;
  resolveMobileRootProjectId: () => string | null;
  navigate: (
    commands: ConsumedStartupEntryNavigationCommands,
    options: { replaceUrl: true },
  ) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupEntryIntentController {
  private primedWidgetWorkspaceGateSyncKey: string | null = null;
  private pendingWidgetWorkspaceGateRecheckKey: string | null = null;
  private widgetWorkspaceGateRecheckInFlightKey: string | null = null;
  private handledStartupEntryIntentKey: string | null = null;
  private pendingStartupEntryQueryCleanupKey: string | null = null;
  private startupEntryQueryCleanupInFlightKey: string | null = null;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellStartupEntryIntentControllerOptions) {}

  resetPrimeState(): void {
    if (this.isTornDown) {
      return;
    }

    this.primedWidgetWorkspaceGateSyncKey = null;
  }

  sync(): void {
    if (this.isTornDown) {
      return;
    }

    const currentStartupEntryIntent = this.options.currentStartupEntryIntent();
    const deferredStartupEntryIntent = this.options.deferredStartupEntryIntent();
    const startupEntryIntent = currentStartupEntryIntent ?? deferredStartupEntryIntent;
    if (!startupEntryIntent) {
      this.handledStartupEntryIntentKey = null;
      this.resetPrimeState();
      return;
    }

    this.primeWidgetWorkspaceGateSync(startupEntryIntent);

    // Android widget bootstrap 路由的 query 清理由 bootstrap capture 路径独占：
    // 同一 tick 内 capture 效果会捕获参数、写入 deferred intent 并自行 replaceUrl 清理，
    // sync 若并行消费会产生重复导航与 capture/cleanup key 漂移
    if (currentStartupEntryIntent?.androidWidgetBootstrap === true) {
      return;
    }

    if (!this.options.isApplicationReady()) {
      return;
    }

    const startupEntryIntentKey = `${startupEntryIntent.entry}:${startupEntryIntent.rawIntent ?? ''}:${this.options.routeUrl()}`;
    if (this.handledStartupEntryIntentKey === startupEntryIntentKey) {
      if (
        this.options.currentStartupEntryIntent()
        && this.pendingStartupEntryQueryCleanupKey === startupEntryIntentKey
      ) {
        this.consumeStartupEntryIntent(startupEntryIntentKey);
      }
      return;
    }

    this.handledStartupEntryIntentKey = startupEntryIntentKey;
    this.applyStartupEntryIntentForSync(
      startupEntryIntent,
      startupEntryIntentKey,
      currentStartupEntryIntent,
      deferredStartupEntryIntent,
    );
    if (currentStartupEntryIntent) {
      this.consumeStartupEntryIntent(startupEntryIntentKey);
    }
  }

  private applyStartupEntryIntentForSync(
    startupEntryIntent: StartupEntryIntent,
    startupEntryIntentKey: string,
    currentStartupEntryIntent: StartupEntryIntent | null,
    deferredStartupEntryIntent: StartupEntryIntent | null,
  ): void {
    const shouldClearDeferred = this.shouldClearDeferredStartupEntryIntent(
      currentStartupEntryIntent,
      deferredStartupEntryIntent,
    );
    const action = resolveWorkspaceStartupEntryIntentAction(startupEntryIntent, {
      blackBoxEnabled: this.options.isBlackBoxEnabled(),
    });
    if (action.kind === 'widget-gate-mutation') {
      // 网关变更是异步持久化动作：deferred intent 只能在变更成功后清除，
      // 否则懒加载/持久化失败会让 deferred 重放永久丢失且 handled key 阻止重试
      this.primeWidgetWorkspaceGateSync(startupEntryIntent);
      this.applyWidgetGateMutationWithRecovery(startupEntryIntent, {
        startupEntryIntentKey,
        clearDeferredAfterSuccess: shouldClearDeferred,
      });
      return;
    }

    this.apply(startupEntryIntent);
    if (shouldClearDeferred) {
      this.options.clearDeferredStartupEntryIntent();
    }
  }

  apply(startupEntryIntent: StartupEntryIntent): void {
    if (this.isTornDown) {
      return;
    }

    this.primeWidgetWorkspaceGateSync(startupEntryIntent);

    const action = resolveWorkspaceStartupEntryIntentAction(startupEntryIntent, {
      blackBoxEnabled: this.options.isBlackBoxEnabled(),
    });

    switch (action.kind) {
      case 'widget-gate-mutation':
        this.applyWidgetGateMutationWithRecovery(startupEntryIntent, null);
        return;
      case 'open-sidebar-tools':
        this.options.setSidebarOpen(true);
        this.options.preloadSidebarTools('intent');

        if (action.loadBlackBoxRecorder) {
          this.loadBlackBoxRecorder();
        }
        return;
      case 'none':
        return;
    }
  }

  primeWidgetWorkspaceGateSync(startupEntryIntent: StartupEntryIntent): void {
    if (this.isTornDown) {
      return;
    }

    const primeKey = resolveWidgetWorkspaceGatePrimeKey(startupEntryIntent, this.options.routeUrl());
    if (!primeKey) {
      return;
    }

    const currentUserId = this.options.currentUserId();
    if (!currentUserId) {
      this.pendingWidgetWorkspaceGateRecheckKey = primeKey;
      return;
    }

    if (this.primedWidgetWorkspaceGateSyncKey === primeKey) {
      return;
    }

    this.primedWidgetWorkspaceGateSyncKey = primeKey;
    this.options.primeWidgetWorkspaceGateSync();
    this.refreshFocusSessionFromCloud(currentUserId);

    this.pendingWidgetWorkspaceGateRecheckKey = primeKey;
    this.flushWidgetWorkspaceGateRecheck();
  }

  flushWidgetWorkspaceGateRecheck(): void {
    if (this.isTornDown) {
      return;
    }

    if (!this.pendingWidgetWorkspaceGateRecheckKey) {
      return;
    }

    if (!this.options.isApplicationReady()) {
      return;
    }

    const currentUserId = this.options.currentUserId();
    if (!currentUserId) {
      return;
    }

    if (this.primedWidgetWorkspaceGateSyncKey !== this.pendingWidgetWorkspaceGateRecheckKey) {
      this.primedWidgetWorkspaceGateSyncKey = this.pendingWidgetWorkspaceGateRecheckKey;
      this.options.primeWidgetWorkspaceGateSync();
      this.refreshFocusSessionFromCloud(currentUserId);
    }

    this.recheckWidgetWorkspaceGate(this.pendingWidgetWorkspaceGateRecheckKey);
  }

  resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands {
    return resolveConsumedStartupEntryNavigation({
      routeUrl: this.options.routeUrl(),
      mobileRootProjectId: this.options.resolveMobileRootProjectId,
    });
  }

  teardown(): void {
    this.isTornDown = true;
    this.primedWidgetWorkspaceGateSyncKey = null;
    this.pendingWidgetWorkspaceGateRecheckKey = null;
    this.widgetWorkspaceGateRecheckInFlightKey = null;
    this.handledStartupEntryIntentKey = null;
    this.pendingStartupEntryQueryCleanupKey = null;
    this.startupEntryQueryCleanupInFlightKey = null;
  }

  private consumeStartupEntryIntent(startupEntryIntentKey: string): void {
    if (this.isTornDown) {
      return;
    }

    if (this.startupEntryQueryCleanupInFlightKey === startupEntryIntentKey) {
      return;
    }

    this.pendingStartupEntryQueryCleanupKey = startupEntryIntentKey;
    this.startupEntryQueryCleanupInFlightKey = startupEntryIntentKey;

    try {
      void Promise.resolve(this.options.navigate(
        this.resolveConsumedStartupEntryNavigation(),
        { replaceUrl: true },
      )).then((navigationResult) => {
        if (this.isTornDown) {
          return;
        }

        if (navigationResult === false || navigationResult === null) {
          this.warn(
            'Startup entry query cleanup navigation failed',
            new Error('Router did not confirm startup entry query cleanup navigation'),
          );
          return;
        }

        if (this.pendingStartupEntryQueryCleanupKey === startupEntryIntentKey) {
          this.pendingStartupEntryQueryCleanupKey = null;
        }
      }).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        if (this.startupEntryQueryCleanupInFlightKey === startupEntryIntentKey) {
          this.startupEntryQueryCleanupInFlightKey = null;
        }
        this.warn('Startup entry query cleanup navigation failed', error);
      }).finally(() => {
        if (this.isTornDown) {
          return;
        }

        if (this.startupEntryQueryCleanupInFlightKey === startupEntryIntentKey) {
          this.startupEntryQueryCleanupInFlightKey = null;
        }
      });
    } catch (error) {
      this.startupEntryQueryCleanupInFlightKey = null;
      this.warn('Startup entry query cleanup navigation failed', error);
    }
  }

  /**
   * 隔离 widget gate mutation 的异步失败：
   * - 懒加载 chunk / 持久化失败不再以 unhandled rejection 逃逸出 signal effect 链
   * - sync() 语境下失败会释放 handled key（保留 deferred intent），让下一次 sync 可重放
   * - 成功后才清除 deferred intent（syncContext.clearDeferredAfterSuccess）
   */
  private applyWidgetGateMutationWithRecovery(
    startupEntryIntent: StartupEntryIntent,
    syncContext: { startupEntryIntentKey: string; clearDeferredAfterSuccess: boolean } | null,
  ): void {
    const input = {
      intent: startupEntryIntent.intent === 'mark-gate-read'
        ? 'mark-gate-read' as const
        : 'mark-gate-complete' as const,
      widgetGateEntryId: startupEntryIntent.widgetGateEntryId,
    };

    const handleFailure = (error: unknown): void => {
      this.warn('Startup entry widget gate mutation failed', error);
      if (!syncContext) {
        return;
      }
      if (this.handledStartupEntryIntentKey === syncContext.startupEntryIntentKey) {
        this.handledStartupEntryIntentKey = null;
      }
    };

    try {
      void Promise.resolve(this.options.applyWidgetGateMutation(input)).then(() => {
        if (this.isTornDown) {
          return;
        }
        if (syncContext?.clearDeferredAfterSuccess) {
          this.options.clearDeferredStartupEntryIntent();
        }
      }).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }
        handleFailure(error);
      });
    } catch (error) {
      handleFailure(error);
    }
  }

  private shouldClearDeferredStartupEntryIntent(
    currentStartupEntryIntent: StartupEntryIntent | null,
    deferredStartupEntryIntent: StartupEntryIntent | null,
  ): boolean {
    if (!deferredStartupEntryIntent) {
      return true;
    }

    if (!currentStartupEntryIntent) {
      return true;
    }

    return areSameStartupEntryIntent(currentStartupEntryIntent, deferredStartupEntryIntent);
  }

  private loadBlackBoxRecorder(): void {
    try {
      void Promise.resolve(this.options.loadBlackBoxRecorder()).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        this.warn('Startup entry black box recorder preload failed', error);
      });
    } catch (error) {
      this.warn('Startup entry black box recorder preload failed', error);
    }
  }

  private refreshFocusSessionFromCloud(userId: string): void {
    try {
      void Promise.resolve(this.options.refreshFocusSessionFromCloud(userId)).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        this.warn('Startup entry widget workspace gate cloud refresh failed', error);
      });
    } catch (error) {
      this.warn('Startup entry widget workspace gate cloud refresh failed', error);
    }
  }

  private recheckWidgetWorkspaceGate(recheckKey: string): void {
    if (this.isTornDown) {
      return;
    }

    if (this.widgetWorkspaceGateRecheckInFlightKey) {
      return;
    }

    this.widgetWorkspaceGateRecheckInFlightKey = recheckKey;
    const recheckOwnerUserId = this.options.currentUserId();

    try {
      void Promise.resolve(this.options.recheckGate({
        source: 'widget-open-workspace',
        reloadLocal: false,
      })).then(() => {
        this.consumePendingGateRecheckAfterSuccess(recheckKey, recheckOwnerUserId);
      }).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        this.warn('Startup entry widget workspace gate recheck failed', error);
      }).finally(() => {
        if (this.isTornDown) {
          return;
        }

        if (this.widgetWorkspaceGateRecheckInFlightKey === recheckKey) {
          this.widgetWorkspaceGateRecheckInFlightKey = null;
        }
        this.flushPendingGateRecheckAfterSettle(recheckKey);
      });
    } catch (error) {
      this.widgetWorkspaceGateRecheckInFlightKey = null;
      this.warn('Startup entry widget workspace gate recheck failed', error);
      this.flushPendingGateRecheckAfterSettle(recheckKey);
    }
  }

  private consumePendingGateRecheckAfterSuccess(
    recheckKey: string,
    recheckOwnerUserId: string | null,
  ): void {
    if (this.isTornDown) {
      return;
    }

    // owner 在 recheck 期间切换：旧 owner 的完成结果不消费 pending key，
    // 保留待办让新 owner 的下一次 flush 重新执行网关复查（对齐 bootstrap 完成的 owner 作用域守卫）
    if (this.options.currentUserId() !== recheckOwnerUserId) {
      return;
    }

    if (this.pendingWidgetWorkspaceGateRecheckKey === recheckKey) {
      this.pendingWidgetWorkspaceGateRecheckKey = null;
    }
  }

  private flushPendingGateRecheckAfterSettle(recheckKey: string): void {
    if (
      this.pendingWidgetWorkspaceGateRecheckKey
      && this.pendingWidgetWorkspaceGateRecheckKey !== recheckKey
    ) {
      this.flushWidgetWorkspaceGateRecheck();
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not re-enter startup cleanup or gate retry chains.
    }
  }
}

function areSameStartupEntryIntent(
  left: StartupEntryIntent,
  right: StartupEntryIntent,
): boolean {
  return left.entry === right.entry
    && left.intent === right.intent
    && left.rawIntent === right.rawIntent
    && left.widgetGateEntryId === right.widgetGateEntryId
    && left.androidWidgetBootstrap === right.androidWidgetBootstrap;
}
