import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import type { FlowOverviewService } from './flow-overview.service';

export interface FlowOverviewPerformanceInteractionSpecContext {
  getService(): FlowOverviewService;
  getContainer(): HTMLDivElement;
  getDiagramPosition(): InstanceType<typeof go.Point>;
  getDiagramRequestUpdate(): ReturnType<typeof vi.fn>;
  getDiagramPositionWriteCount(): number;
  setDiagramPositionClamp(
    clamp: ((position: InstanceType<typeof go.Point>) => InstanceType<typeof go.Point>) | null,
  ): void;
  getViewportListener(): (() => void) | null;
  getDocumentBoundsListener(): (() => void) | null;
  setDocumentBounds(bounds: InstanceType<typeof go.Rect>): void;
  dispatchPointer(type: string, clientX: number, clientY: number): void;
}

export function registerFlowOverviewPerformanceInteractionSpecs(
  context: FlowOverviewPerformanceInteractionSpecContext,
): void {
  let service: FlowOverviewService;
  let container: HTMLDivElement;
  const dispatchPointer = context.dispatchPointer;

  beforeEach(() => {
    service = context.getService();
    container = context.getContainer();
  });

  describe('performance interaction regressions', () => {
    it('【2026-05-15 性能修复 P4】拖拽时 pointermove 必须 rAF 合流：同一帧内多次 pointermove 不同步写主图，且只保留最后一次坐标', () => {
      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const positionBeforeMove = context.getDiagramPosition().copy();

      // 同一帧（fake timers 未运行）内连续三次 pointermove
      dispatchPointer('pointermove', 30, 30);
      dispatchPointer('pointermove', 60, 50);
      dispatchPointer('pointermove', 100, 80);

      // rAF 尚未 flush：position 不应被同步写入（消除每个 pointermove 的同步主图重绘）
      expect(context.getDiagramPosition().x).toBe(positionBeforeMove.x);
      expect(context.getDiagramPosition().y).toBe(positionBeforeMove.y);

      // 推进 rAF：3 次 pointermove 应合流为一次 apply，diagramPosition 直接跳到最后一次坐标
      // （client 位移 100-20=80, 80-20=60，view→doc factor=1）
      vi.runOnlyPendingTimers();
      expect(context.getDiagramPosition().x).toBe(80);
      expect(context.getDiagramPosition().y).toBe(60);

      dispatchPointer('pointerup', 100, 80);
      vi.runOnlyPendingTimers();
    });

    it('【性能修复】拖拽帧直接移动 overview.box，且不强制 requestUpdate 主图', () => {
      const overview = service.overviewInstance as unknown as {
        box: { position: InstanceType<typeof go.Point> };
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      context.getDiagramRequestUpdate().mockClear();

      dispatchPointer('pointermove', 120, 90);
      expect(context.getDiagramPosition().x).toBe(0);
      expect(context.getDiagramPosition().y).toBe(0);

      vi.runOnlyPendingTimers();

      expect(overview.box.position.x).toBe(100);
      expect(overview.box.position.y).toBe(70);
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
      expect(context.getDiagramRequestUpdate()).not.toHaveBeenCalled();

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();
    });

    it('【性能修复】拖拽遇到位置约束时白框跟随实际视口，避免回弹残影', () => {
      const overview = service.overviewInstance as unknown as {
        box: { position: InstanceType<typeof go.Point> };
      };
      context.setDiagramPositionClamp(position => new go.Point(
        Math.min(position.x, 40),
        Math.min(position.y, 30),
      ));

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      context.getDiagramRequestUpdate().mockClear();

      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(40);
      expect(context.getDiagramPosition().y).toBe(30);
      expect(overview.box.position.x).toBe(40);
      expect(overview.box.position.y).toBe(30);
      expect(context.getDiagramRequestUpdate()).not.toHaveBeenCalled();

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();
    });

    it('【回归保护】预览框拖到边缘后继续外拖不应排入被拒绝位移的刷新导致抖动', () => {
      const overview = service.overviewInstance as unknown as {
        box: { position: InstanceType<typeof go.Point> };
        requestUpdate: ReturnType<typeof vi.fn>;
        updateAllTargetBindings: ReturnType<typeof vi.fn>;
      };
      context.setDiagramPositionClamp(position => new go.Point(
        Math.min(position.x, 40),
        Math.min(position.y, 30),
      ));

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(40);
      expect(context.getDiagramPosition().y).toBe(30);
      expect(overview.box.position.x).toBe(40);
      expect(overview.box.position.y).toBe(30);

      overview.requestUpdate.mockClear();
      overview.updateAllTargetBindings.mockClear();
      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();

      const writesAfterRejectedEdge = context.getDiagramPositionWriteCount();
      dispatchPointer('pointermove', 700, 520);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPositionWriteCount()).toBe(writesAfterRejectedEdge);
      expect(context.getDiagramPosition().x).toBe(40);
      expect(context.getDiagramPosition().y).toBe(30);
      expect(overview.box.position.x).toBe(40);
      expect(overview.box.position.y).toBe(30);
      expect(overview.requestUpdate).not.toHaveBeenCalled();
      expect(overview.updateAllTargetBindings).not.toHaveBeenCalled();

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();
    });

    it('【回归保护】小地图真实拖拽释放不应强制重刷缩略任务块绑定造成残影', () => {
      const overview = service.overviewInstance as unknown as {
        updateAllTargetBindings: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      overview.updateAllTargetBindings.mockClear();
      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.updateAllTargetBindings).not.toHaveBeenCalled();
    });

    it('【回归保护】小地图真实拖拽释放不应追加第二帧 overview 重绘造成残影', () => {
      const overview = service.overviewInstance as unknown as {
        requestUpdate: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      overview.requestUpdate.mockClear();
      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.requestUpdate.mock.calls.length).toBe(1);
    });

    it('【性能修复】边界阻挡后的 pointerup 不应把真实拖拽误判为点击不动', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };
      context.setDiagramPositionClamp(position => new go.Point(
        Math.min(position.x, 40),
        Math.min(position.y, 30),
      ));

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 80, 60);
      vi.runOnlyPendingTimers();
      const callsBeforeBlockedRelease = overview.centerRect.mock.calls.length;

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(40);
      expect(context.getDiagramPosition().y).toBe(30);
      expect(overview.centerRect.mock.calls.length).toBe(callsBeforeBlockedRelease);
    });

    it('【性能修复】完全被边界阻挡时不应把未接受位移误判为真实拖拽', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
        scale: number;
      };
      context.setDiagramPositionClamp(() => context.getDiagramPosition().copy());

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.scale = 0.08;
      const scaleBeforeBlockedMove = overview.scale;

      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(0);
      expect(context.getDiagramPosition().y).toBe(0);
      expect(overview.scale).toBe(scaleBeforeBlockedMove);
    });
    it('【性能修复】拖拽过程中不重居中 overview 内容，让预览框可以贴近边缘', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const callsAfterPress = overview.centerRect.mock.calls.length;

      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsAfterPress);

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsAfterPress);
    });

    it('【性能修复】拖拽停留在稳定边界内时不重算 fixedBounds，避免缩略任务块抽搐', () => {
      const overview = service.overviewInstance as unknown as {
        fixedBounds: InstanceType<typeof go.Rect> | undefined;
        updateAllTargetBindings: ReturnType<typeof vi.fn>;
      };
      let fixedBoundsWriteCount = 0;
      let stored: InstanceType<typeof go.Rect> | undefined = overview.fixedBounds;
      Object.defineProperty(overview, 'fixedBounds', {
        configurable: true,
        get(): InstanceType<typeof go.Rect> | undefined {
          return stored;
        },
        set(value: InstanceType<typeof go.Rect> | undefined) {
          fixedBoundsWriteCount += 1;
          stored = value;
        },
      });

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();

      dispatchPointer('pointermove', 80, 60);
      vi.runOnlyPendingTimers();
      const fixedBoundsWritesAfterStableMove = fixedBoundsWriteCount;
      const bindingCallsAfterStableMove = overview.updateAllTargetBindings.mock.calls.length;

      dispatchPointer('pointermove', 90, 65);
      vi.runOnlyPendingTimers();

      expect(fixedBoundsWriteCount).toBe(fixedBoundsWritesAfterStableMove);
      expect(overview.updateAllTargetBindings.mock.calls.length).toBe(bindingCallsAfterStableMove);

      dispatchPointer('pointerup', 90, 65);
      vi.runOnlyPendingTimers();
    });

    it('【性能修复】拖拽期间必须复用 overview 容器 rect，避免每次 pointermove 触发布局读', () => {
      const rectSpy = vi.fn(() => ({
        left: 0,
        top: 0,
        right: 180,
        bottom: 140,
        width: 180,
        height: 140,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect));
      Object.defineProperty(container, 'getBoundingClientRect', {
        configurable: true,
        value: rectSpy,
      });

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const callsAfterDragStart = rectSpy.mock.calls.length;

      dispatchPointer('pointermove', 30, 30);
      dispatchPointer('pointermove', 60, 50);
      dispatchPointer('pointermove', 100, 80);

      expect(rectSpy.mock.calls.length).toBe(callsAfterDragStart);

      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 100, 80);
      vi.runOnlyPendingTimers();

      const callsAfterRelease = rectSpy.mock.calls.length;
      dispatchPointer('pointerdown', 20, 20);

      expect(rectSpy.mock.calls.length).toBeGreaterThan(callsAfterRelease);
    });

    it('【2026-05-15 性能修复 P5】拖拽期间 updateAllTargetBindings 必须经过 16ms 节流（不再每帧调用）', () => {
      const overview = service.overviewInstance as unknown as {
        updateAllTargetBindings: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const baseline = overview.updateAllTargetBindings.mock.calls.length;

      // 在 16ms 节流窗口内触发多次 pointermove + rAF flush
      for (let i = 0; i < 5; i += 1) {
        dispatchPointer('pointermove', 30 + i * 10, 30 + i * 10);
        vi.runOnlyPendingTimers(); // rAF flush + overview schedule
      }

      // 节流路径在 16ms 内最多触发 1 次 updateAllTargetBindings；
      // 这里 fake timer 还没推进 16ms，断言 ≤ 1 次新增。
      const dragCalls = overview.updateAllTargetBindings.mock.calls.length - baseline;
      expect(dragCalls).toBeLessThanOrEqual(1);

      dispatchPointer('pointerup', 100, 100);
      vi.runOnlyPendingTimers();
    });

    it('【性能修复】拖拽开始后应取消旧的 deferred binding 刷新，避免中途卡顿', () => {
      const overview = service.overviewInstance as unknown as {
        updateAllTargetBindings: ReturnType<typeof vi.fn>;
      };
      const serviceInternals = service as unknown as {
        scheduleViewportBindingsUpdate: (mode: 'deferred') => void;
      };

      serviceInternals.scheduleViewportBindingsUpdate('deferred');

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const baseline = overview.updateAllTargetBindings.mock.calls.length;

      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();
      vi.advanceTimersByTime(96);

      expect(overview.updateAllTargetBindings.mock.calls.length).toBe(baseline);

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();
    });

    it('【2026-05-15 性能修复 P6】worldBounds 不变时 setFixedBounds 必须被去重（避免每帧 documentBounds invalidate）', () => {
      const overview = service.overviewInstance as unknown as {
        fixedBounds: InstanceType<typeof go.Rect> | undefined;
      };
      // 包装 fixedBounds 的 setter 以计数
      let fixedBoundsWriteCount = 0;
      let stored: InstanceType<typeof go.Rect> | undefined = overview.fixedBounds;
      Object.defineProperty(overview, 'fixedBounds', {
        configurable: true,
        get(): InstanceType<typeof go.Rect> | undefined {
          return stored;
        },
        set(value: InstanceType<typeof go.Rect> | undefined) {
          fixedBoundsWriteCount += 1;
          stored = value;
        },
      });

      // 触发多次 idle apply（documentBounds 不变）
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();
      const firstWrite = fixedBoundsWriteCount;

      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      // 后续 idle apply 因 worldBoundsKey 命中缓存而跳过 setFixedBounds
      expect(fixedBoundsWriteCount).toBe(firstWrite);

      // documentBounds 真实变化时必须重新写入
      context.setDocumentBounds(new go.Rect(0, 0, 800, 600));
      context.getDocumentBoundsListener()?.();
      vi.runOnlyPendingTimers();
      expect(fixedBoundsWriteCount).toBeGreaterThan(firstWrite);
    });

    it('销毁小地图时必须清空节点拖拽节流状态，避免 root 单例重建后沿用旧交互态', () => {
      const internals = service as unknown as {
        isNodeDragging: boolean;
        hasManualBoxMovement: boolean;
        overviewViewportUpdateScheduler: { interactionLastApplyAt: number };
      };

      service.setNodeDragging(true);
      internals.hasManualBoxMovement = true;
      internals.overviewViewportUpdateScheduler.interactionLastApplyAt = 123;

      service.destroyOverview();

      expect(internals.isNodeDragging).toBe(false);
      expect(internals.hasManualBoxMovement).toBe(false);
      expect(internals.overviewViewportUpdateScheduler.interactionLastApplyAt).toBe(0);
    });
  });
}
