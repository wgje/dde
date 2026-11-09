import type { NgZone } from '@angular/core';
import * as go from 'gojs';

import type { ActiveProjectOwner } from '../../../../services/project-state.service';
import type { ViewState } from './flow-zoom.service';
import type { FlowDiagramViewportApplicationProof } from './flow-diagram-viewport-readiness.controller';
import {
  applyFlowViewState,
  canPersistFlowViewState,
  detectFlowDevicePixelRatioChange,
  getCurrentFlowViewStateSnapshot,
  getSafeDevicePixelRatio,
  hasVisibleFlowDiagramContent,
  isSafeFlowDiagramSize,
  selectBestFlowViewState,
} from './flow-diagram-view-state.helpers';
import {
  resolveFlowDiagramHardRecoveryStart,
  resolveFlowDiagramRecoveryVerificationAction,
} from './flow-diagram-recovery.helpers';

export interface FlowDiagramHardRecoveryToken {
  readonly projectId: string;
  readonly generation: number;
  readonly owner: ActiveProjectOwner;
}

interface FlowDiagramRecoveryRuntime {
  getDiagram: () => go.Diagram | null;
  getDiagramDiv: () => HTMLDivElement | null;
  isDestroyed: () => boolean;
  getPersistedViewState: () => ViewState | null;
  getSelectedNodeKeys: () => string[];
  getShouldRestoreOverview: () => boolean;
  getOverviewContainer: () => HTMLDivElement | null;
  updateDiagram: (forceRefresh: boolean) => boolean;
  applyHardRecoveryViewport: (
    viewState: ViewState | null,
    complete: (proof: FlowDiagramViewportApplicationProof | null) => void,
  ) => boolean;
  completeHardRecovery: (proof: FlowDiagramViewportApplicationProof) => boolean;
  abortHardRecovery: (token: FlowDiagramHardRecoveryToken) => void;
  restoreOverviewAfterRecovery: (container: HTMLDivElement) => void;
  attemptPendingOverviewRestore: () => void;
  teardownDiagramForRecovery: () => void;
  initializeOutsideZone: (container: HTMLDivElement, token: FlowDiagramHardRecoveryToken) => boolean;
  beginHardRecovery: () => FlowDiagramHardRecoveryToken | null;
  isHardRecoveryCurrent: (token: FlowDiagramHardRecoveryToken) => boolean;
  releaseHardRecovery: (token: FlowDiagramHardRecoveryToken) => boolean;
  cleanupFailedHardRecovery: () => void;
  restoreDropHandler: () => void;
  selectMultiple: (keys: string[]) => void;
  requestFitToContents: () => void;
  requestCancelPendingViewStateSave: () => void;
  saveViewState: () => void;
  refreshOverview: () => void;
  info: (message: string, context?: unknown) => void;
  warn: (message: string, context?: unknown) => void;
  error: (message: string, context?: unknown) => void;
  captureException: (error: unknown, context: { tags: Record<string, string> }) => void;
}

export class FlowDiagramRecoveryController {
  private resizeRecoveryRafId: number | null = null;
  private resizeRecoveryArmed = false;
  private lastRecoverableViewState: ViewState | null = null;
  private lastStableViewState: ViewState | null = null;
  private lastKnownDevicePixelRatio = 1;
  private hardRecoveryAttemptCount = 0;
  private hardRecoveryInProgress = false;
  private hardRecoveryToken: FlowDiagramHardRecoveryToken | null = null;
  private hardRecoveryViewState: ViewState | null = null;
  private recoveryFitFallbackUsed = false;

  constructor(
    private readonly zone: Pick<NgZone, 'runOutsideAngular'>,
    private readonly maxHardRecoveryAttempts: number,
    private readonly runtime: FlowDiagramRecoveryRuntime,
  ) {}

  get isHardRecoveryInProgress(): boolean {
    return this.hardRecoveryInProgress;
  }

  resetForInitialize(container: HTMLDivElement, token?: FlowDiagramHardRecoveryToken): void {
    const preserveHardRecovery = token !== undefined
      && token === this.hardRecoveryToken
      && this.runtime.isHardRecoveryCurrent(token);
    if (!preserveHardRecovery) {
      this.hardRecoveryAttemptCount = 0;
      this.hardRecoveryInProgress = false;
      this.hardRecoveryToken = null;
      this.hardRecoveryViewState = null;
    }
    this.resizeRecoveryArmed = !isSafeFlowDiagramSize(container.clientWidth, container.clientHeight);
    this.lastRecoverableViewState = null;
    this.lastStableViewState = null;
    this.lastKnownDevicePixelRatio = getSafeDevicePixelRatio();
    this.recoveryFitFallbackUsed = false;
  }

