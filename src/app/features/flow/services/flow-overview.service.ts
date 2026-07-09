import { Injectable, inject, NgZone } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import {
  buildOverviewCandidateWorldBounds,
  calculateOverviewBaseScaleForBounds,
  calculateOverviewTotalBounds,
  clampOverviewScale,
  getOverviewBoundsCacheKey,
  isOverviewViewportOutsideNodeBounds,
  overviewViewportContainsNodeCenter,
  overviewViewportIsInsideBounds,
  overviewViewportPositionAlmostEqual,
  resolveOverviewNodesBounds,
  resolveOverviewRefreshPlan,
  resolveOverviewTargetScale,
  resolveOverviewWorldBoundsForViewport,
  updateOverviewScaleTowardTarget,
  type OverviewScaleUpdateParams,
} from './flow-overview-bounds.helpers';
import { syncOverviewBoxToViewport as syncOverviewBoxToViewportHelper } from './flow-overview-box.helpers';
import {
  bindOverviewObservedWhenReady,
  configureOverviewContainerRendering,
  createOverviewInstance,
  installOverviewHealHook,
  removeOverviewHealHook,
} from './flow-overview-lifecycle.helpers';
import {
  cleanupFlowOverview,
  createFlowOverviewResizeObserver,
  createFlowOverviewPointerController,
  requestFlowOverviewInteractionRefresh,
  resetFlowOverviewCleanupState,
  scheduleFlowOverviewIdleUpdateDelayRestore,
  setupFlowOverviewAutoScale,
} from './flow-overview-runtime.helpers';
import {
  OverviewBindingsScheduler,
  OverviewViewportUpdateScheduler,
  type OverviewBindingsUpdateMode,
} from './flow-overview-scheduler.helpers';
import { resolveOverviewBackgroundColor } from './flow-overview-theme.helpers';
import {
  decideOverviewStableBoundsReuse,
  decideOverviewViewportAnchorSuppression,
  isManualOverviewMovementViewport,
  resolveOverviewReleaseViewportCatchUp,
  resolveOverviewBoundsViewport,
  resolveOverviewViewportBoundsForSource,
  shouldAnchorOverviewOnViewport,
  shouldSuppressSettledPostDragAnchor,
  type OverviewUpdateSource,
  type OverviewViewportContext,
  type OverviewWorldBoundsPlan,
} from './flow-overview-viewport.helpers';
import { FlowOverviewUpdateController } from './flow-overview-update.controller';
import { FLOW_OVERVIEW_TIMING } from './flow-overview-timing.constants';
import * as go from 'gojs';

