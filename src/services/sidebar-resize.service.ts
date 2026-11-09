/**
 * SidebarResizeService
 *
 * 从 WorkspaceShellComponent 抽离的分栏拖拽（侧栏宽度 / 内容列比例）状态与计算。
 *
 * 职责单一：
 * - 持有拖拽过程态（起点、起始宽度/比例、rAF 句柄）
 * - 在 mousemove 时按边界 clamp 计算并写回 UiState
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；workspace-shell.component.ts 长期越界
 * - 拖拽是纯 UI 横切逻辑，仅依赖 UiStateService + DOM；组件只保留 @HostListener /
 *   模板绑定的薄 delegate（HostListener 只能挂在组件/指令上）。
 */
import { Injectable, inject } from '@angular/core';
import { UiStateService } from './ui-state.service';

/** 侧栏宽度下限（像素） */
const SIDEBAR_MIN_WIDTH_PX = 200;
/** 侧栏宽度上限（像素） */
const SIDEBAR_MAX_WIDTH_PX = 600;
/** 内容列比例下限（百分比） */
const CONTENT_RATIO_MIN_PCT = 25;
/** 内容列比例上限（百分比） */
const CONTENT_RATIO_MAX_PCT = 75;
/** 主内容区宽度兜底值（像素）—— querySelector('main') 取不到时使用 */
const MAIN_CONTENT_FALLBACK_WIDTH_PX = 1000;

@Injectable({ providedIn: 'root' })
export class SidebarResizeService {
  private readonly uiState = inject(UiStateService);

  isResizingSidebar = false;
  isResizingContent = false;
  private startX = 0;
  private startWidth = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  private resizeRafId: number | null = null;

  /** 是否正在拖拽任一分栏（供模板绑定）。 */
  isResizingAny(): boolean {
    return this.isResizingSidebar || this.isResizingContent;
  }

  startSidebar(e: MouseEvent): void {
    e.preventDefault();
    this.beginResizeGesture('sidebar');
    this.uiState.isResizing.set(true);
    this.startX = e.clientX;
    this.startWidth = this.uiState.sidebarWidth();
    this.applyBodyResizeStyle();
  }

  startContent(e: MouseEvent): void {
    e.preventDefault();
    this.beginResizeGesture('content');
    this.uiState.isResizing.set(true);
    this.startX = e.clientX;
    this.startRatio = this.uiState.textColumnRatio();

    const mainEl = typeof document !== 'undefined' ? document.querySelector('main') : null;
    this.mainContentWidth = mainEl ? mainEl.clientWidth : MAIN_CONTENT_FALLBACK_WIDTH_PX;

    this.applyBodyResizeStyle();
  }

  onMouseMove(e: MouseEvent): void {
    if (!this.isResizingSidebar && !this.isResizingContent) return;
    e.preventDefault();
    // 使用 rAF 节流，避免每个 mousemove 都触发布局计算
    if (this.resizeRafId !== null) return;
    const clientX = e.clientX;
    const applyResize = () => {
      this.resizeRafId = null;
      if (this.isResizingSidebar) {
        const delta = clientX - this.startX;
        const newWidth = Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, this.startWidth + delta));
        this.uiState.sidebarWidth.set(newWidth);
      } else if (this.isResizingContent) {
        const delta = clientX - this.startX;
        const deltaPercent = (delta / this.mainContentWidth) * 100;
        const newRatio = Math.max(CONTENT_RATIO_MIN_PCT, Math.min(CONTENT_RATIO_MAX_PCT, this.startRatio + deltaPercent));
        this.uiState.textColumnRatio.set(newRatio);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      this.resizeRafId = requestAnimationFrame(applyResize);
      return;
    }

    applyResize();
  }

  onMouseUp(): void {
    this.finishResize();
  }

  teardown(): void {
    this.finishResize();
  }

  private finishResize(): void {
    if (!this.isResizingSidebar && !this.isResizingContent && this.resizeRafId === null) return;

    if (this.resizeRafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.resizeRafId);
      }
      this.resizeRafId = null;
    }
    this.isResizingSidebar = false;
    this.isResizingContent = false;
    this.uiState.isResizing.set(false);
    if (typeof document === 'undefined') return;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  private applyBodyResizeStyle(): void {
    if (typeof document === 'undefined') return;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  private beginResizeGesture(target: 'sidebar' | 'content'): void {
    this.cancelPendingResizeFrame();
    this.isResizingSidebar = target === 'sidebar';
    this.isResizingContent = target === 'content';
  }

  private cancelPendingResizeFrame(): void {
    if (this.resizeRafId === null) return;

    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.resizeRafId);
    }
    this.resizeRafId = null;
  }
}
