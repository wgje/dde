import type { NgZone } from '@angular/core';

import { isInteractiveSelectionTarget } from '../../../../utils/text-selection';

const NESTED_SCROLL = {
  BOUNDARY_EPSILON: 4,
  MIN_HANDOFF_VELOCITY: 0.18,
  MIN_MOMENTUM_VELOCITY: 0.03,
  MAX_MOMENTUM_VELOCITY: 1.35,
  HANDOFF_VELOCITY_SCALE: 0.38,
  HANDOFF_THROTTLE_MS: 48,
  WHEEL_OUTER_FOLLOW_SHARE: 0.1,
  WHEEL_MAX_OUTER_STEP_PX: 72,
  WHEEL_MIN_DELTA_PX: 0.5,
  WHEEL_MAX_DELTA_PX: 520,
  WHEEL_LINE_HEIGHT_PX: 16,
  WHEEL_DELTA_LINE_MODE: 1,
  WHEEL_DELTA_PAGE_MODE: 2,
  MOMENTUM_RAMP_MS: 80,
  MOMENTUM_MAX_MS: 900,
  DECAY_PER_FRAME: 0.91,
  FRAME_MS: 16.67,
} as const;

interface NestedScrollState {
  lastTop: number;
  lastTime: number;
  velocity: number;
  handoffTimer: ReturnType<typeof setTimeout> | null;
}

type TextViewNestedScrollHandoffOptions = {
  zone: Pick<NgZone, 'runOutsideAngular'>;
};

export class TextViewNestedScrollHandoffController {
  private nestedScrollRoot: HTMLElement | null = null;
  private nestedScrollStates = new WeakMap<HTMLElement, NestedScrollState>();
  private nestedTaskListCleanups = new Map<HTMLElement, () => void>();
  private nestedScrollObserver: MutationObserver | null = null;
  private nestedMomentumFrameId: number | null = null;
  private nestedWheelFrameId: number | null = null;
  private pendingNestedWheel: { taskList: HTMLElement; delta: number } | null = null;
  private nestedWheelControlledUntil = 0;

  constructor(private readonly options: TextViewNestedScrollHandoffOptions) {}

  attach(root: HTMLElement): void {
    this.detach();
    this.nestedScrollRoot = root;
    this.options.zone.runOutsideAngular(() => {
      this.attachNestedTaskLists(root);
      this.nestedScrollObserver = new MutationObserver(() => this.attachNestedTaskLists(root));
      this.nestedScrollObserver.observe(root, { childList: true, subtree: true });
    });
  }