@Injectable({ providedIn: 'root' })
export class FlowOverviewService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowOverview');
  private readonly zone = inject(NgZone);
  private readonly themeService = inject(ThemeService);
  private readonly templateService = inject(FlowTemplateService);
  private readonly linkTemplateService = inject(FlowLinkTemplateService);
  private readonly configService = inject(FlowDiagramConfigService);

  private diagram: go.Diagram | null = null;
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  private lastOverviewScale: number = 0.1;
  private isDestroyed = false;
  private isNodeDragging: boolean = false;
  private isOverviewInteracting: boolean = false;
  private isOverviewBoxDragging: boolean = false;
  private hasManualBoxMovement: boolean = false;
  private overviewBoxViewportBounds: go.Rect | null = null;
  private overviewReleaseViewportBounds: go.Rect | null = null;
  private overviewReleaseShouldAnchor = false;
  private overviewPostDragAnchorSuppressionBounds: go.Rect | null = null;
  private overviewSuppressNextViewportAnchor = false;
  private overviewScheduleUpdate: ((source: OverviewUpdateSource) => void) | null = null;
  private overviewApplyUpdateNow: ((source: OverviewUpdateSource) => void) | null = null;
  private overviewBoundsCache: string = '';
  private overviewFixedBounds: go.Rect | null = null;
  private readonly overviewUpdateController = new FlowOverviewUpdateController();
  private readonly overviewBindingsScheduler = new OverviewBindingsScheduler({
    dragThrottleMs: FLOW_OVERVIEW_TIMING.viewportBindingsDragThrottleMs,
    idleThrottleMs: FLOW_OVERVIEW_TIMING.viewportBindingsIdleThrottleMs,
    onUpdateError: error => {
      this.logger.error('overview viewport bindings refresh failed', { error });
    },
  });
  private readonly overviewViewportUpdateScheduler = new OverviewViewportUpdateScheduler({
    throttleMs: FLOW_OVERVIEW_TIMING.viewportNodeDragThrottleMs,
  });
  private readonly pointerController = createFlowOverviewPointerController(this.zone, {
    debug: (message, value) => value === undefined
      ? this.logger.debug(message)
      : this.logger.debug(message, value),
    getDiagram: () => this.diagram, getOverview: () => this.overview, isDestroyed: () => this.isDestroyed,
    getHasManualBoxMovement: () => this.hasManualBoxMovement, getIsOverviewBoxDragging: () => this.isOverviewBoxDragging,
    getIsOverviewInteracting: () => this.isOverviewInteracting, getOverviewBoxViewportBounds: () => this.overviewBoxViewportBounds,
    setHasManualBoxMovement: value => { this.hasManualBoxMovement = value; },
    setIsOverviewBoxDragging: value => { this.isOverviewBoxDragging = value; },
    setIsOverviewInteracting: value => { this.isOverviewInteracting = value; },
    setOverviewBoxViewportBounds: bounds => { this.overviewBoxViewportBounds = bounds; },
    setOverviewReleaseViewportBounds: bounds => { this.overviewReleaseViewportBounds = bounds; },
    setOverviewReleaseShouldAnchor: value => { this.overviewReleaseShouldAnchor = value; },
    setOverviewPostDragAnchorSuppressionBounds: bounds => { this.overviewPostDragAnchorSuppressionBounds = bounds; },
    setOverviewSuppressNextViewportAnchor: value => { this.overviewSuppressNextViewportAnchor = value; },
    clearOverviewBoundsCache: () => { this.overviewBoundsCache = ''; },
    getOverviewInteractionLastApplyAt: () => this.overviewInteractionLastApplyAt, applyOverviewUpdateNow: source => this.applyOverviewUpdateNow(source),
    setOverviewInteractionLastApplyAt: value => { this.overviewInteractionLastApplyAt = value; },
    scheduleOverviewUpdate: source => { this.overviewScheduleUpdate?.(source); },
    cancelScheduledOverviewUpdate: () => this.overviewViewportUpdateScheduler.cancelAll(), clearViewportBindings: () => this.cancelPendingViewportBindingsRefresh(),
    syncOverviewBoxToViewport: viewportBounds => this.syncOverviewBoxToViewport(viewportBounds),
    setOverviewUpdateDelay: delayMs => this.setOverviewUpdateDelay(delayMs),
    getIdleUpdateDelayMs: () => FLOW_OVERVIEW_TIMING.idleUpdateDelayMs, getDragUpdateDelayMs: () => FLOW_OVERVIEW_TIMING.dragUpdateDelayMs,
    requestInteractionRefresh: () => this.requestOverviewInteractionRefresh(),
  });
  private overviewBaseScale = 0.15;
  private overviewLastNodeDataCount = 0;
  private overviewDocumentBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  private overviewViewportBoundsChangedHandler: ((e: go.DiagramEvent) => void) | null = null;
  private overviewViewportPollRafId: number | null = null;
  private overviewViewportPollLastKey: string = '';
  private overviewResizeRefreshRafId: number | null = null;
  private overviewInteractionRefreshRafId: number | null = null;
  private overviewIdleUpdateDelayRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private overviewResizeObserver: ResizeObserver | null = null;
  private overviewPendingInitialLayoutHandler: ((e: go.DiagramEvent) => void) | null = null;
  private overviewHealHookInstalled = false;

  get overviewInstance(): go.Overview | null {
    return this.overview;
  }

  get isOverviewInitialized(): boolean {
    return this.overview !== null && !this.isDestroyed;
  }

  private get overviewInteractionLastApplyAt(): number {
    return this.overviewViewportUpdateScheduler.getInteractionThrottleTimestamp();
  }

  private set overviewInteractionLastApplyAt(value: number) {
    this.overviewViewportUpdateScheduler.setInteractionThrottleTimestamp(value);
  }

  setDiagram(diagram: go.Diagram | null): void {
    this.diagram = diagram;
  }

  setNodeDragging(isDragging: boolean): void {
    this.isNodeDragging = isDragging;
  }

  initializeOverview(container: HTMLDivElement, isMobile: boolean = false): void {
    // 重置销毁标记，允许重新初始化（FlowOverviewService 是全局单例，
    // 移动端切换视图会销毁/重建 FlowViewComponent，需要重置状态）
    this.isDestroyed = false;

    if (!this.diagram) {
      this.logger.warn('无法初始化 Overview：主图未就绪');
      return;
    }

    this.zone.runOutsideAngular(() => {
      try {
        this.cleanupOverview();

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        if (containerWidth <= 0 || containerHeight <= 0) {
          this.logger.warn('Overview 容器尺寸无效，延迟初始化');
          return;
        }

        this.overviewContainer = container;

        configureOverviewContainerRendering(container, this.getOverviewBackgroundColor());
        this.overview = createOverviewInstance(container);

        // 设置模板
        this.templateService.setupOverviewNodeTemplate(this.overview);
        this.linkTemplateService.setupOverviewLinkTemplate(this.overview);

        this.bindObservedWhenReady();

        // 设置视口框样式
        this.templateService.setupOverviewBoxStyle(this.overview, isMobile);

        this.overview.scale = 0.15;
        this.lastOverviewScale = 0.15;

        // 绑定指针监听
        this.pointerController.attach(container);

        // 设置自动缩放
        this.setupOverviewAutoScale();

        // 设置 ResizeObserver
        this.setupOverviewResizeObserver(container);

        // 强制刷新
        if (this.diagram) {
          this.diagram.requestUpdate();
        }
        if (this.overview) {
          this.overview.requestUpdate();
        }

        this.installOverviewHealHook();

        this.logger.info(`Overview 初始化成功`);
      } catch (error) {
        this.logger.error('Overview 初始化失败:', error);
      }
    });
  }

  destroyOverview(): void {
    this.cleanupOverview();
    this.diagram = null;
    this.isDestroyed = true;
  }

  refreshOverview(): void {
    if (!this.overview || !this.overviewContainer || this.isDestroyed) return;

    try {
      this.overview.requestUpdate();

      const containerWidth = this.overviewContainer.clientWidth;
      const containerHeight = this.overviewContainer.clientHeight;

      if (!this.diagram) return;

      const refreshPlan = resolveOverviewRefreshPlan({
        containerWidth,
        containerHeight,
        documentBounds: this.diagram.documentBounds,
        viewportBounds: this.diagram.viewportBounds,
      });
      if (!refreshPlan) return;

      this.overview.scale = refreshPlan.scale;
      this.lastOverviewScale = refreshPlan.scale;
      this.overview.centerRect(refreshPlan.anchorBounds);
      this.logger.debug(`Overview 已刷新 - scale: ${refreshPlan.scale}`);
    } catch (error) {
      this.logger.error('刷新 Overview 失败:', error);
    }
  }

  /** 更新主题相关样式 */
  updateTheme(): void {
    if (!this.overview || !this.overviewContainer) return;

    this.overview.updateAllTargetBindings();
    this.overviewContainer.style.backgroundColor = this.getOverviewBackgroundColor();
  }

  private cleanupOverview(): void {
    cleanupFlowOverview({
      getOverview: () => this.overview, getDiagram: () => this.diagram,
      setOverview: overview => { this.overview = overview; },
      setOverviewContainer: container => { this.overviewContainer = container; },
      removePendingInitialLayoutHandler: () => this.removePendingInitialLayoutHandler(),
      pointerController: this.pointerController,
      getOverviewResizeObserver: () => this.overviewResizeObserver, getOverviewDocumentBoundsChangedHandler: () => this.overviewDocumentBoundsChangedHandler,
      getOverviewViewportBoundsChangedHandler: () => this.overviewViewportBoundsChangedHandler,
      setOverviewResizeObserver: observer => { this.overviewResizeObserver = observer; },
      setOverviewDocumentBoundsChangedHandler: handler => { this.overviewDocumentBoundsChangedHandler = handler; },
      setOverviewViewportBoundsChangedHandler: handler => { this.overviewViewportBoundsChangedHandler = handler; },
      frameCallbacks: {
        viewportPollRafId: this.overviewViewportPollRafId, resizeRefreshRafId: this.overviewResizeRefreshRafId,
        interactionRefreshRafId: this.overviewInteractionRefreshRafId, setViewportPollRafId: value => { this.overviewViewportPollRafId = value; },
        setResizeRefreshRafId: value => { this.overviewResizeRefreshRafId = value; }, setInteractionRefreshRafId: value => { this.overviewInteractionRefreshRafId = value; },
      },
      overviewViewportUpdateScheduler: this.overviewViewportUpdateScheduler, overviewBindingsScheduler: this.overviewBindingsScheduler,
      getOverviewIdleUpdateDelayRestoreTimer: () => this.overviewIdleUpdateDelayRestoreTimer,
      setOverviewIdleUpdateDelayRestoreTimer: timer => { this.overviewIdleUpdateDelayRestoreTimer = timer; },
      resetInteractionState: () => this.resetOverviewCleanupState(), removeOverviewHealHook: () => this.removeOverviewHealHook(),
      clearOverviewBoundsCache: () => { this.overviewBoundsCache = ''; }, clearOverviewFixedBounds: () => { this.overviewFixedBounds = null; },
      clearOverviewUpdateCallbacks: () => {
        this.overviewScheduleUpdate = null;
        this.overviewApplyUpdateNow = null;
      },
    });
  }

  private resetOverviewCleanupState(): void {
    resetFlowOverviewCleanupState({
      setNodeDragging: value => { this.isNodeDragging = value; }, setOverviewInteracting: value => { this.isOverviewInteracting = value; },
      setOverviewBoxDragging: value => { this.isOverviewBoxDragging = value; }, setHasManualBoxMovement: value => { this.hasManualBoxMovement = value; },
      setOverviewBoxViewportBounds: bounds => { this.overviewBoxViewportBounds = bounds; },
      setOverviewReleaseViewportBounds: bounds => { this.overviewReleaseViewportBounds = bounds; },
      setOverviewReleaseShouldAnchor: value => { this.overviewReleaseShouldAnchor = value; }, setOverviewSuppressNextViewportAnchor: value => { this.overviewSuppressNextViewportAnchor = value; },
      setOverviewPostDragAnchorSuppressionBounds: bounds => { this.overviewPostDragAnchorSuppressionBounds = bounds; },
      setApplyingOverviewViewportUpdate: value => { if (!value) this.overviewUpdateController.reset(); },
      setOverviewUpdateQueuedWhileApplying: value => { if (!value) this.overviewUpdateController.reset(); },
      overviewViewportUpdateScheduler: this.overviewViewportUpdateScheduler,
    });
  }

  private getOverviewBackgroundColor(): string {
    return resolveOverviewBackgroundColor(this.themeService.isDark(), this.configService.currentStyles().text.titleColor);
  }

  private setOverviewUpdateDelay(delayMs: number): void {
    if (!this.overview) return;
    this.overview.updateDelay = delayMs;
  }

  private scheduleOverviewIdleUpdateDelayRestore(): void {
    scheduleFlowOverviewIdleUpdateDelayRestore(FLOW_OVERVIEW_TIMING.idleUpdateDelayMs, {
      getTimer: () => this.overviewIdleUpdateDelayRestoreTimer, isDestroyed: () => this.isDestroyed,
      getOverview: () => this.overview, isOverviewBoxDragging: () => this.isOverviewBoxDragging,
      isOverviewInteracting: () => this.isOverviewInteracting,
      setTimer: timer => { this.overviewIdleUpdateDelayRestoreTimer = timer; },
      setOverviewUpdateDelay: delayMs => this.setOverviewUpdateDelay(delayMs),
    });
  }

  private updateOverviewScaleForViewport(params: OverviewScaleUpdateParams): void {
    if (!this.overview || params.freezeScaleForStableManualBounds) {
      return;
    }

    const currentScale = this.overview.scale;
    const targetScale = resolveOverviewTargetScale(params, currentScale);
    if (Math.abs(targetScale - currentScale) <= 0.002) {
      return;
    }

    const nextScale = updateOverviewScaleTowardTarget(
      currentScale,
      targetScale,
      params.smoothManualScale,
    );
    this.overview.scale = clampOverviewScale(nextScale);
    this.lastOverviewScale = this.overview.scale;
  }

  private getOverviewNodesBounds(): go.Rect {
    return resolveOverviewNodesBounds(this.diagram?.documentBounds);
  }

  private calculateOverviewBaseScale(): number {
    if (!this.overviewContainer || !this.diagram) return 0.15;

    return calculateOverviewBaseScaleForBounds(
      this.overviewContainer.clientWidth,
      this.overviewContainer.clientHeight,
      this.getOverviewNodesBounds(),
    );
  }

  private getOverviewNodeDataCount(): number {
    return ((this.diagram?.model as go.Model & { nodeDataArray?: go.ObjectData[] })?.nodeDataArray?.length ?? 0);
  }

  private cancelPendingViewportBindingsRefresh(): void {
    this.overviewBindingsScheduler.cancelPendingRefresh();
  }

  private cancelPendingOverviewInteractionRefresh(): void {
    if (this.overviewInteractionRefreshRafId !== null) {
      cancelAnimationFrame(this.overviewInteractionRefreshRafId);
      this.overviewInteractionRefreshRafId = null;
    }
  }

  private cancelPendingViewportOverviewUpdate(): void {
    this.overviewViewportUpdateScheduler.cancelPendingNonDocument();
  }

  private scheduleViewportBindingsUpdate(mode: OverviewBindingsUpdateMode): void {
    this.overviewBindingsScheduler.schedule(mode, () => this.overview);
  }

  private syncOverviewBoxToViewport(viewportBounds: go.Rect): void {
    syncOverviewBoxToViewportHelper(this.overview, viewportBounds);
  }

  private applyOverviewUpdateNow(source: OverviewUpdateSource): void {
    if (this.overviewApplyUpdateNow) {
      this.overviewApplyUpdateNow(source);
      return;
    }
    this.overviewScheduleUpdate?.(source);
  }

  private clearStaleReleaseViewportForObservedPan(): void {
    if (this.isOverviewBoxDragging || this.isOverviewInteracting || !this.overviewReleaseViewportBounds || !this.diagram) {
      return;
    }

    const currentPosition = this.diagram.position;
    const hasCurrentPosition = !!currentPosition
      && Number.isFinite(currentPosition.x)
      && Number.isFinite(currentPosition.y);
    const diagramHasMovedAway = !hasCurrentPosition
      || Math.abs(currentPosition.x - this.overviewReleaseViewportBounds.x) > 1
      || Math.abs(currentPosition.y - this.overviewReleaseViewportBounds.y) > 1;

    const observedViewportBounds = this.diagram.viewportBounds;
    const observedMatchesRelease = observedViewportBounds.isReal()
      && overviewViewportPositionAlmostEqual(observedViewportBounds, this.overviewReleaseViewportBounds);
    if ((!observedViewportBounds.isReal() || observedMatchesRelease) && !diagramHasMovedAway) {
      return;
    }

    const observedHasCaughtUpToDiagramPosition = hasCurrentPosition
      && observedViewportBounds.isReal()
      && Math.abs(observedViewportBounds.x - currentPosition.x) < 1
      && Math.abs(observedViewportBounds.y - currentPosition.y) < 1;

    if (!diagramHasMovedAway && !observedHasCaughtUpToDiagramPosition) {
      return;
    }

    this.overviewReleaseViewportBounds = null;
    this.overviewReleaseShouldAnchor = false;
    this.overviewPostDragAnchorSuppressionBounds = null;
    this.overviewSuppressNextViewportAnchor = false;
    this.cancelPendingOverviewInteractionRefresh();
    this.cancelPendingViewportOverviewUpdate();
    this.cancelPendingViewportBindingsRefresh();
  }

  private applyOverviewUpdate(source: OverviewUpdateSource): void {
    this.overviewUpdateController.apply(source, {
      createContext: nextSource => this.createOverviewViewportContext(nextSource),
      handlePassiveUpdate: context => this.handlePassiveOverviewViewportUpdate(context),
      buildWorldBoundsPlan: context => this.buildOverviewWorldBoundsPlan(context),
      applyWorldBoundsPlan: plan => this.applyOverviewWorldBoundsPlan(plan),
      finalizeUpdate: context => this.finalizeOverviewUpdateForContext(context),
      clearReleaseViewportIfCaughtUp: context => this.clearReleaseViewportBoundsIfCaughtUp(context),
      scheduleUpdate: nextSource => { this.overviewScheduleUpdate?.(nextSource); },
    });
  }

  private createOverviewViewportContext(source: OverviewUpdateSource): OverviewViewportContext | null {
    if (!this.diagram || !this.overview) return null;

    const fakeViewportBounds = this.overviewBoxViewportBounds;
    const releaseViewportBounds = this.overviewReleaseViewportBounds;
    const usingFakeViewportBounds = !!(this.isOverviewBoxDragging && fakeViewportBounds && fakeViewportBounds.isReal());
    const usingReleaseViewportBounds = !!(!this.isOverviewBoxDragging && releaseViewportBounds && releaseViewportBounds.isReal());
    const usingManualViewportBounds = usingFakeViewportBounds || usingReleaseViewportBounds;
    const viewportBounds = resolveOverviewViewportBoundsForSource({
      source,
      usingManualViewportBounds,
      fakeViewportBounds: usingFakeViewportBounds ? fakeViewportBounds : null,
      releaseViewportBounds: usingReleaseViewportBounds ? releaseViewportBounds : null,
      observedViewportBounds: this.diagram.viewportBounds,
      currentDiagramPosition: this.diagram.position,
    });

    if (!viewportBounds.isReal()) {
      if (usingReleaseViewportBounds) {
        this.overviewReleaseViewportBounds = null;
      }
      return null;
    }

    const anchorSuppressionDecision = decideOverviewViewportAnchorSuppression({
      source,
      usingManualViewportBounds,
      viewportBounds,
      suppressNextViewportAnchor: this.overviewSuppressNextViewportAnchor,
      postDragAnchorSuppressionBounds: this.overviewPostDragAnchorSuppressionBounds,
    });
    if (anchorSuppressionDecision.shouldClearSuppressNextViewportAnchor) {
      this.overviewSuppressNextViewportAnchor = false;
      if (anchorSuppressionDecision.shouldClearPostDragAnchorSuppressionBounds) {
        this.overviewPostDragAnchorSuppressionBounds = null;
      }
    }
    const isPassiveObservedViewportUpdate = source === 'viewport' && !usingManualViewportBounds;
    const viewportIsInsideCurrentOverviewBounds = !!this.overviewFixedBounds
      && overviewViewportIsInsideBounds(this.overviewFixedBounds, viewportBounds);

    return {
      source,
      viewportBounds,
      releaseViewportBounds,
      usingFakeViewportBounds,
      usingReleaseViewportBounds,
      usingManualViewportBounds,
      shouldSuppressNextViewportAnchor: anchorSuppressionDecision.shouldSuppressNextViewportAnchor,
      isPassiveObservedViewportUpdate,
      viewportIsInsideCurrentOverviewBounds,
    };
  }

  private handlePassiveOverviewViewportUpdate(context: OverviewViewportContext): boolean {
    if (!context.isPassiveObservedViewportUpdate || !context.viewportIsInsideCurrentOverviewBounds) {
      return false;
    }

    const shouldSuppressSettledPostDragAnchorValue = shouldSuppressSettledPostDragAnchor(
      context,
      this.overviewPostDragAnchorSuppressionBounds,
    );
    const suppressedPostDragBounds = this.overviewPostDragAnchorSuppressionBounds;
    if (suppressedPostDragBounds && !shouldSuppressSettledPostDragAnchorValue) {
      this.overviewPostDragAnchorSuppressionBounds = null;
    }
    this.cancelPendingOverviewInteractionRefresh();
    this.cancelPendingViewportBindingsRefresh();
    this.syncOverviewBoxToViewport(context.viewportBounds);
    return true;
  }

  private buildOverviewWorldBoundsPlan(context: OverviewViewportContext): OverviewWorldBoundsPlan | null {
    if (!this.diagram || !this.overviewContainer) return null;

    const containerWidth = this.overviewContainer.clientWidth;
    const containerHeight = this.overviewContainer.clientHeight;
    const nodeBounds = this.getOverviewNodesBounds();
    const totalBounds = this.calculateOverviewTotalBounds(context.viewportBounds);
    this.refreshOverviewBaseScaleWhenNodeCountChanges();

    if (containerWidth <= 0 || containerHeight <= 0 || totalBounds.width <= 0 || totalBounds.height <= 0) {
      return null;
    }

    const isViewportOutside = isOverviewViewportOutsideNodeBounds(context.viewportBounds, nodeBounds);
    const viewportContainsNodeCenter = overviewViewportContainsNodeCenter(context.viewportBounds, nodeBounds);
    const shouldSuppressSettledPostDragAnchorValue = shouldSuppressSettledPostDragAnchor(
      context,
      this.overviewPostDragAnchorSuppressionBounds,
    );
    if (!context.usingManualViewportBounds && this.overviewPostDragAnchorSuppressionBounds && !shouldSuppressSettledPostDragAnchorValue) {
      this.overviewPostDragAnchorSuppressionBounds = null;
    }

    const { worldBounds, reusedStableBounds } = this.resolveOverviewWorldBounds(context, {
      nodeBounds,
      viewportContainsNodeCenter,
      shouldSuppressSettledPostDragAnchor: shouldSuppressSettledPostDragAnchorValue,
      isViewportOutside,
    });
    const manualMovementViewport = isManualOverviewMovementViewport(
      context,
      this.overviewReleaseShouldAnchor,
      shouldSuppressSettledPostDragAnchorValue,
    );
    const freezeScaleForStableManualBounds = context.isPassiveObservedViewportUpdate
      || (context.usingFakeViewportBounds && !this.hasManualBoxMovement)
      || shouldSuppressSettledPostDragAnchorValue
      || context.usingReleaseViewportBounds
      || (!context.usingFakeViewportBounds && manualMovementViewport && reusedStableBounds);

    return {
      viewportBounds: context.viewportBounds,
      totalBounds,
      worldBounds,
      isViewportOutside,
      freezeScaleForStableManualBounds,
      smoothManualScale: context.usingFakeViewportBounds && this.hasManualBoxMovement,
      shouldAnchorOverviewOnViewport: shouldAnchorOverviewOnViewport(
        context,
        this.overviewReleaseShouldAnchor,
        shouldSuppressSettledPostDragAnchorValue,
      ),
    };
  }

  private calculateOverviewTotalBounds(viewportBounds: go.Rect): go.Rect {
    return calculateOverviewTotalBounds(this.diagram?.documentBounds, viewportBounds);
  }

  private refreshOverviewBaseScaleWhenNodeCountChanges(): void {
    const currentNodeDataCount = this.getOverviewNodeDataCount();
    if (currentNodeDataCount !== this.overviewLastNodeDataCount) {
      this.overviewBaseScale = this.calculateOverviewBaseScale();
      this.overviewLastNodeDataCount = currentNodeDataCount;
    }
  }

  private resolveOverviewWorldBounds(
    context: OverviewViewportContext,
    params: {
      nodeBounds: go.Rect;
      viewportContainsNodeCenter: boolean;
      shouldSuppressSettledPostDragAnchor: boolean;
      isViewportOutside: boolean;
    },
  ): { worldBounds: go.Rect; reusedStableBounds: boolean } {
    const manualMovementViewport = isManualOverviewMovementViewport(context, this.overviewReleaseShouldAnchor, params.shouldSuppressSettledPostDragAnchor);
    const boundsViewport = resolveOverviewBoundsViewport({
      context,
      nodeBounds: params.nodeBounds,
      viewportContainsNodeCenter: params.viewportContainsNodeCenter,
      manualMovementViewport,
    });
    const stableBoundsReuse = decideOverviewStableBoundsReuse({
      context,
      overviewFixedBounds: this.overviewFixedBounds,
      manualMovementViewport,
      isViewportOutside: params.isViewportOutside,
      viewportContainsNodeCenter: params.viewportContainsNodeCenter,
    });
    const candidateWorldBounds = buildOverviewCandidateWorldBounds({
      nodeBounds: params.nodeBounds,
      boundsViewport,
      viewportBounds: context.viewportBounds,
      containerWidth: this.overviewContainer?.clientWidth,
      containerHeight: this.overviewContainer?.clientHeight,
      isPassiveObservedViewportUpdate: context.isPassiveObservedViewportUpdate,
      viewportIsInsideCurrentOverviewBounds: context.viewportIsInsideCurrentOverviewBounds,
    });
    const { bounds, reusedStableBounds } = resolveOverviewWorldBoundsForViewport(
      candidateWorldBounds,
      context.viewportBounds,
      this.overviewFixedBounds,
      stableBoundsReuse.preferStableBounds,
      stableBoundsReuse.reuseWhenInsideBounds,
    );
    return { worldBounds: bounds, reusedStableBounds };
  }

  private applyOverviewWorldBoundsPlan(plan: OverviewWorldBoundsPlan): void {
    if (!this.overviewContainer) return;

    const worldBoundsKey = getOverviewBoundsCacheKey(plan.worldBounds);
    if (worldBoundsKey !== this.overviewBoundsCache) {
      this.setOverviewFixedBounds(plan.worldBounds);
      this.overviewBoundsCache = worldBoundsKey;
    }

    this.updateOverviewScaleForViewport({
      viewportBounds: plan.viewportBounds,
      totalBounds: plan.totalBounds,
      containerWidth: this.overviewContainer.clientWidth,
      containerHeight: this.overviewContainer.clientHeight,
      baseScale: this.overviewBaseScale,
      isViewportOutside: plan.isViewportOutside,
      freezeScaleForStableManualBounds: plan.freezeScaleForStableManualBounds,
      smoothManualScale: plan.smoothManualScale,
    });

    if (plan.shouldAnchorOverviewOnViewport) {
      this.overview?.centerRect(plan.viewportBounds);
    }
  }

  private finalizeOverviewUpdateForContext(context: OverviewViewportContext): void {
    if (!this.overview) return;

    if (context.isPassiveObservedViewportUpdate) {
      this.syncOverviewBoxToViewport(context.viewportBounds);
    }
    this.overview.requestUpdate();
    if (context.usingFakeViewportBounds) {
      this.cancelPendingViewportBindingsRefresh();
      return;
    }

    if (context.usingManualViewportBounds) {
      if (context.usingReleaseViewportBounds && !this.overviewReleaseShouldAnchor) {
        this.cancelPendingViewportBindingsRefresh();
      } else {
        this.scheduleViewportBindingsUpdate('immediate');
      }
    } else if (context.source === 'document') {
      this.scheduleViewportBindingsUpdate('deferred');
    } else {
      this.cancelPendingViewportBindingsRefresh();
    }
  }

  private clearReleaseViewportBoundsIfCaughtUp(context: OverviewViewportContext): void {
    const catchUp = resolveOverviewReleaseViewportCatchUp({
      context,
      observedViewportBounds: this.diagram?.viewportBounds,
      overviewReleaseShouldAnchor: this.overviewReleaseShouldAnchor,
    });
    if (!catchUp) return;

    this.overviewPostDragAnchorSuppressionBounds = catchUp.postDragAnchorSuppressionBounds;
    this.overviewReleaseViewportBounds = null;
    this.overviewReleaseShouldAnchor = false;
  }

  private setupOverviewResizeObserver(container: HTMLDivElement): void {
    this.overviewResizeObserver = createFlowOverviewResizeObserver(container, {
      isDestroyed: () => this.isDestroyed,
      getOverview: () => this.overview,
      refreshOverview: () => this.refreshOverview(),
      getResizeRefreshRafId: () => this.overviewResizeRefreshRafId,
      setResizeRefreshRafId: value => { this.overviewResizeRefreshRafId = value; },
    });
  }

  private setupOverviewAutoScale(): void {
    this.overviewScheduleUpdate = (source: OverviewUpdateSource) => {
      this.overviewViewportUpdateScheduler.schedule(source, {
        applyUpdate: nextSource => this.applyOverviewUpdate(nextSource), hasOverview: () => this.overview !== null,
        isDestroyed: () => this.isDestroyed, isNodeDragging: () => this.isNodeDragging,
      });
    };

    this.overviewApplyUpdateNow = (source: OverviewUpdateSource) => {
      this.overviewViewportUpdateScheduler.applyNow(source, {
        applyUpdate: nextSource => this.applyOverviewUpdate(nextSource), hasOverview: () => this.overview !== null,
        isDestroyed: () => this.isDestroyed, isNodeDragging: () => this.isNodeDragging,
      });
    };

    setupFlowOverviewAutoScale({
      getDiagram: () => this.diagram, getOverview: () => this.overview,
      getOverviewNodeDataCount: () => this.getOverviewNodeDataCount(),
      getOverviewNodesBounds: () => this.getOverviewNodesBounds(),
      calculateOverviewBaseScale: () => this.calculateOverviewBaseScale(),
      setOverviewBaseScale: scale => { this.overviewBaseScale = scale; }, setLastOverviewScale: scale => { this.lastOverviewScale = scale; },
      setOverviewLastNodeDataCount: count => { this.overviewLastNodeDataCount = count; },
      setDocumentBoundsChangedHandler: handler => { this.overviewDocumentBoundsChangedHandler = handler; },
      setViewportBoundsChangedHandler: handler => { this.overviewViewportBoundsChangedHandler = handler; },
      scheduleOverviewUpdate: source => { this.overviewScheduleUpdate?.(source); },
      clearStaleReleaseViewportForObservedPan: () => this.clearStaleReleaseViewportForObservedPan(),
      clampScale: clampOverviewScale,
    });
  }

  private setOverviewFixedBounds(bounds: go.Rect | null): void {
    if (this.isDestroyed || !this.overview) return;
    this.overviewFixedBounds = bounds?.copy() ?? null;
    (this.overview as unknown as { fixedBounds: go.Rect | undefined }).fixedBounds = bounds ?? undefined;
  }

  private bindObservedWhenReady(): void {
    bindOverviewObservedWhenReady({
      debug: message => this.logger.debug(message), getDiagram: () => this.diagram,
      getOverview: () => this.overview, isDestroyed: () => this.isDestroyed,
      removePendingInitialLayoutHandler: () => this.removePendingInitialLayoutHandler(),
      setPendingInitialLayoutHandler: handler => { this.overviewPendingInitialLayoutHandler = handler; },
    });
  }

  private removePendingInitialLayoutHandler(): void {
    if (!this.overviewPendingInitialLayoutHandler) return;
    if (this.diagram) {
      this.diagram.removeDiagramListener('InitialLayoutCompleted', this.overviewPendingInitialLayoutHandler);
      this.diagram.removeDiagramListener('LayoutCompleted', this.overviewPendingInitialLayoutHandler);
    }
    this.overviewPendingInitialLayoutHandler = null;
  }

  private installOverviewHealHook(): void {
    this.overviewHealHookInstalled = installOverviewHealHook(this.overviewHealHookInstalled, {
      getOverview: () => this.overview, isDestroyed: () => this.isDestroyed,
    });
  }

  private removeOverviewHealHook(): void {
    this.overviewHealHookInstalled = removeOverviewHealHook(this.overviewHealHookInstalled);
  }

  private requestOverviewInteractionRefresh(): void {
    requestFlowOverviewInteractionRefresh({
      getInteractionRefreshRafId: () => this.overviewInteractionRefreshRafId,
      setInteractionRefreshRafId: value => { this.overviewInteractionRefreshRafId = value; },
      isDestroyed: () => this.isDestroyed, getDiagram: () => this.diagram, getOverview: () => this.overview,
    });
  }
}
