import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PerformanceTierService, type FocusPerformanceTier } from '../../../../services/performance-tier.service';
import {
  DockEntry,
  DockFocusTransitionState,
  StatusMachineEntry,
} from '../../../../models/parking-dock';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { TimerHandle } from '../../../../utils/timer-handle';
import {
  buildFocusTransition,
  createFlipGhostState,
  type DockFlipGhostState,
} from '../utils/dock-flip-transition';

/**
 * Encapsulates focus-mode enter/exit transition animation logic
 * previously inlined in ParkingDockComponent.
 * Provided at the component level so each dock instance gets its own state.
 */
@Injectable()
export class DockFocusTransitionService implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly performanceTierService = inject(PerformanceTierService);

  // ── Signals ──
  readonly flipGhost = signal<DockFlipGhostState | null>(null);
  readonly flipGhostActive = signal(false);
  readonly floatingUiVisible = signal(false);
  readonly transitionPerformanceTierLock = signal<FocusPerformanceTier | null>(null);
  readonly exitVisualSnapshot = signal<{
    consoleEntries: DockEntry[];
    statusMachineEntries: StatusMachineEntry[];
  } | null>(null);

  // ── Computed ──
  readonly performanceTier = computed(
    () => this.transitionPerformanceTierLock() ?? this.performanceTierService.tier(),
  );

  // ── Internal state ──
  private readonly flip = new TimerHandle();
  private readonly floatingUiDelay = new TimerHandle();
  /** 退出时延迟清除 focusTransition 的定时器，让浮动 UI 退出动画完整播放 */
  private readonly exitUnmount = new TimerHandle();
  private readonly pendingRafs: number[] = [];
  private readonly motion = PARKING_CONFIG.MOTION;

  /** MEM-H4 fix: rAF 执行后从数组中移除，防止无限增长 */
  private scheduleRaf(fn: () => void): void {
    const id = requestAnimationFrame(() => {
      const idx = this.pendingRafs.indexOf(id);
      if (idx >= 0) this.pendingRafs.splice(idx, 1);
      fn();
    });
    this.pendingRafs.push(id);
  }

  // ── Public methods ──

  runEnterFocusTransition(): void {
    this.clearExitVisualSnapshot();
    this.floatingUiDelay.cancel();
    this.floatingUiVisible.set(false);
    this.exitUnmount.cancel();
    const transition = buildFocusTransition('enter', this.motion.focus, false);
    if (!transition) {
      this.transitionPerformanceTierLock.set(null);
      this.engine.clearFocusChromeRestore();
      this.floatingUiVisible.set(true);
      this.engine.toggleFocusMode();
      return;
    }

    this.transitionPerformanceTierLock.set(this.performanceTierService.tier());
    this.engine.holdNonCriticalWork(transition.durationMs! + 120);
    this.engine.beginFocusTransition(transition);
    this.startFlipGhost(transition);
    this.floatingUiDelay.schedule(() => {
      this.floatingUiVisible.set(true);
    }, this.motion.focus.hudDelayMs);

    this.scheduleRaf(() => {
      this.engine.toggleFocusMode();
    });

    this.flip.schedule(() => {
      const current = this.engine.focusTransition();
      if (current?.phase === 'entering') {
        this.finalizeEnterFocusTransition(current);
      }
    }, transition.durationMs!);
  }

  runExitFocusTransition(): void {
    this.floatingUiDelay.cancel();
    this.floatingUiVisible.set(true);
    const transition = buildFocusTransition('exit', this.motion.focus, this.engine.dockExpanded());
    if (!transition) {
      this.transitionPerformanceTierLock.set(null);
      this.engine.toggleFocusMode();
      if (this.engine.lastExitAction() === 'clear_exit') {
        this.engine.finalizeClearDockForExit();
      }
      this.engine.beginFocusChromeRestore(PARKING_CONFIG.DOCK_ANIMATION_MS);
      this.floatingUiVisible.set(false);
      this.clearExitVisualSnapshot();
      return;
    }

    this.transitionPerformanceTierLock.set(this.performanceTierService.tier());
    this.engine.holdNonCriticalWork(transition.durationMs! + 120);
    this.engine.beginFocusTransition(transition);
    this.startFlipGhost(transition);

    this.flip.schedule(() => {
      const current = this.engine.focusTransition();
      if (current?.phase === 'exiting') {
        this.finalizeExitFocusTransition();
      }
    }, transition.durationMs!);
  }

  finalizeEnterFocusTransition(transition: DockFocusTransitionState): void {
    this.flip.cancel();
    this.floatingUiDelay.cancel();
    this.engine.beginFocusTransition({
      ...transition,
      phase: 'focused',
    });
    this.floatingUiVisible.set(true);
    this.clearFlipGhost();
    this.clearExitVisualSnapshot();
    this.transitionPerformanceTierLock.set(null);
  }

  finalizeExitFocusTransition(): void {
    this.flip.cancel();
    if (this.engine.lastExitAction() === 'clear_exit') {
      this.engine.finalizeClearDockForExit();
    }
    if (this.engine.focusMode()) {
      this.engine.toggleFocusMode();
    }
    // 使用 shell.enterMs 作为 chrome restore 时长，确保 CSS transition 可以在 restoring 阶段内完成
    const restoreDuration = this.motion.shell.enterMs;
    this.engine.beginFocusChromeRestore(restoreDuration);
    // 延迟清除 focusTransition，让浮动 UI 的退出动画在 focusSessionMounted=true 期间播放完毕。
    // 如果立即清除，@if(focusSessionMounted()) 包裹的元素会被瞬间卸载，退出动画被截断。
    this.exitUnmount.schedule(() => {
      this.floatingUiVisible.set(false);
      this.engine.endFocusTransition();
    }, Math.min(this.motion.focus.exitMs, 200));
    this.clearFlipGhost();
    this.clearExitVisualSnapshot();
    this.transitionPerformanceTierLock.set(null);
  }

  captureExitVisualSnapshot(snapshot: {
    consoleEntries: DockEntry[];
    statusMachineEntries: StatusMachineEntry[];
  }): void {
    this.exitVisualSnapshot.set({
      consoleEntries: snapshot.consoleEntries.map((entry) => ({ ...entry })),
      statusMachineEntries: snapshot.statusMachineEntries.map((entry) => ({ ...entry })),
    });
  }

  clearExitVisualSnapshot(): void {
    this.exitVisualSnapshot.set(null);
  }

  prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  cancelPendingRafs(): void {
    this.pendingRafs.forEach(id => cancelAnimationFrame(id));
    this.pendingRafs.length = 0;
  }

  // ── Private methods ──

  private startFlipGhost(transition: DockFocusTransitionState): void {
    const ghost = createFlipGhostState(transition);
    if (!ghost) return;

    this.flipGhost.set(ghost);
    this.flipGhostActive.set(false);
    // 单帧 rAF：让幽灵元素先渲染到初始位置，下一帧激活 CSS transition
    this.scheduleRaf(() => this.flipGhostActive.set(true));
  }

  private clearFlipGhost(): void {
    this.flipGhost.set(null);
    this.flipGhostActive.set(false);
  }

  // ── Lifecycle ──

  ngOnDestroy(): void {
    this.flip.cancel();
    this.floatingUiDelay.cancel();
    this.exitUnmount.cancel();
    this.cancelPendingRafs();
    this.floatingUiVisible.set(false);
    this.clearExitVisualSnapshot();
  }
}
