interface TextViewMouseDragWatchdogLogger {
  warn(message: string, context?: unknown): void;
}

export interface TextViewMouseDragWatchdogControllerOptions {
  logger: TextViewMouseDragWatchdogLogger;
  getDraggingTaskId: () => string | null;
  isTouchDragging: () => boolean;
}

/**
 * 鼠标拖拽丢失看门狗 — 从 TextViewDragDropService 拆分
 *
 * 拖拽源节点在拖拽中被移除（远端同步删移/项目切换重渲染）时
 * Chrome 不会派发 dragend，document dragover 监听与 rAF 自动滚动会一直滞留。
 * 以 dragover 心跳（活跃拖拽在窗口内每 ~350ms 持续触发）静默 + 源节点缺失双条件自愈，
 * 避免把「拖出窗口」（源节点仍在）误判为拖拽丢失。
 * 非 DI 协作类：由 TextViewDragDropService 构造并注入运行时闭包，
 * 行为由 text-view-drag-drop.service.spec.ts 的看门狗用例覆盖。
 */
export class TextViewMouseDragWatchdogController {
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MOUSE_DRAG_WATCHDOG_MS = 1500;

  constructor(private readonly options: TextViewMouseDragWatchdogControllerOptions) {}

  arm(): void {
    this.clear();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this.checkMouseDragStillAlive();
    }, TextViewMouseDragWatchdogController.MOUSE_DRAG_WATCHDOG_MS);
  }

  clear(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private checkMouseDragStillAlive(): void {
    const draggingTaskId = this.options.getDraggingTaskId();
    if (!draggingTaskId || this.options.isTouchDragging()) {
      return;
    }

    // 源节点仍在 DOM：dragover 静默大概率只是拖出了浏览器窗口（跨窗口拖拽），
    // dragend 之后仍会送达源节点，继续等待而不是误清理
    if (this.isDragSourceElementPresent(draggingTaskId)) {
      this.arm();
      return;
    }

    this.options.logger.warn('[MouseDrag] 拖拽源节点已被移除且 dragover 静默，dragend 可能已丢失，触发自愈清理', {
      draggingTaskId,
    });
    document.dispatchEvent(new CustomEvent('mouseDragLost'));
  }

  private isDragSourceElementPresent(taskId: string): boolean {
    if (typeof document === 'undefined') {
      return true;
    }

    const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(taskId)
      : taskId;
    return document.querySelector(`[data-task-id="${escapedId}"], [data-unassigned-task="${escapedId}"]`) !== null;
  }
}
