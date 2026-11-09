/**
 * KeyboardShortcutService
 *
 * 从 WorkspaceShellComponent 抽离的全局快捷键处理。
 *
 * 职责单一：
 * - 在 capture 阶段注册 keydown，优先于聚焦组件处理 Ctrl/Cmd 快捷键
 * - 撤销/重做（Z / Shift+Z / Y）、全局搜索聚焦（F）、黑盒面板开关（B）
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；workspace-shell.component.ts 长期越界
 * - 快捷键分发是独立的横切责任，依赖均可通过 DI 获取（TaskOps / UiState / 黑盒 store）
 *
 * 背景（保留历史注释）：某些聚焦组件（如 GoJS Canvas / 第三方控件）会在 bubble 阶段
 * stopPropagation，导致 `HostListener('document:keydown')` 偶发收不到 Ctrl/Cmd+Z，
 * 表现为「撤回失效」。解决：capture 阶段优先处理，bubble 阶段用 defaultPrevented 去重。
 */
import { Injectable, Injector, inject } from '@angular/core';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { UiStateService } from './ui-state.service';
import { DynamicModalService } from './dynamic-modal.service';
import { ModalService } from './modal.service';
import { ToastService } from './toast.service';
import { showBlackBoxPanel } from '../state/focus-stores';

/** 侧栏搜索框聚焦前的等待时长（毫秒）—— 等待侧栏展开动画落定 */
const SIDEBAR_SEARCH_FOCUS_DELAY_MS = 50;

@Injectable({ providedIn: 'root' })
export class KeyboardShortcutService {
  private readonly injector = inject(Injector);
  private readonly uiState = inject(UiStateService);
  private readonly dynamicModal = inject(DynamicModalService);
  private readonly modal = inject(ModalService);
  private readonly toast = inject(ToastService);
  private started = false;
  private searchFocusTimer: ReturnType<typeof setTimeout> | null = null;

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  private readonly captureListener = (event: KeyboardEvent) => {
    if (this.shouldIgnore(event)) return;

    const key = event.key.toLowerCase();
    if (this.handleUndoRedo(event, key)) return;
    if (this.handleSearch(event, key)) return;
    this.handleBlackBox(event, key);
  };

  /** 注册 capture 阶段的全局快捷键监听。 */
  initialize(): void {
    if (this.started) return;
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', this.captureListener, { capture: true });
    this.started = true;
  }

  /** 注销监听。 */
  teardown(): void {
    if (this.searchFocusTimer !== null) {
      clearTimeout(this.searchFocusTimer);
      this.searchFocusTimer = null;
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.captureListener, { capture: true } as AddEventListenerOptions);
    }
    this.started = false;
  }

  private shouldIgnore(event: KeyboardEvent): boolean {
    return event.defaultPrevented
      || !event.key
      || (!event.ctrlKey && !event.metaKey)
      || this.dynamicModal.hasOpenModal()
      || this.modal.hasOpenModal()
      || this.isEditableTarget(event.target);
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }

    if (target.closest('input, textarea, select')) {
      return true;
    }

    const editableHost = target.closest('[contenteditable]');
    return editableHost !== null
      && editableHost.getAttribute('contenteditable')?.toLowerCase() !== 'false';
  }

  private handleUndoRedo(event: KeyboardEvent, key: string): boolean {
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.runUndoRedoCommand(() => this.taskOpsAdapter.performUndo());
      return true;
    }

    if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      this.runUndoRedoCommand(() => this.taskOpsAdapter.performRedo());
      return true;
    }

    return false;
  }

  private runUndoRedoCommand(command: () => Promise<unknown>): void {
    try {
      void Promise.resolve(command()).catch(error => {
        this.reportUndoRedoFailure(error);
      });
    } catch (error) {
      this.reportUndoRedoFailure(error);
    }
  }

  /**
   * 撤销/重做失败上报：warn 保留诊断线索，Toast 让用户看到失败。
   * ToastService.warning 自带同文案去重（ERROR_DEDUP_INTERVAL），连按快捷键不会刷屏。
   */
  private reportUndoRedoFailure(error: unknown): void {
    console.warn('Keyboard shortcut undo/redo failed', error);
    this.toast.warning('撤销/重做失败', '操作未生效，请重试');
  }

  private handleSearch(event: KeyboardEvent, key: string): boolean {
    if (event.shiftKey || key !== 'f') return false;

    event.preventDefault();
    this.focusGlobalSearchInput();
    return true;
  }

  private focusGlobalSearchInput(): void {
    this.uiState.sidebarOpen.set(true);
    if (this.searchFocusTimer !== null) {
      clearTimeout(this.searchFocusTimer);
    }
    this.searchFocusTimer = setTimeout(() => {
      this.searchFocusTimer = null;
      if (this.dynamicModal.hasOpenModal() || this.modal.hasOpenModal()) return;
      if (typeof document === 'undefined') return;
      const searchInput = document.querySelector<HTMLInputElement>('aside input[aria-label="搜索项目或任务"]');
      searchInput?.focus();
      searchInput?.select();
    }, SIDEBAR_SEARCH_FOCUS_DELAY_MS);
  }

  private handleBlackBox(event: KeyboardEvent, key: string): boolean {
    if (event.shiftKey || key !== 'b') return false;

    event.preventDefault();
    showBlackBoxPanel.update(v => !v);
    return true;
  }
}