  resetForDispose(): void {
    this.cancelScheduledRecovery();
    this.resizeRecoveryArmed = false;
    this.lastRecoverableViewState = null;
    this.lastStableViewState = null;
    this.lastKnownDevicePixelRatio = 1;
    this.hardRecoveryAttemptCount = 0;
    this.hardRecoveryInProgress = false;
    this.hardRecoveryToken = null;
    this.hardRecoveryViewState = null;
    this.recoveryFitFallbackUsed = false;
  }

  cancelScheduledRecovery(): void {
    if (this.resizeRecoveryRafId !== null) {
      cancelAnimationFrame(this.resizeRecoveryRafId);
      this.resizeRecoveryRafId = null;
    }
  }

  syncViewportMetrics(forceRecovery = false): void {
    const diagram = this.runtime.getDiagram();
    const diagramDiv = this.runtime.getDiagramDiv();
    if (!diagram || !diagramDiv || this.runtime.isDestroyed() || this.hardRecoveryInProgress) {
      return;
    }

    const pixelRatioChanged = this.updateDevicePixelRatio();
    this.handleContainerResize(
      diagramDiv.clientWidth,
      diagramDiv.clientHeight,
      forceRecovery || pixelRatioChanged,
    );
    this.runtime.attemptPendingOverviewRestore();
  }

  handleContainerResize(width: number, height: number, forceRecovery = false): void {
    const diagram = this.runtime.getDiagram();
    if (!diagram || !this.runtime.getDiagramDiv() || this.runtime.isDestroyed()) {
      return;
    }

    if (forceRecovery || width <= 0 || height <= 0 || !isSafeFlowDiagramSize(width, height)) {
      this.armResizeRecovery();
      if (width > 0 && height > 0 && isSafeFlowDiagramSize(width, height)) {
        this.scheduleResizeRecovery();
      }
      return;
    }

    diagram.requestUpdate();

    if (this.resizeRecoveryArmed) {
      this.scheduleResizeRecovery();
      return;
    }

    this.captureStableViewState();
  }

  captureStableViewState(): void {
    const diagram = this.runtime.getDiagram();
    if (!diagram || !this.canPersistViewState()) {
      return;
    }

    const viewState: ViewState = {
      scale: diagram.scale,
      positionX: diagram.position.x,
      positionY: diagram.position.y,
    };

    this.lastRecoverableViewState = viewState;

    if (hasVisibleFlowDiagramContent(diagram)) {
      this.lastStableViewState = viewState;
    }
  }

  restoreBestKnownViewState(): boolean {
    const viewState = selectBestFlowViewState({
      stableViewState: this.lastStableViewState,
      recoverableViewState: this.lastRecoverableViewState,
      persistedViewState: this.runtime.getPersistedViewState(),
    });

    if (!viewState) return false;

    applyFlowViewState(this.runtime.getDiagram(), viewState);
    return true;
  }

  canPersistViewState(): boolean {
    return canPersistFlowViewState(
      this.runtime.getDiagram(),
      this.runtime.getDiagramDiv(),
      this.resizeRecoveryArmed || this.hardRecoveryInProgress,
    );
  }

  recoverAfterUnsafeResize(): void {
    const diagram = this.runtime.getDiagram();
    const diagramDiv = this.runtime.getDiagramDiv();
    if (!diagram || !diagramDiv || this.runtime.isDestroyed()) {
      return;
    }

    if (!isSafeFlowDiagramSize(diagramDiv.clientWidth, diagramDiv.clientHeight)) {
      return;
    }

    diagram.updateAllTargetBindings();
    diagram.requestUpdate();

    if (!this.restoreBestKnownViewState()) {
      this.runtime.requestFitToContents();
    }

    diagram.requestUpdate();
    this.scheduleRecoveryVerification(true);
  }