  detach(): void {
    this.nestedScrollObserver?.disconnect();
    this.nestedScrollObserver = null;
    const cleanups = [...this.nestedTaskListCleanups.values()];
    this.nestedTaskListCleanups.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort detach must continue cleaning remaining task lists.
      }
    }
    this.nestedScrollStates = new WeakMap<HTMLElement, NestedScrollState>();
    this.cancelNestedMomentum();
    this.cancelNestedWheelFrame();
    this.nestedScrollRoot = null;
  }

  private attachNestedTaskLists(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-stage-task-list]')
      .forEach(taskList => this.attachNestedTaskList(taskList));
  }

  private attachNestedTaskList(taskList: HTMLElement): void {
    if (this.nestedTaskListCleanups.has(taskList)) return;
    const onScroll = () => this.handleNestedTaskListScroll(taskList);
    const onWheel = (event: WheelEvent) => this.handleNestedTaskListWheel(taskList, event);
    taskList.addEventListener('scroll', onScroll, { passive: true });
    taskList.addEventListener('wheel', onWheel, { passive: false });
    this.nestedTaskListCleanups.set(taskList, () => {
      taskList.removeEventListener('scroll', onScroll);
      taskList.removeEventListener('wheel', onWheel);
    });
  }

  private handleNestedTaskListWheel(taskList: HTMLElement, event: WheelEvent): void {
    if (this.shouldIgnoreNestedWheel(event)) return;

    const delta = this.normalizeNestedWheelDelta(event, taskList);
    if (Math.abs(delta) < NESTED_SCROLL.WHEEL_MIN_DELTA_PX) return;

    const direction = Math.sign(delta);
    const chain = this.resolveNestedScrollChain(taskList);
    const canScrollTaskList = this.canNestedScrollInDirection(taskList, direction);
    const canScrollChain = chain.some(container => this.canNestedScrollInDirection(container, direction));
    if (!canScrollTaskList && !canScrollChain) return;

    if (event.cancelable) {
      event.preventDefault();
    }
    this.cancelNestedMomentum();
    this.queueNestedWheelDelta(taskList, delta);
  }

  private queueNestedWheelDelta(taskList: HTMLElement, delta: number): void {
    if (this.pendingNestedWheel && this.pendingNestedWheel.taskList !== taskList) {
      this.flushNestedWheelDelta();
    }

    const queuedDelta = (this.pendingNestedWheel?.delta ?? 0) + delta;
    const maxDelta = NESTED_SCROLL.WHEEL_MAX_DELTA_PX;
    this.pendingNestedWheel = { taskList, delta: Math.max(-maxDelta, Math.min(maxDelta, queuedDelta)) };

    if (this.nestedWheelFrameId !== null) return;
    this.nestedWheelFrameId = requestAnimationFrame(() => this.flushNestedWheelDelta());
  }

  private flushNestedWheelDelta(): void {
    if (this.nestedWheelFrameId !== null) {
      cancelAnimationFrame(this.nestedWheelFrameId);
      this.nestedWheelFrameId = null;
    }

    const pendingWheel = this.pendingNestedWheel;
    this.pendingNestedWheel = null;
    if (!pendingWheel?.taskList.isConnected) return;

    this.applyNestedWheelDelta(pendingWheel.taskList, pendingWheel.delta);
  }

  private applyNestedWheelDelta(taskList: HTMLElement, delta: number): void {
    if (Math.abs(delta) < NESTED_SCROLL.WHEEL_MIN_DELTA_PX) return;

    const direction = Math.sign(delta);
    const chain = this.resolveNestedScrollChain(taskList);
    const canScrollTaskList = this.canNestedScrollInDirection(taskList, direction);
    const canScrollChain = chain.some(container => this.canNestedScrollInDirection(container, direction));
    if (!canScrollTaskList && !canScrollChain) return;

    this.nestedWheelControlledUntil = performance.now() + NESTED_SCROLL.HANDOFF_THROTTLE_MS;
    const innerDelta = canScrollTaskList ? delta : 0;
    const innerConsumed = this.applyNestedScrollElement(taskList, innerDelta, direction);
    const followDelta = canScrollTaskList ? delta * NESTED_SCROLL.WHEEL_OUTER_FOLLOW_SHARE : 0;
    const outerDelta = this.clampNestedOuterWheelDelta(delta - innerConsumed + followDelta);
    if (canScrollChain && Math.abs(outerDelta) >= NESTED_SCROLL.WHEEL_MIN_DELTA_PX) {
      this.applyNestedScrollChain(chain, outerDelta, direction);
    }
  }

  private handleNestedTaskListScroll(taskList: HTMLElement): void {
    const now = performance.now();
    const state = this.readNestedScrollState(taskList, now);
    const elapsed = Math.max(1, now - state.lastTime);
    const delta = taskList.scrollTop - state.lastTop;
    state.velocity = this.blendNestedVelocity(state.velocity, delta / elapsed);
    state.lastTop = taskList.scrollTop;
    state.lastTime = now;

    const direction = Math.sign(state.velocity);
    if (direction === 0 || !this.isNestedAtBoundary(taskList, direction)) {
      this.cancelPendingNestedHandoff(state);
      return;
    }

    if (now < this.nestedWheelControlledUntil) {
      this.cancelPendingNestedHandoff(state);
      return;
    }

    if (Math.abs(state.velocity) >= NESTED_SCROLL.MIN_HANDOFF_VELOCITY) {
      this.queueNestedHandoff(taskList, state, direction);
    }
  }

  private readNestedScrollState(taskList: HTMLElement, now: number): NestedScrollState {
    const existing = this.nestedScrollStates.get(taskList);
    if (existing) return existing;

    const state: NestedScrollState = {
      lastTop: taskList.scrollTop,
      lastTime: now,
      velocity: 0,
      handoffTimer: null,
    };
    this.nestedScrollStates.set(taskList, state);
    return state;
  }

  private queueNestedHandoff(taskList: HTMLElement, state: NestedScrollState, direction: number): void {
    if (state.handoffTimer !== null) return;

    const chain = this.resolveNestedScrollChain(taskList);
    if (!chain.some(container => this.canNestedScrollInDirection(container, direction))) return;

    const velocity = this.clampNestedVelocity(state.velocity * NESTED_SCROLL.HANDOFF_VELOCITY_SCALE);
    state.handoffTimer = setTimeout(() => {
      state.handoffTimer = null;
    }, NESTED_SCROLL.HANDOFF_THROTTLE_MS);
    this.startNestedMomentum(chain, velocity);
  }

  private resolveNestedScrollChain(taskList: HTMLElement): HTMLElement[] {
    const chain: HTMLElement[] = [];
    const stageScroller = taskList.closest('[data-stage-scroll-container]');
    if (stageScroller instanceof HTMLElement && this.canNestedScroll(stageScroller)) {
      chain.push(stageScroller);
    }
    if (this.nestedScrollRoot && this.nestedScrollRoot !== stageScroller && this.canNestedScroll(this.nestedScrollRoot)) {
      chain.push(this.nestedScrollRoot);
    }
    return chain;
  }

  private startNestedMomentum(chain: HTMLElement[], initialVelocity: number): void {
    if (!chain.some(container => this.canNestedScrollInDirection(container, Math.sign(initialVelocity)))) return;
    this.cancelNestedMomentum();

    let velocity = this.clampNestedVelocity(initialVelocity);
    const direction = Math.sign(velocity);
    const initialConsumed = this.applyNestedScrollChain(chain, velocity * NESTED_SCROLL.FRAME_MS, direction);
    if (Math.abs(initialConsumed) < NESTED_SCROLL.BOUNDARY_EPSILON) return;

    velocity = this.decayNestedVelocity(velocity, NESTED_SCROLL.FRAME_MS);
    let lastTime = performance.now();
    const startedAt = lastTime;
    const step = (now: number) => {
      const elapsed = Math.max(1, now - lastTime);
      lastTime = now;
      const currentDirection = Math.sign(velocity);
      const ramp = Math.min(1, (now - startedAt) / NESTED_SCROLL.MOMENTUM_RAMP_MS);
      this.applyNestedScrollChain(chain, velocity * elapsed * ramp, currentDirection);
      velocity = this.decayNestedVelocity(velocity, elapsed);

      if (this.shouldStopNestedMomentum(chain, currentDirection, velocity, now - startedAt)) {
        this.nestedMomentumFrameId = null;
        return;
      }

      this.nestedMomentumFrameId = requestAnimationFrame(step);
    };
    this.nestedMomentumFrameId = requestAnimationFrame(step);
  }

  private applyNestedScrollChain(chain: HTMLElement[], delta: number, direction: number): number {
    let remaining = delta;
    let consumedTotal = 0;
    for (const container of chain) {
      const consumed = this.applyNestedScrollElement(container, remaining, direction);
      consumedTotal += consumed;
      remaining -= consumed;
      if (Math.abs(remaining) < NESTED_SCROLL.BOUNDARY_EPSILON) return consumedTotal;
    }
    return consumedTotal;
  }

  private applyNestedScrollElement(container: HTMLElement, delta: number, direction: number): number {
    if (direction === 0 || !this.canNestedScrollInDirection(container, direction)) return 0;
    const before = container.scrollTop;
    container.scrollTop += delta;
    return container.scrollTop - before;
  }

  private shouldStopNestedMomentum(chain: HTMLElement[], direction: number, velocity: number, elapsed: number): boolean {
    return direction === 0 || !chain.some(container => this.canNestedScrollInDirection(container, direction))
      || Math.abs(velocity) < NESTED_SCROLL.MIN_MOMENTUM_VELOCITY || elapsed > NESTED_SCROLL.MOMENTUM_MAX_MS;
  }

  private cancelPendingNestedHandoff(state: NestedScrollState): void {
    if (state.handoffTimer === null) return;
    clearTimeout(state.handoffTimer);
    state.handoffTimer = null;
  }

  private cancelNestedMomentum(): void {
    if (this.nestedMomentumFrameId === null) return;
    cancelAnimationFrame(this.nestedMomentumFrameId);
    this.nestedMomentumFrameId = null;
  }

  private cancelNestedWheelFrame(): void {
    if (this.nestedWheelFrameId !== null) {
      cancelAnimationFrame(this.nestedWheelFrameId);
      this.nestedWheelFrameId = null;
    }
    this.pendingNestedWheel = null;
  }

  private canNestedScroll(container: HTMLElement): boolean {
    return container.scrollHeight - container.clientHeight > NESTED_SCROLL.BOUNDARY_EPSILON;
  }

  private canNestedScrollInDirection(container: HTMLElement, direction: number): boolean {
    if (direction < 0) return container.scrollTop > NESTED_SCROLL.BOUNDARY_EPSILON;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    return container.scrollTop < maxScrollTop - NESTED_SCROLL.BOUNDARY_EPSILON;
  }

  private isNestedAtBoundary(container: HTMLElement, direction: number): boolean {
    return !this.canNestedScrollInDirection(container, direction);
  }

  private shouldIgnoreNestedWheel(event: WheelEvent): boolean {
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      return true;
    }

    return this.eventPathContains(event, node => this.isInteractiveNode(node));
  }

  private normalizeNestedWheelDelta(event: WheelEvent, taskList: HTMLElement): number {
    let delta = event.deltaY;
    if (event.deltaMode === NESTED_SCROLL.WHEEL_DELTA_LINE_MODE) {
      delta *= NESTED_SCROLL.WHEEL_LINE_HEIGHT_PX;
    } else if (event.deltaMode === NESTED_SCROLL.WHEEL_DELTA_PAGE_MODE) {
      delta *= taskList.clientHeight;
    }

    return Math.max(-NESTED_SCROLL.WHEEL_MAX_DELTA_PX, Math.min(NESTED_SCROLL.WHEEL_MAX_DELTA_PX, delta));
  }

  private clampNestedOuterWheelDelta(delta: number): number {
    const maxStep = NESTED_SCROLL.WHEEL_MAX_OUTER_STEP_PX;
    return Math.max(-maxStep, Math.min(maxStep, delta));
  }

  private blendNestedVelocity(previous: number, next: number): number {
    return previous * 0.35 + next * 0.65;
  }

  private decayNestedVelocity(velocity: number, elapsed: number): number {
    return velocity * Math.pow(NESTED_SCROLL.DECAY_PER_FRAME, elapsed / NESTED_SCROLL.FRAME_MS);
  }

  private clampNestedVelocity(velocity: number): number {
    return Math.max(-NESTED_SCROLL.MAX_MOMENTUM_VELOCITY, Math.min(NESTED_SCROLL.MAX_MOMENTUM_VELOCITY, velocity));
  }

  private isInteractiveNode(node: EventTarget): boolean {
    return isInteractiveSelectionTarget(node);
  }

  private eventPathContains(event: Event, predicate: (node: EventTarget) => boolean): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.some(predicate);
  }
}
