import { UiStateService } from '../../../services/ui-state.service';
import {
  ProjectShellContentResizeAnimationController,
} from './project-shell-content-resize-animation.controller';
import {
  ProjectShellContentResizeFrameController,
} from './project-shell-content-resize-frame.controller';

type ContentResizeAnimationController = Pick<
  ProjectShellContentResizeAnimationController,
  'animating' | 'clear' | 'enable'
>;

type ContentResizeFrameController = Pick<
  ProjectShellContentResizeFrameController,
  'clear' | 'schedule'
>;

/** Manages desktop text-column resize state for ProjectShellComponent. */
export class ProjectShellContentResizeController {
  private static readonly COLLAPSE_THRESHOLD = 15;

  private isResizingContent = false;
  private startX = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  private isDragCollapsed = false;
  private readonly collapseAnimation: ContentResizeAnimationController;
  private readonly resizeFrame: ContentResizeFrameController;

  readonly collapseAnimating: ContentResizeAnimationController['animating'];

  constructor(
    private readonly uiState: UiStateService,
    collapseAnimation?: ContentResizeAnimationController,
    resizeFrame?: ContentResizeFrameController,
  ) {
    this.collapseAnimation = collapseAnimation
      ?? new ProjectShellContentResizeAnimationController();
    this.collapseAnimating = this.collapseAnimation.animating;
    this.resizeFrame = resizeFrame
      ?? new ProjectShellContentResizeFrameController({
        applyMove: clientX => this.applyMoveFrame(clientX),
      });
  }

  start(e: MouseEvent): void {
    e.preventDefault();
    this.resizeFrame.clear();
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
    this.resizeFrame.schedule(e.clientX);
  }

  end(): void {
    if (!this.isResizingContent) return;

    const shouldAnimateCollapsed = this.isDragCollapsed;
    this.cleanup();
    if (shouldAnimateCollapsed) {
      this.collapseAnimation.enable();
    }
  }

  cleanup(): void {
    this.resizeFrame.clear();
    this.collapseAnimation.clear();
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

  private applyMoveFrame(clientX: number): void {
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
    this.collapseAnimation.enable();
    this.uiState.textColumnRatio.set(0);
    this.uiState.isTextColumnCollapsed.set(true);
  }

  private applyExpandedDragState(rawRatio: number): void {
    this.isDragCollapsed = false;
    this.collapseAnimation.enable();
    this.uiState.isTextColumnCollapsed.set(false);
    this.uiState.textColumnRatio.set(this.clampTextColumnRatio(rawRatio));
  }

  private clampTextColumnRatio(rawRatio: number): number {
    return Math.max(25, Math.min(75, rawRatio));
  }
}