  completeRecoveryVerification(
    allowHardRecovery: boolean,
    expectedToken: FlowDiagramHardRecoveryToken | null = this.hardRecoveryToken,
  ): void {
    if (expectedToken && (expectedToken !== this.hardRecoveryToken
      || !this.runtime.isHardRecoveryCurrent(expectedToken))) {
      if (expectedToken === this.hardRecoveryToken) {
        this.hardRecoveryInProgress = false;
        this.hardRecoveryToken = null;
      }
      return;
    }
    const diagram = this.runtime.getDiagram();
    const diagramDiv = this.runtime.getDiagramDiv();
    if (!diagram || !diagramDiv || this.runtime.isDestroyed()) {
      return;
    }

    const action = resolveFlowDiagramRecoveryVerificationAction({
      allowHardRecovery,
      containerIsSafe: isSafeFlowDiagramSize(diagramDiv.clientWidth, diagramDiv.clientHeight),
      contentIsVisible: hasVisibleFlowDiagramContent(diagram),
      recoveryFitFallbackUsed: this.recoveryFitFallbackUsed,
    });

    switch (action) {
      case 'wait-for-safe-size':
        this.hardRecoveryInProgress = false;
        return;
      case 'finish':
        this.finishResizeRecovery(expectedToken);
        return;
      case 'hard-recovery':
        if (this.tryHardDiagramRecovery()) return;
        break;
      case 'fit-fallback':
        this.recoveryFitFallbackUsed = true;
        this.runtime.requestFitToContents();
        this.runtime.getDiagram()?.requestUpdate();
        this.scheduleRecoveryVerification(false, expectedToken);
        return;
      case 'keep-armed':
        break;
    }

    this.resizeRecoveryArmed = true;
    this.hardRecoveryInProgress = false;
    this.recoveryFitFallbackUsed = false;
    this.runtime.warn('流程图在容器恢复后仍不可见，等待下一次恢复机会');
  }

  armResizeRecovery(): void {
    this.resizeRecoveryArmed = true;
    this.recoveryFitFallbackUsed = false;
    this.runtime.requestCancelPendingViewStateSave();
  }

  private scheduleResizeRecovery(): void {
    if (!this.runtime.getDiagram() || !this.runtime.getDiagramDiv() || this.runtime.isDestroyed()) {
      return;
    }

    this.cancelScheduledRecovery();

    this.zone.runOutsideAngular(() => {
      this.resizeRecoveryRafId = requestAnimationFrame(() => {
        this.resizeRecoveryRafId = requestAnimationFrame(() => {
          this.resizeRecoveryRafId = null;
          this.recoverAfterUnsafeResize();
        });
      });
    });
  }

  private tryHardDiagramRecovery(): boolean {
    if (!this.canStartHardDiagramRecovery()) {
      return false;
    }

    const recoveryToken = this.runtime.beginHardRecovery();
    if (!recoveryToken) return false;
    this.hardRecoveryAttemptCount += 1;
    this.hardRecoveryInProgress = true;
    this.hardRecoveryToken = recoveryToken;

    const container = this.runtime.getDiagramDiv();
    const selectionKeys = this.runtime.getSelectedNodeKeys();
    const recoveryViewState = this.getPreferredRecoveryViewState();
    const shouldRestoreOverview = this.runtime.getShouldRestoreOverview();
    const overviewContainer = shouldRestoreOverview ? this.runtime.getOverviewContainer() : null;
    if (!container) {
      this.runtime.cleanupFailedHardRecovery();
      this.runtime.abortHardRecovery(recoveryToken);
      this.hardRecoveryInProgress = false;
      return false;
    }

    try {
      this.runtime.warn('普通恢复失败，开始原地重建 GoJS Diagram', {
        attempt: this.hardRecoveryAttemptCount,
      });

      this.runtime.teardownDiagramForRecovery();

      const initialized = this.runtime.initializeOutsideZone(container, recoveryToken);
      if (!initialized || !this.runtime.getDiagram()) {
        this.runtime.cleanupFailedHardRecovery();
        this.runtime.abortHardRecovery(recoveryToken);
        this.hardRecoveryInProgress = false;
        return false;
      }
      if (!this.runtime.isHardRecoveryCurrent(recoveryToken)) {
        this.hardRecoveryInProgress = false;
        this.hardRecoveryToken = null;
        return false;
      }

      return this.restoreHardRecoveredDiagram(
        selectionKeys, recoveryViewState, shouldRestoreOverview, overviewContainer, recoveryToken,
      );
    } catch (error) {
      this.runtime.abortHardRecovery(recoveryToken);
      this.hardRecoveryInProgress = false;
      this.runtime.error('流程图原地重建失败', error);
      this.runtime.captureException(error, { tags: { operation: 'hardResizeRecovery' } });
      return false;
    }
  }

  private canStartHardDiagramRecovery(): boolean {
    const diagram = this.runtime.getDiagram();
    const result = resolveFlowDiagramHardRecoveryStart({
      attemptCount: this.hardRecoveryAttemptCount,
      canClearDiagram: typeof (diagram as go.Diagram & { clear?: unknown } | null)?.clear === 'function',
      hasDiagram: diagram !== null,
      hasDiagramDiv: this.runtime.getDiagramDiv() !== null,
      hardRecoveryInProgress: this.hardRecoveryInProgress,
      isDestroyed: this.runtime.isDestroyed(),
      maxAttempts: this.maxHardRecoveryAttempts,
    });

    if (result.status === 'limit-reached') {
      this.runtime.warn('流程图原地重建次数已达上限，停止继续重试');
    }

    return result.status === 'start';
  }

