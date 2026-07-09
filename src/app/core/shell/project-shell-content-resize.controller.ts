import { signal } from '@angular/core';
import { UiStateService } from '../../../services/ui-state.service';

/** Manages desktop text-column resize state for ProjectShellComponent. */
export class ProjectShellContentResizeController {
  private static readonly COLLAPSE_THRESHOLD = 15;

  private isResizingContent = false;
  private startX = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  private resizeRafId: number | null = null;
  private resizeFrameGeneration = 0;
  private isDragCollapsed = false;
  private collapseAnimTimer: ReturnType<typeof setTimeout> | null = null;
  private collapseAnimationGeneration = 0;

  readonly collapseAnimating = signal(false);

  constructor(private readonly uiState: UiStateService) {}

  start(e: MouseEvent): void {
    e.preventDefault();
    this.clearPendingMoveFrame();
    const doc = this.getDocument();
    if (!doc) {
      return;
    }

    this.isResizingContent = true;
    this.uiState.isResizing.set(true);
    this.startX = e.clientX;
    this.startRatio = this.uiState.textColumnRatio();

    const mainEl = doc.querySelector('main');
    this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;

    doc.body.style.cursor = 'col-resize';
    doc.body.style.userSelect = 'none';
  }

  move(e: MouseEvent): void {
    if (!this.isResizingContent) return;
    e.preventDefault();
    if (this.resizeRafId !== null) return;

    const clientX = e.clientX;
    const resizeFrameGeneration = this.resizeFrameGeneration + 1;
    this.resizeFrameGeneration = resizeFrameGeneration;
    let resizeRafId: number | null = null;
    try {
      resizeRafId = this.requestFrame(() =>
        this.applyScheduledMoveFrame(clientX, resizeRafId, resizeFrameGeneration));
    } catch {
      this.resizeRafId = null;
      this.applyMoveFrame(clientX);
      return;
    }
    this.resizeRafId = resizeRafId;
  }

  end(): void {
    if (!this.isResizingContent) return;

    const shouldAnimateCollapsed = this.isDragCollapsed;
    this.cleanup();
    if (shouldAnimateCollapsed) {
      this.enableCollapseAnimation();
    }
  }

  cleanup(): void {
    this.clearPendingMoveFrame();
    this.clearCollapseAnimationTimer();
    this.collapseAnimating.set(false);
    this.isDragCollapsed = false;
    this.isResizingContent = false;
    this.uiState.isResizing.set(false);
    const doc = this.getDocument();
    if (doc) {
      doc.body.style.cursor = '';
      doc.body.style.userSelect = '';
    }
  }

  private getDocument(): Document | null {
    return typeof document === 'undefined' ? null : document;
  }

  private requestFrame(callback: FrameRequestCallback): number {
    return typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : setTimeout(() => callback(Date.now()), 16) as unknown as number;
  }

  private cancelFrame(id: number): void {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id);
      return;
    }

    clearTimeout(id);
  }

  private clearPendingMoveFrame(): void {
    if (this.resizeRafId === null) return;

    const resizeRafId = this.resizeRafId;
    this.resizeFrameGeneration += 1;
    this.resizeRafId = null;
    try {
      this.cancelFrame(resizeRafId);
    } catch {
      // Cancel failures are best-effort; generation invalidation prevents the
      // stale frame from mutating drag state if the browser still runs it.
    }
  }

  private applyScheduledMoveFrame(
    clientX: number,
    resizeRafId: number | null,
    resizeFrameGeneration: number,
  ): void {
    if (
      this.resizeFrameGeneration !== resizeFrameGeneration ||
      this.resizeRafId !== resizeRafId
    ) {
      return;
    }

    this.applyMoveFrame(clientX);
  }

  private applyMoveFrame(clientX: number): void {
    this.resizeRafId = null;
    const delta = clientX - this.startX;
    const deltaPercent = (delta / this.mainContentWidth) * 100;
    const rawRatio = this.startRatio + deltaPercent;

    if (rawRatio < ProjectShellContentResizeController.COLLAPSE_THRESHOLD) {
      this.applyCollapsedDragState();
      return;
    }

    if (this.isDragCollapsed) {
      this.applyExpandedDragState(rawRatio);
      return;
    }

    this.uiState.textColumnRatio.set(this.clampTextColumnRatio(rawRatio));
  }

  private applyCollapsedDragState(): void {
    if (this.isDragCollapsed) return;

    this.isDragCollapsed = true;
    this.enableCollapseAnimation();
    this.uiState.textColumnRatio.set(0);
    this.uiState.isTextColumnCollapsed.set(true);
  }

  private applyExpandedDragState(rawRatio: number): void {
    this.isDragCollapsed = false;
    this.enableCollapseAnimation();
    this.uiState.isTextColumnCollapsed.set(false);
    this.uiState.textColumnRatio.set(this.clampTextColumnRatio(rawRatio));
  }

  private clampTextColumnRatio(rawRatio: number): number {
    return Math.max(25, Math.min(75, rawRatio));
  }

  private enableCollapseAnimation(): void {
    this.clearCollapseAnimationTimer();
    const collapseAnimationGeneration = this.collapseAnimationGeneration + 1;
    this.collapseAnimationGeneration = collapseAnimationGeneration;
    this.collapseAnimating.set(true);
    let collapseAnimTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      collapseAnimTimer = setTimeout(() => {
        if (
          this.collapseAnimationGeneration !== collapseAnimationGeneration ||
          this.collapseAnimTimer !== collapseAnimTimer
        ) {
          return;
        }

        this.collapseAnimating.set(false);
        this.collapseAnimTimer = null;
      }, 320);
    } catch {
      if (this.collapseAnimationGeneration === collapseAnimationGeneration) {
        this.collapseAnimating.set(false);
        this.collapseAnimTimer = null;
      }
      return;
    }
    this.collapseAnimTimer = collapseAnimTimer;
  }

  private clearCollapseAnimationTimer(): void {
    if (!this.collapseAnimTimer) return;

    const collapseAnimTimer = this.collapseAnimTimer;
    this.collapseAnimTimer = null;
    this.collapseAnimationGeneration += 1;
    try {
      clearTimeout(collapseAnimTimer);
    } catch {
      // Stale collapse timers are invalidated before best-effort cleanup so
      // delayed callbacks cannot clear a newer animation state.
    }
  }
}
