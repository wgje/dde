import {
  computed,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';

import type { GateState } from '../../../models/focus';

export type WorkspaceShellStartupTier = 'p0' | 'p1' | 'p2';

export interface WorkspaceShellMountStateControllerOptions {
  isCheckingSession: () => boolean;
  currentUserId: () => string | null;
  isAuthLoading: () => boolean;
  isAuthConfigured: () => boolean;
  gateState: () => GateState;
  isLocalModeEnabled: () => boolean;
  isThrottledFocusStartup: () => boolean;
  hasPendingGateWork: () => boolean;
  isDeferredSyncStatusMountEnabled: () => boolean;
  pendingActionsCount: () => number;
  offlineMode: () => boolean;
  isOnline: () => boolean;
  syncError: () => unknown;
  isStartupTierReady: (tier: WorkspaceShellStartupTier) => boolean;
}

export class WorkspaceShellMountStateController {
  readonly focusModeIntentActivated: WritableSignal<boolean>;

  /**
   * 首屏核心数据加载完成后才触发 FocusMode 及其 BlackBox 同步，
   * 避免登录后前 5-10s 并发请求峰值。
   */
  readonly coreDataLoaded: Signal<boolean>;

  /** FocusMode 挂载条件：探针命中待处理 gate 或用户交互 或 dev 强制显示。 */
  readonly shouldMountFocusMode: Signal<boolean>;

  readonly shouldMountDeferredSyncStatus: Signal<boolean>;

  constructor(
    private readonly options: WorkspaceShellMountStateControllerOptions,
  ) {
    this.focusModeIntentActivated = signal(!this.options.isThrottledFocusStartup());
    this.coreDataLoaded = computed(() => this.isCoreDataLoaded());
    this.shouldMountFocusMode = computed(() => this.canMountFocusMode());
    this.shouldMountDeferredSyncStatus = computed(() =>
      this.canMountDeferredSyncStatus(),
    );
  }

  private isCoreDataLoaded(): boolean {
    const sessionCheckDone = !this.options.isCheckingSession();
    const hasUser = !!this.options.currentUserId();
    const notAuthLoading = !this.options.isAuthLoading();
    return sessionCheckDone && hasUser && notAuthLoading;
  }

  private canMountFocusMode(): boolean {
    if (this.options.gateState() === 'reviewing') return true;

    const sessionCheckDone = !this.options.isCheckingSession();
    const notAuthLoading = !this.options.isAuthLoading();
    const hasFocusModeAccess =
      !!this.options.currentUserId() ||
      this.options.isLocalModeEnabled() ||
      !this.options.isAuthConfigured();

    if (!sessionCheckDone || !notAuthLoading || !hasFocusModeAccess) {
      return false;
    }
    if (!this.options.isThrottledFocusStartup()) return true;
    return this.options.hasPendingGateWork() || this.focusModeIntentActivated();
  }

  private canMountDeferredSyncStatus(): boolean {
    if (!this.options.isDeferredSyncStatusMountEnabled()) {
      return true;
    }

    const sessionCheckDone = !this.options.isCheckingSession();
    if (sessionCheckDone) {
      return true;
    }

    const hasSyncIssue =
      this.options.pendingActionsCount() > 0 ||
      this.options.offlineMode() ||
      !this.options.isOnline() ||
      !!this.options.syncError();

    return this.options.isStartupTierReady('p2') || hasSyncIssue;
  }
}
