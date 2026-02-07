import { Injectable, inject, signal, effect, untracked } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { Task } from '../../../../models';

/**
 * 任务详情面板：Split-Brain 表单状态管理服务
 * 
 * 职责：
 * - 本地编辑缓冲（localTitle / localContent）
 * - 聚焦锁定，防止远程覆盖正在编辑的字段
 * - 编辑/预览模式切换（含节流保护）
 * - 任务切换时的保护机制，防止 ngModelChange 误发射
 * 
 * 使用方式：在组件 providers 中提供，组件注入后调用 init() 传入 task signal
 */
@Injectable()
export class FlowTaskDetailFormService {
  private readonly projectState = inject(ProjectStateService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowTaskDetailForm');

  // ========== Split-Brain 本地状态 ==========
  /** 本地标题（与 Store 解耦，仅在非聚焦时同步） */
  readonly localTitle = signal('');
  /** 本地内容（与 Store 解耦，仅在非聚焦时同步） */
  readonly localContent = signal('');
  /** 编辑模式状态（默认为预览模式） */
  readonly isEditMode = signal(false);
  /** 防止快速点击的节流标记 */
  readonly isTogglingMode = signal(false);

  /** 标题输入框是否聚焦 */
  isTitleFocused = false;
  /** 内容输入框是否聚焦 */
  isContentFocused = false;
  /** 标记是否正在进行文本选择 */
  isSelecting = false;

  /** 解锁延迟定时器 */
  private unlockTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** 跟踪当前任务 ID，用于检测任务切换 */
  private currentTaskId: string | null = null;
  /**
   * 任务切换保护标志
   * 在任务切换期间阻止 ngModelChange 事件发射，防止旧任务的值被错误地发射到新任务
   */
  private isTaskSwitching = false;

  /**
   * 初始化 Split-Brain 同步 effect
   * 必须在组件 constructor 中、injection context 下调用
   */
  initSyncEffect(taskSignal: () => Task | null): void {
    effect(() => {
      const task = taskSignal();
      if (task) {
        const taskChanged = this.currentTaskId !== task.id;
        if (taskChanged) {
          this.handleTaskSwitch(task);
        } else {
          // 同一任务：仅当输入框未聚焦时才同步
          if (!this.isTitleFocused) {
            this.localTitle.set(task.title || '');
          }
          if (!this.isContentFocused) {
            this.localContent.set(task.content || '');
          }
        }
      } else {
        this.handleTaskClear();
      }
    });
  }

  /** 锁定任务字段（防止远程覆盖本地编辑） */
  lockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.projectState.activeProjectId();
    if (!projectId) return;

    for (const field of fields) {
      this.changeTracker.lockTaskField(taskId, projectId, field, ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS);
    }
  }

  /** 解锁任务字段 */
  unlockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.projectState.activeProjectId();
    if (!projectId) return;

