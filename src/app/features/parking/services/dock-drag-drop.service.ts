import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { TaskStore } from '../../../core/state/stores';
import { GateService } from '../../../../services/gate.service';
import { FocusDockLeaderService } from '../../../../services/focus-dock-leader.service';
import { DockSourceSection } from '../../../../models/parking-dock';
import { readTaskDragPayload, hasTaskDragTypes } from '../../../../utils/task-drag-payload';
import { TimerHandle } from '../../../../utils/timer-handle';
import { PARKING_CONFIG } from '../../../../config/parking.config';

export type DockDropState = 'idle' | 'canDrop' | 'isOver' | 'reject';

export interface DockDropCandidate {
  taskId: string;
  sourceSection?: 'text' | 'flow';
}

const DOCK_REORDER_MIME = 'application/x-nanoflow-dock-reorder';

/**
 * Encapsulates all drag-and-drop logic that was previously inlined in
 * ParkingDockComponent.  Provided at the component level so each dock
 * instance gets its own drag/drop state.
 */
@Injectable()
export class DockDragDropService implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly taskStore = inject(TaskStore);
  private readonly gateService = inject(GateService);
  private readonly focusLeader = inject(FocusDockLeaderService);

  // ── Signals ─────────────────────────────────────────────────
  readonly dropState = signal<DockDropState>('idle');
  readonly semicircleHoverExpanded = signal(false);

  // ── State ───────────────────────────────────────────────────
  draggingDockTaskId: string | null = null;
  touchStartY = 0;
  touchTaskId: string | null = null;
  private touchPointerId: number | null = null;
  private dockRailDragDepth = 0;
  private dropZoneDragDepth = 0;
  private externalDropCommitToken = 0;
  private destroyed = false;

  // ── Timers ──────────────────────────────────────────────────
  private readonly longPress = new TimerHandle();
  private readonly dropRejectReset = new TimerHandle();
  private readonly semicircleDragExpand = new TimerHandle();
  private readonly semicircleAutoCollapse = new TimerHandle();

  // ── Computed signals ────────────────────────────────────────
  readonly canMutateDock = computed(
    () => !this.gateService.isActive() && !this.focusLeader.isReadOnlyFollower(),
  );

  readonly canReorderDockCards = computed(
    () => this.canMutateDock() && !(this.engine.focusMode() && this.engine.focusScrimOn()),
  );

  readonly canAcceptExternalDrop = computed(() => this.canReorderDockCards());

  readonly semicircleExpanded = computed(
    () => this.engine.dockExpanded() || this.semicircleHoverExpanded(),
  );

  // ── Lifecycle ───────────────────────────────────────────────
  ngOnDestroy(): void {
    this.destroyed = true;
    this.externalDropCommitToken += 1;
    this.clearTransientDragState();
    this.longPress.cancel();
    this.dropRejectReset.cancel();
    this.semicircleDragExpand.cancel();
    this.semicircleAutoCollapse.cancel();
  }

  // ── Dock card reorder handlers ──────────────────────────────
  onDockCardDragStart(event: DragEvent, taskId: string): void {
    if (!this.canHandleDockReorder()) return;
    this.draggingDockTaskId = taskId;
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DOCK_REORDER_MIME, taskId);
    event.dataTransfer.setData('text/plain', taskId);
  }

  onDockCardDragOver(event: DragEvent, targetTaskId: string): void {
    if (!this.canHandleDockReorder()) return;
    if (!this.hasDockReorderType(event.dataTransfer)) return;
    if (this.draggingDockTaskId === targetTaskId) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onDockCardDrop(event: DragEvent, targetTaskId: string): void {
    if (!this.canHandleDockReorder()) return;
    const sourceTaskId = this.extractDockReorderTaskId(event.dataTransfer);
    if (!sourceTaskId || sourceTaskId === targetTaskId) return;
    event.preventDefault();
    void this.engine.reorderDockEntries(sourceTaskId, targetTaskId);
    this.draggingDockTaskId = null;
  }

  onDockCardDragEnd(): void {
    this.draggingDockTaskId = null;
    this.clearTransientDragState();
  }

  // ── Touch / wheel handlers ──────────────────────────────────
  onCardWheel(event: WheelEvent, taskId: string): void {
    if (!this.canHandleDockReorder()) return;
    if (!event.altKey) return;
    event.preventDefault();
    this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
  }

  onTouchStart(event: TouchEvent, taskId: string): void {
    if (!this.canHandleDockReorder()) return;
    this.startTouchLikeGesture(event.touches?.[0]?.clientY ?? 0, taskId);
  }

  onTouchMove(event: TouchEvent, _taskId?: string): void {
    if (!this.canHandleDockReorder()) return;
    this.moveTouchLikeGesture(event.touches?.[0]?.clientY ?? 0);
  }

  onPointerStart(event: PointerEvent, taskId: string): void {
    if (event.pointerType !== 'touch') return;
    if (!this.canHandleDockReorder()) return;
    this.touchPointerId = event.pointerId;
    const sourceElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    try {
      sourceElement?.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture 是增强项；失败时保留原手势路径。
    }
    this.startTouchLikeGesture(event.clientY, taskId);
  }

  onPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (this.touchPointerId !== null && event.pointerId !== this.touchPointerId) return;
    if (!this.canHandleDockReorder()) return;
    this.moveTouchLikeGesture(event.clientY);
  }

  onPointerEnd(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (this.touchPointerId !== null && event.pointerId !== this.touchPointerId) return;
    const sourceElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    try {
      sourceElement?.releasePointerCapture(event.pointerId);
    } catch {
      // 未捕获或已释放时无需处理。
    }
    this.onTouchEnd();
  }

  private startTouchLikeGesture(clientY: number, taskId: string): void {
    this.touchStartY = clientY;
    this.touchTaskId = null;
    this.longPress.schedule(() => {
      this.touchTaskId = taskId;
    }, PARKING_CONFIG.DOCK_LONG_PRESS_DELAY_MS);
  }

  private moveTouchLikeGesture(clientY: number): void {
    if (!this.touchTaskId) {
      const preLongPressDeltaY = clientY - this.touchStartY;
      if (Math.abs(preLongPressDeltaY) > 30) {
        this.longPress.cancel();
      }
      return;
    }

    const deltaY = clientY - this.touchStartY;
    if (Math.abs(deltaY) > 30) {
      this.engine.toggleLoad(this.touchTaskId, deltaY > 0 ? 'down' : 'up');
      this.touchStartY = clientY;
    }
  }

  onTouchEnd(): void {
    this.longPress.cancel();
    this.touchTaskId = null;
    this.touchPointerId = null;
    this.clearTransientDragState();
  }

  // ── Dock rail drag handlers ─────────────────────────────────
  onDockRailDragOver(event: DragEvent): void {
    if (!this.canHandleExternalDrop()) return;
    if (this.hasDockReorderType(event.dataTransfer)) {
      event.preventDefault();
      this.dropState.set('idle');
      return;
    }
    event.preventDefault();
    if (!hasTaskDragTypes(event.dataTransfer)) {
      if (this.dropState() !== 'reject') {
        this.dropState.set('idle');
      }
      return;
    }
    this.scheduleSemicircleDragExpand();
    if (this.dropState() !== 'reject') {
      this.dropState.set('canDrop');
    }
  }

  onDockRailDragEnter(event: DragEvent): void {
    if (!this.canHandleExternalDrop()) return;
    event.preventDefault();
    this.dockRailDragDepth += 1;
    if (this.hasDockReorderType(event.dataTransfer)) {
      this.dropState.set('idle');
      return;
    }
    if (!hasTaskDragTypes(event.dataTransfer)) {
      return;
    }
    this.scheduleSemicircleDragExpand();
    if (this.dropState() !== 'reject') {
      this.dropState.set('canDrop');
    }
  }

  onDockRailDragLeave(): void {
    if (!this.canHandleExternalDrop()) {
      this.clearTransientDragState();
      return;
    }
    this.dockRailDragDepth = Math.max(0, this.dockRailDragDepth - 1);
    if (this.dockRailDragDepth > 0) return;
    if (this.dropState() !== 'reject') {
      this.dropState.set('idle');
    }
    this.scheduleSemicircleAutoCollapse();
  }

  // ── Drop zone handlers ──────────────────────────────────────
  onDropZoneDragEnter(event: DragEvent): void {
    if (!this.canHandleExternalDrop()) return;
    event.preventDefault();
    this.dropZoneDragDepth += 1;
    if (!hasTaskDragTypes(event.dataTransfer)) {
      return;
    }
    this.scheduleSemicircleDragExpand();
    if (this.dropState() !== 'reject') {
      this.dropState.set('isOver');
    }
  }

  onDropZoneDragOver(event: DragEvent): void {
    if (!this.canHandleExternalDrop()) return;
    event.preventDefault();
    if (!hasTaskDragTypes(event.dataTransfer)) {
      if (this.dropState() === 'isOver') {
        this.dropState.set('canDrop');
      }
      return;
    }
    this.scheduleSemicircleDragExpand();
    if (this.dropState() !== 'reject') {
      this.dropState.set('isOver');
    }
  }

  onDropZoneDragLeave(): void {
    if (!this.canHandleExternalDrop()) {
      this.clearTransientDragState();
      return;
    }
    this.dropZoneDragDepth = Math.max(0, this.dropZoneDragDepth - 1);
    if (this.dropZoneDragDepth > 0) return;
    if (this.dropState() === 'isOver') {
      this.dropState.set('canDrop');
    }
    this.scheduleSemicircleAutoCollapse();
  }

  onDrop(event: DragEvent, markRecentlyDocked: (taskId: string) => void): void {
    if (!this.canHandleExternalDrop()) {
      this.clearTransientDragState();
      return;
    }
    this.dockRailDragDepth = 0;
    this.dropZoneDragDepth = 0;
    event.preventDefault();
    // 阻止冒泡：drop zone 嵌套在 dock rail 内，若不阻止，
    // 事件冒泡到 dock rail 时任务已入坞，canDropCandidate 判定已存在会误触 reject 动画
    event.stopPropagation?.();
    const reorderTaskId = this.extractDockReorderTaskId(event.dataTransfer);
    if (reorderTaskId) {
      this.draggingDockTaskId = null;
      this.dropState.set('idle');
      this.scheduleSemicircleAutoCollapse();
      return;
    }

    const candidate = this.extractDropCandidate(event.dataTransfer);
    if (!candidate || !this.canDropCandidate(candidate)) {
      this.triggerDropReject();
      return;
    }
    this.dropState.set('idle');
    const commitToken = ++this.externalDropCommitToken;
    const dockCommit = this.engine.dockTaskFromExternalDrag(candidate.taskId, candidate.sourceSection);
    if (typeof dockCommit === 'boolean') {
      this.handleExternalDropCommitResult(dockCommit, commitToken, candidate.taskId, markRecentlyDocked);
      return;
    }

    void Promise.resolve(dockCommit)
      .then(docked => {
        this.handleExternalDropCommitResult(docked, commitToken, candidate.taskId, markRecentlyDocked);
      })
      .catch(() => {
        if (!this.isActiveExternalDropCommit(commitToken)) return;
        this.triggerDropReject();
      });
  }

  // ── Semicircle expand / collapse scheduling (public) ────────
  scheduleSemicircleDragExpand(): void {
    if (this.destroyed) return;
    if (this.semicircleExpanded()) return;
    if (this.semicircleDragExpand.active) return;
    this.semicircleDragExpand.schedule(() => {
      if (!this.canHandleExternalDrop()) return;
      if (this.destroyed) return;
      this.semicircleHoverExpanded.set(true);
      void this.engine.setDockExpanded(true, { persistPreference: false });
      this.scheduleSemicircleAutoCollapse();
    }, PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);
  }

  scheduleSemicircleAutoCollapse(): void {
    if (this.destroyed) return;
    this.semicircleDragExpand.cancel();
    this.semicircleAutoCollapse.cancel();
    if (this.engine.dockExpanded()) return;
    this.semicircleAutoCollapse.schedule(() => {
      if (!this.engine.dockExpanded()) {
        this.semicircleHoverExpanded.set(false);
      }
    }, PARKING_CONFIG.DOCK_SEMICIRCLE_AUTO_COLLAPSE_MS);
  }

  cancelAutoCollapse(): void {
    this.semicircleAutoCollapse.cancel();
  }

  // ── Private helpers ─────────────────────────────────────────
  private extractDockReorderTaskId(dataTransfer: DataTransfer | null): string | null {
    if (!dataTransfer) return null;
    const value = dataTransfer.getData(DOCK_REORDER_MIME).trim();
    return value || null;
  }

  private extractDropCandidate(dataTransfer: DataTransfer | null): DockDropCandidate | null {
    if (!dataTransfer) return null;

    const payload = readTaskDragPayload(dataTransfer);
    if (payload?.taskId) {
      const sourceSection: DockSourceSection | undefined =
        payload.source === 'text' || payload.source === 'flow'
          ? payload.source
          : undefined;
      return {
        taskId: payload.taskId,
        sourceSection,
      };
    }

    const text = dataTransfer.getData('text/plain').trim();
    if (!text) return null;
    return { taskId: text };
  }

  private canDropCandidate(candidate: DockDropCandidate): boolean {
    if (!this.canHandleExternalDrop()) return false;
    const alreadyDocked = this.engine.dockedEntries().some(entry => entry.taskId === candidate.taskId);
    if (alreadyDocked) return false;
    const task = this.taskStore.getTask(candidate.taskId);
    return Boolean(task && task.status === 'active');
  }

  private canHandleDockReorder(): boolean {
    return !this.destroyed && this.canReorderDockCards();
  }

  private canHandleExternalDrop(): boolean {
    return !this.destroyed && this.canAcceptExternalDrop();
  }

  private hasDockReorderType(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    return dataTransfer.types.includes(DOCK_REORDER_MIME);
  }

  private triggerDropReject(): void {
    if (this.destroyed) return;
    this.dockRailDragDepth = 0;
    this.dropZoneDragDepth = 0;
    this.dropState.set('reject');
    this.scheduleSemicircleAutoCollapse();
    this.dropRejectReset.schedule(() => {
      this.dropState.set('idle');
    }, PARKING_CONFIG.DOCK_DROP_REJECT_RESET_MS);
  }

  private isActiveExternalDropCommit(commitToken: number): boolean {
    return !this.destroyed && commitToken === this.externalDropCommitToken;
  }

  private handleExternalDropCommitResult(
    docked: boolean,
    commitToken: number,
    taskId: string,
    markRecentlyDocked: (taskId: string) => void,
  ): void {
    if (!this.isActiveExternalDropCommit(commitToken)) return;
    if (!docked) {
      this.triggerDropReject();
      return;
    }
    markRecentlyDocked(taskId);
    this.scheduleSemicircleAutoCollapse();
  }

  private clearTransientDragState(): void {
    this.dockRailDragDepth = 0;
    this.dropZoneDragDepth = 0;
    if (this.dropState() !== 'reject') {
      this.dropState.set('idle');
    }
    this.semicircleDragExpand.cancel();
  }
}