  private restoreHardRecoveredDiagram(
    selectionKeys: string[],
    recoveryViewState: ViewState | null,
    shouldRestoreOverview: boolean,
    overviewContainer: HTMLDivElement | null,
    recoveryToken: FlowDiagramHardRecoveryToken,
  ): boolean {
    this.resizeRecoveryArmed = true;
    if (!this.runtime.updateDiagram(true) || !this.runtime.isHardRecoveryCurrent(recoveryToken)) {
      this.runtime.abortHardRecovery(recoveryToken);
      this.hardRecoveryInProgress = false;
      return false;
    }
    this.hardRecoveryViewState = recoveryViewState;
    this.runtime.getDiagram()?.requestUpdate();

    if (selectionKeys.length > 0) {
      this.runtime.selectMultiple(selectionKeys);
    }

    this.runtime.restoreDropHandler();

    if (shouldRestoreOverview && overviewContainer) {
      this.runtime.restoreOverviewAfterRecovery(overviewContainer);
    }

    this.scheduleRecoveryVerification(false, recoveryToken);
    return true;
  }

  private scheduleRecoveryVerification(
    allowHardRecovery: boolean,
    expectedToken: FlowDiagramHardRecoveryToken | null = this.hardRecoveryToken,
  ): void {
    if (!this.runtime.getDiagram() || !this.runtime.getDiagramDiv() || this.runtime.isDestroyed()) {
      return;
    }

    this.cancelScheduledRecovery();

    this.zone.runOutsideAngular(() => {
      this.resizeRecoveryRafId = requestAnimationFrame(() => {
        this.resizeRecoveryRafId = null;
        this.completeRecoveryVerification(allowHardRecovery, expectedToken);
      });
    });
  }

  private getPreferredRecoveryViewState(): ViewState | null {
    return selectBestFlowViewState({
      stableViewState: this.lastStableViewState,
      recoverableViewState: this.lastRecoverableViewState,
      currentViewState: getCurrentFlowViewStateSnapshot(this.runtime.getDiagram()),
      persistedViewState: this.runtime.getPersistedViewState(),
    });
  }

  private finishResizeRecovery(expectedToken: FlowDiagramHardRecoveryToken | null): void {
    if (!this.runtime.getDiagram() || this.runtime.isDestroyed()) {
      return;
    }
    if (!expectedToken) {
      this.completeResizeRecovery();
      return;
    }
    const scheduled = this.runtime.applyHardRecoveryViewport(this.hardRecoveryViewState, proof => {
      if (!proof || !this.runtime.completeHardRecovery(proof)
        || !this.runtime.releaseHardRecovery(expectedToken)) {
        this.failHardRecovery(expectedToken);
        return;
      }
      this.completeResizeRecovery();
    });
    if (!scheduled) this.failHardRecovery(expectedToken);
  }

  private failHardRecovery(expectedToken: FlowDiagramHardRecoveryToken): void {
    this.runtime.abortHardRecovery(expectedToken);
    this.hardRecoveryInProgress = false;
    if (expectedToken === this.hardRecoveryToken) this.hardRecoveryToken = null;
    this.hardRecoveryViewState = null;
  }

  private completeResizeRecovery(): void {
    if (!this.runtime.getDiagram() || this.runtime.isDestroyed()) {
      return;
    }
    this.runtime.attemptPendingOverviewRestore();
    this.runtime.refreshOverview();
    this.resizeRecoveryArmed = false;
    this.hardRecoveryInProgress = false;
    this.hardRecoveryToken = null;
    this.hardRecoveryViewState = null;
    this.hardRecoveryAttemptCount = 0;
    this.recoveryFitFallbackUsed = false;
    this.captureStableViewState();

    if (this.canPersistViewState()) {
      this.runtime.saveViewState();
    }
  }

  private updateDevicePixelRatio(): boolean {
    const ratioChange = detectFlowDevicePixelRatioChange(this.lastKnownDevicePixelRatio);
    if (!ratioChange.changed) {
      return false;
    }

    this.lastKnownDevicePixelRatio = ratioChange.nextRatio;
    this.runtime.info('检测到设备像素比变化，触发流程图恢复', {
      previousRatio: ratioChange.previousRatio,
      nextRatio: ratioChange.nextRatio,
    });
    return true;
  }
}