    for (const field of fields) {
      this.changeTracker.unlockTaskField(taskId, projectId, field);
    }
  }

  /** 输入框聚焦处理 */
  onInputFocus(field: 'title' | 'content', task: Task | null): void {
    if (!task) return;

    if (field === 'title') {
      this.isTitleFocused = true;
      const existingTimer = this.unlockTimers.get('title');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('title');
      }
      this.lockTaskFields(task.id, ['title']);
    } else if (field === 'content') {
      this.isContentFocused = true;
      const existingTimer = this.unlockTimers.get('content');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('content');
      }
      this.lockTaskFields(task.id, ['content']);
    }
  }

  /**
   * 输入框失焦处理
   * @returns 需要发射的事件数据（由组件负责 emit）
   */
  onInputBlur(field: 'title' | 'content', task: Task | null): { field: string; taskId: string; value: string } | null {
    if (!task) return null;

    if (field === 'title') {
      const value = this.localTitle();
      const timer = setTimeout(() => {
        this.isTitleFocused = false;
        this.unlockTaskFields(task.id, ['title']);
        this.unlockTimers.delete('title');
      }, 10000);
      this.unlockTimers.set('title', timer);
      return { field: 'title', taskId: task.id, value };
    } else if (field === 'content') {
      const value = this.localContent();
      const timer = setTimeout(() => {
        this.isContentFocused = false;
        this.unlockTaskFields(task.id, ['content']);
        this.unlockTimers.delete('content');
      }, 10000);
      this.unlockTimers.set('content', timer);
      return { field: 'content', taskId: task.id, value };
    }
    return null;
  }

  /**
   * 本地标题变更
   * @returns 需要发射的事件数据，任务切换期间返回 null
   */
  onLocalTitleChange(value: string, task: Task | null): { taskId: string; title: string } | null {
    if (this.isTaskSwitching) {
      this.logger.debug('任务切换中，跳过 titleChange 发射');
      return null;
    }

    this.localTitle.set(value);
    if (task) {
      return { taskId: task.id, title: value };
    }
    return null;
  }

  /**
   * 本地内容变更
   * @returns 需要发射的事件数据，任务切换期间返回 null
   */
  onLocalContentChange(value: string, task: Task | null): { taskId: string; content: string } | null {
    if (this.isTaskSwitching) {
      this.logger.debug('任务切换中，跳过 contentChange 发射');
      return null;
    }

    this.localContent.set(value);
    if (task) {
      return { taskId: task.id, content: value };
    }
    return null;
  }

  /** 切换编辑模式（带节流保护，防止 Rage Click） */
  toggleEditMode(): void {
    if (this.isTogglingMode()) {
      this.logger.debug('toggleEditMode: 节流中，忽略点击');
      return;
    }

    this.isTogglingMode.set(true);
    const newMode = !this.isEditMode();
    this.logger.debug(`toggleEditMode: 当前模式 = ${this.isEditMode()} → 新模式 = ${newMode}`);
    this.isEditMode.update(v => !v);

    setTimeout(() => {
      this.isTogglingMode.set(false);
    }, 300);
  }

  /**
   * 判断点击/触摸事件是否应导致退出编辑模式
   * @returns true 表示应切换到预览模式
   */
  shouldExitEditMode(target: HTMLElement, containerElement: HTMLElement): boolean {
    if (!this.isEditMode()) return false;
    if (this.isSelecting) return false;

    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return false;

    const isInteractiveElement = target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'BUTTON' ||
      target.tagName === 'svg' ||
      target.tagName === 'path' ||
      target.closest('input, textarea, button, svg') !== null;

    if (isInteractiveElement) {
      this.logger.debug('点击可交互元素，保持编辑模式');
      return false;
    }

    // 无论点击面板内外的非交互区域，都退出编辑模式
    return true;
  }

  /** 清理定时器和状态 */
  cleanup(): void {
    for (const timer of this.unlockTimers.values()) {
      clearTimeout(timer);
    }
    this.unlockTimers.clear();
  }

  // ========== 私有方法 ==========

  /** 处理任务切换 */
  private handleTaskSwitch(task: Task): void {
    this.isTaskSwitching = true;

    // 解锁旧任务的字段
    if (this.currentTaskId) {
      const projectId = this.projectState.activeProjectId();
      if (projectId) {
        this.unlockTaskFields(this.currentTaskId, ['title', 'content']);
      }
    }

    this.currentTaskId = task.id;
    this.localTitle.set(task.title || '');
    this.localContent.set(task.content || '');
    this.isTitleFocused = false;
    this.isContentFocused = false;
    this.unlockTimers.forEach(timer => clearTimeout(timer));
    this.unlockTimers.clear();

    queueMicrotask(() => {
      this.isTaskSwitching = false;
    });
  }

  /** 处理任务清空 */
  private handleTaskClear(): void {
    this.isTaskSwitching = true;

    if (this.currentTaskId) {
      const projectId = this.projectState.activeProjectId();
      if (projectId) {
        this.unlockTaskFields(this.currentTaskId, ['title', 'content']);
      }
    }

    this.currentTaskId = null;
    this.localTitle.set('');
    this.localContent.set('');
    this.isTitleFocused = false;
    this.isContentFocused = false;
    this.unlockTimers.forEach(timer => clearTimeout(timer));
    this.unlockTimers.clear();

    queueMicrotask(() => {
      this.isTaskSwitching = false;
    });
  }
}
