import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PerformanceTierService, type FocusPerformanceTier } from '../../../../services/performance-tier.service';
import { DockFocusTransitionState } from '../../../../models/parking-dock';
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
  readonly transitionPerformanceTierLock = signal<FocusPerformanceTier | null>(null);

  // ── Computed ──
  readonly performanceTier = computed(
    () => this.transitionPerformanceTierLock() ?? this.performanceTierService.tier(),
  );

  // ── Internal state ──
  private readonly flip = new TimerHandle();
  private readonly pendingRafs: number[] = [];
  private readonly motion = PARKING_CONFIG.MOTION;

  // ── Public methods ──

  runEnterFocusTransition(): void {
    const transition = buildFocusTransition('enter', this.motion.focus, this.engine.dockExpanded());
    if (!transition) {
      this.transitionPerformanceTierLock.set(null);
      this.engine.toggleFocusMode();
      return;
    }

    this.transitionPerformanceTierLock.set(this.performanceTierService.tier());
    this.engine.holdNonCriticalWork(transition.durationMs! + 120);
    this.engine.beginFocusTransition(transition);
    this.startFlipGhost(transition);

    this.pendingRafs.push(requestAnimationFrame(() => {
      this.engine.toggleFocusMode();
    }));

    this.flip.schedule(() => {
      const current = this.engine.focusTransition();
      if (current?.phase === 'entering') {
        this.finalizeEnterFocusTransition(current);
      }
    }, transition.durationMs!);
  }

  runExitFocusTransition(): void {
    const transition = buildFocusTransition('exit', this.motion.focus, this.engine.dockExpanded());
    if (!transition) {
      this.transitionPerformanceTierLock.set(null);
      this.engine.endFocusTransition();
      this.engine.toggleFocusMode();
      return;
    }

    this.transitionPerformanceTierLock.set(this.performanceTierService.tier());
    this.engine.holdNonCriticalWork(transition.durationMs! + 120);
    this.engine.beginFocusTransition(transition);
    this.startFlipGhost(transition);

    this.pendingRafs.push(requestAnimationFrame(() => {
      this.engine.toggleFocusMode();
    }));

    this.flip.schedule(() => {
      const current = this.engine.focusTransition();
      if (current?.phase === 'exiting') {
        this.finalizeExitFocusTransition();
      }
    }, transition.durationMs!);
  }

  finalizeEnterFocusTransition(transition: DockFocusTransitionState): void {
    this.flip.cancel();
    this.engine.beginFocusTransition({
      ...transition,
      phase: 'focused',
    });
    this.clearFlipGhost();
    this.transitionPerformanceTierLock.set(null);
  }

  finalizeExitFocusTransition(): void {
    this.flip.cancel();
    this.engine.endFocusTransition();
    this.clearFlipGhost();
    this.transitionPerformanceTierLock.set(null);
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
    requestAnimationFrame(() => this.flipGhostActive.set(true));
  }

  private clearFlipGhost(): void {
    this.flipGhost.set(null);
    this.flipGhostActive.set(false);
  }

  // ── Lifecycle ──

  ngOnDestroy(): void {
    this.flip.cancel();
    this.cancelPendingRafs();
  }
}
