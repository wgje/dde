import {
  cancelMinimapFrame,
  requestMinimapFrame,
  type MinimapFrameHandle,
} from './flow-minimap-geometry';

export interface MinimapAttentionPoint {
  /** 归一化横坐标，范围 0..1。 */
  x: number;
  /** 归一化纵坐标，范围 0..1。 */
  y: number;
}

export interface MinimapAttentionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function projectMinimapAttentionPoint(
  clientX: number,
  clientY: number,
  rect: MinimapAttentionRect,
): MinimapAttentionPoint | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return {
    x: clamp((clientX - rect.left) / rect.width),
    y: clamp((clientY - rect.top) / rect.height),
  };
}

interface FlowMinimapAttentionControllerOptions {
  activationDelayMs?: number;
  requestFrame?: (callback: FrameRequestCallback) => MinimapFrameHandle;
  cancelFrame?: (handle: MinimapFrameHandle) => void;
  scheduleTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  setLens: (point: MinimapAttentionPoint | null) => void;
  setActive: (active: boolean) => void;
  setLegendVisible: (visible: boolean) => void;
}

/**
 * 小地图注意力状态机。
 *
 * 高频指针坐标在一帧内只提交最后一个值；图例在持续有效交互后延迟浮现。
 * 控制器不读取节点/连线快照，因此镜头移动不会触发快照重建。
 */
export class FlowMinimapAttentionController {
  private readonly activationDelayMs: number;
  private readonly requestFrame: (callback: FrameRequestCallback) => MinimapFrameHandle;
  private readonly cancelFrame: (handle: MinimapFrameHandle) => void;
  private readonly scheduleTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private lensFrame: MinimapFrameHandle | null = null;
  private lensFrameToken: object | null = null;
  private activationTimer: ReturnType<typeof setTimeout> | null = null;
  private activationTimerToken: object | null = null;
  private pendingLens: MinimapAttentionPoint | null = null;
  private pointerInside = false;
  private focusInside = false;
  private legendPinned = false;
  private active = false;
  private legendVisible = false;
  private destroyed = false;

  constructor(private readonly options: FlowMinimapAttentionControllerOptions) {
    this.activationDelayMs = options.activationDelayMs ?? 240;
    this.requestFrame = options.requestFrame ?? requestMinimapFrame;
    this.cancelFrame = options.cancelFrame ?? cancelMinimapFrame;
    this.scheduleTimer = options.scheduleTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));
  }

  pointerEntered(): void {
    if (this.destroyed) return;
    this.pointerInside = true;
    this.activate();
  }

  pointerMoved(point: MinimapAttentionPoint): void {
    if (this.destroyed) return;
    this.pointerInside = true;
    this.activate();
    this.queueLens(point);
  }

  private queueLens(point: MinimapAttentionPoint): void {
    this.pendingLens = point;
    if (this.lensFrame !== null) return;
    const token = {};
    this.lensFrameToken = token;
    this.lensFrame = this.requestFrame(() => {
      if (this.destroyed || this.lensFrameToken !== token) return;
      this.lensFrameToken = null;
      this.lensFrame = null;
      if (!this.pendingLens) return;
      const latest = this.pendingLens;
      this.pendingLens = null;
      this.options.setLens(latest);
    });
  }

  pointerLeft(): void {
    if (this.destroyed) return;
    this.pointerInside = false;
    this.settleIfIdle();
  }

  focused(): void {
    if (this.destroyed) return;
    this.focusInside = true;
    this.activate();
  }

  blurred(): void {
    if (this.destroyed) return;
    this.focusInside = false;
    this.settleIfIdle();
  }

  interacted(point?: MinimapAttentionPoint): void {
    if (this.destroyed) return;
    this.activate();
    if (point) this.queueLens(point);
  }

  setLegendPinned(pinned: boolean): void {
    if (this.destroyed || this.legendPinned === pinned) return;
    this.legendPinned = pinned;
    if (pinned) {
      this.cancelActivationTimer();
      this.writeActive(true);
      this.writeLegendVisible(true);
      return;
    }
    this.settleIfIdle();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelActivationTimer();
    this.lensFrameToken = null;
    if (this.lensFrame !== null) {
      this.cancelFrame(this.lensFrame);
      this.lensFrame = null;
    }
    this.pendingLens = null;
  }

  private activate(): void {
    if (this.legendVisible || this.activationTimer !== null || this.legendPinned) return;
    const token = {};
    this.activationTimerToken = token;
    this.activationTimer = this.scheduleTimer(() => {
      if (this.destroyed || this.activationTimerToken !== token) return;
      this.activationTimerToken = null;
      this.activationTimer = null;
      if (!this.pointerInside && !this.focusInside && !this.legendPinned) return;
      this.writeActive(true);
      this.writeLegendVisible(true);
    }, this.activationDelayMs);
  }

  private settleIfIdle(): void {
    if (this.pointerInside || this.focusInside || this.legendPinned) return;
    this.cancelActivationTimer();
    this.lensFrameToken = null;
    if (this.lensFrame !== null) {
      this.cancelFrame(this.lensFrame);
      this.lensFrame = null;
    }
    this.pendingLens = null;
    this.writeActive(false);
    this.writeLegendVisible(false);
    this.options.setLens(null);
  }

  private cancelActivationTimer(): void {
    this.activationTimerToken = null;
    if (this.activationTimer === null) return;
    this.clearTimer(this.activationTimer);
    this.activationTimer = null;
  }

  private writeActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.options.setActive(active);
  }

  private writeLegendVisible(visible: boolean): void {
    if (this.legendVisible === visible) return;
    this.legendVisible = visible;
    this.options.setLegendVisible(visible);
  }
}
