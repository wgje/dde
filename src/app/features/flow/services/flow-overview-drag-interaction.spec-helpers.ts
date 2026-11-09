import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import type { FlowOverviewService } from './flow-overview.service';

export interface FlowOverviewDragInteractionSpecContext {
  getService(): FlowOverviewService;
  getContainer(): HTMLDivElement;
  getDiagramPosition(): InstanceType<typeof go.Point>;
  setDiagramPosition(position: InstanceType<typeof go.Point>): void;
  setObservedViewportPosition(position: InstanceType<typeof go.Point>): void;
  setDocumentBounds(bounds: InstanceType<typeof go.Rect>): void;
  getViewportListener(): (() => void) | null;
  getDocumentBoundsListener(): (() => void) | null;
  setDelayViewportCommit(delayed: boolean): void;
  commitObservedViewportPosition(): void;
  dispatchPointer(type: string, clientX: number, clientY: number): void;
  dispatchMouse(target: EventTarget, type: string, clientX: number, clientY: number): void;
  expectCenteredBoundsToContainViewport(bounds: InstanceType<typeof go.Rect>, x: number, y: number): void;
}

export function registerFlowOverviewDragInteractionSpecs(
  context: FlowOverviewDragInteractionSpecContext,
): void {
  let service: FlowOverviewService;
  let container: HTMLDivElement;
  const dispatchPointer = context.dispatchPointer;

  beforeEach(() => {
    service = context.getService();
    container = context.getContainer();
  });

  describe('drag interaction regressions', () => {
    it('实际拖动松手后不应重居中 overview 内容，避免远距离拖动回弹', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();
      const callsBeforeRelease = overview.centerRect.mock.calls.length;

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsBeforeRelease);
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
    });

    it('pointerup 后的 lostpointercapture 不应触发额外重居中', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();
      const callsBeforeRelease = overview.centerRect.mock.calls.length;

      dispatchPointer('pointerup', 120, 90);
      dispatchPointer('lostpointercapture', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsBeforeRelease);
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
    });

    it('observed viewport 延迟追上前不应用 stale viewport 重居中', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 80, 60);
      vi.runOnlyPendingTimers();

      context.setDelayViewportCommit(true);
      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      const callsAfterRelease = overview.centerRect.mock.calls.length;

      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBeGreaterThanOrEqual(callsAfterRelease);

      context.setDelayViewportCommit(false);
      context.commitObservedViewportPosition();
      vi.runOnlyPendingTimers();

      const callsAfterCaughtUp = overview.centerRect.mock.calls.length;
      expect(callsAfterCaughtUp).toBe(callsAfterRelease);

      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsAfterCaughtUp);

      const nextPosition = new go.Point(
        context.getDiagramPosition().x + 40,
        context.getDiagramPosition().y + 30,
      );
      context.setDiagramPosition(nextPosition);
      context.setObservedViewportPosition(nextPosition.copy());
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      if (overview.centerRect.mock.calls.length > callsAfterCaughtUp) {
        const followUpCall = overview.centerRect.mock.calls.at(-1)?.[0] as InstanceType<typeof go.Rect>;
        context.expectCenteredBoundsToContainViewport(
          followUpCall,
          context.getDiagramPosition().x,
          context.getDiagramPosition().y,
        );
      }
    });

    it('点击小地图预览框但不移动时不应改变主视图位置', () => {
      const overview = service.overviewInstance as unknown as {
        box: { position: InstanceType<typeof go.Point> };
        centerRect: ReturnType<typeof vi.fn>;
        fixedBounds: InstanceType<typeof go.Rect> | undefined;
        scale: number;
      };
      const serviceInternals = service as unknown as {
        overviewReleaseShouldAnchor: boolean;
        overviewReleaseViewportBounds: InstanceType<typeof go.Rect> | null;
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

      const centerCallsBeforeClick = overview.centerRect.mock.calls.length;
      const scaleBeforeClick = overview.scale;

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 20, 20);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(0);
      expect(context.getDiagramPosition().y).toBe(0);
      expect(overview.scale).toBe(scaleBeforeClick);
      expect(fixedBoundsWriteCount).toBe(0);
      expect(overview.centerRect.mock.calls.length).toBe(centerCallsBeforeClick);
      expect(serviceInternals.overviewReleaseViewportBounds).toBeNull();
      expect(serviceInternals.overviewReleaseShouldAnchor).toBe(false);

      const remotePosition = new go.Point(1400, 1000);
      context.setDiagramPosition(remotePosition);
      context.setObservedViewportPosition(remotePosition.copy());
      overview.centerRect.mockClear();
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(1400);
      expect(context.getDiagramPosition().y).toBe(1000);
      expect(overview.centerRect).not.toHaveBeenCalled();
      expect(overview.box.position.x).toBe(1400);
      expect(overview.box.position.y).toBe(1000);
    });

    it('实际拖动松手后的同位置异步刷新不应再次重居中', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
        fixedBounds: InstanceType<typeof go.Rect> | undefined;
        scale: number;
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
      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();

      const callsAfterRelease = overview.centerRect.mock.calls.length;
      const releaseX = context.getDiagramPosition().x;
      const releaseY = context.getDiagramPosition().y;
      const fixedBoundsWritesAfterRelease = fixedBoundsWriteCount;
      const scaleAfterRelease = overview.scale;

      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBeGreaterThanOrEqual(callsAfterRelease);
      expect(fixedBoundsWriteCount).toBe(fixedBoundsWritesAfterRelease);
      expect(overview.scale).toBe(scaleAfterRelease);

      const fixedBoundsWritesAfterFrozenViewport = fixedBoundsWriteCount;
      context.setDocumentBounds(new go.Rect(-1200, -900, 3600, 2800));
      context.getDocumentBoundsListener()?.();
      vi.runOnlyPendingTimers();

      expect(fixedBoundsWriteCount).toBeGreaterThan(fixedBoundsWritesAfterFrozenViewport);
      const callsAfterDocumentBoundsChange = overview.centerRect.mock.calls.length;

      const nextPosition = new go.Point(releaseX + 60, releaseY + 40);
      context.setDiagramPosition(nextPosition);
      context.setObservedViewportPosition(nextPosition.copy());
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsAfterDocumentBoundsChange);
    });

    it('viewport 在节点群内点击不动并回放后续刷新时，预览框始终以 viewport 为锚（消除根因型跳变）', () => {
      // 【2026-05-09 根因回归】用户报告：viewport 落在节点群内时点击预览框，
      // - 点击瞬间预览框居中（apply 走 manual/centerRect viewportBounds 分支）→ 正确
      // - 松手 + 后续 ViewportBoundsChanged 重绘 → 旧逻辑 usingManualViewportBounds=false
      //   且 isViewportOutside=false，跳过 centerRect，落到 contentAlignment: Spot.Center
      //   把 worldBounds=nodeBounds∪vb 的几何中心对准容器中心，与 viewportBounds.center
      //   错位 → 预览框相对容器跳到不同位置，缩略块和主视图脱节。
      // 修复后：apply 路径无条件 centerRect(viewportBounds)，contentAlignment 也已移除，
      // 后续刷新仍以 viewport 中心为锚，无跳变。
      context.setDocumentBounds(new go.Rect(-2000, -2000, 5000, 4000)); // 节点群远大于 viewport，确保 viewport 处于节点群内
      context.getViewportListener()?.(); // 让服务感知 documentBounds 变化
      vi.runOnlyPendingTimers();

      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      // 不移动，直接松手
      dispatchPointer('pointerup', 20, 20);
      vi.runOnlyPendingTimers();

      const callsAfterRelease = overview.centerRect.mock.calls.length;

      // 模拟松手后第二帧的 ViewportBoundsChanged（GoJS 渲染过程中可能再触发一次）
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBeGreaterThanOrEqual(callsAfterRelease);
      // 主视图位置也未受影响。
      expect(context.getDiagramPosition().x).toBe(0);
      expect(context.getDiagramPosition().y).toBe(0);
    });

    it('should intercept default pointerup without release-time re-centering', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };
      const bubblePointerUp = vi.fn();
      container.addEventListener('pointerup', bubblePointerUp);

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const callsBeforeRelease = overview.centerRect.mock.calls.length;

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(bubblePointerUp).not.toHaveBeenCalled();
      expect(overview.centerRect.mock.calls.length).toBe(callsBeforeRelease);
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
    });

    it('should apply pointerup coordinates when the final pointermove is missing', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const callsBeforeRelease = overview.centerRect.mock.calls.length;

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.centerRect.mock.calls.length).toBe(callsBeforeRelease);
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
    });

    it('支持 Pointer Events 时不应再响应兼容 mouse 拖拽事件', () => {
      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();

      context.dispatchMouse(container, 'mousedown', 20, 20);
      context.dispatchMouse(window, 'mousemove', 120, 90);
      context.dispatchMouse(window, 'mouseup', 120, 90);
      vi.runOnlyPendingTimers();

      expect(context.getDiagramPosition().x).toBe(0);
      expect(context.getDiagramPosition().y).toBe(0);

      dispatchPointer('pointerup', 20, 20);
      vi.runOnlyPendingTimers();
    });

    it('拖拽移动时应把 Overview 重绘合并到调度帧，而不是同步重绘', () => {
      const overview = service.overviewInstance as unknown as {
        requestUpdate: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const callsBeforeMove = overview.requestUpdate.mock.calls.length;

      dispatchPointer('pointermove', 120, 90);
      expect(overview.requestUpdate.mock.calls.length).toBe(callsBeforeMove);

      vi.runOnlyPendingTimers();

      expect(overview.requestUpdate.mock.calls.length).toBeGreaterThan(callsBeforeMove);
    });

    it('【回归保护】小地图拖拽帧只应通过统一 overview 更新路径重绘一次', () => {
      const overview = service.overviewInstance as unknown as {
        requestUpdate: ReturnType<typeof vi.fn>;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.requestUpdate.mockClear();

      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      expect(overview.requestUpdate.mock.calls.length).toBe(1);
    });

    it('远距离拖拽后松手只允许补一帧平滑 scale，不应回弹或突变', () => {
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();

      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();
      const scaleAfterMove = overview.scale;

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();

      expect(overview.scale).toBeLessThanOrEqual(scaleAfterMove);
      expect(scaleAfterMove - overview.scale).toBeLessThanOrEqual(scaleAfterMove * 0.12 + 1e-6);
    });

    it('远距离拖拽释放后再次点击不移动不应继续推进 scale', () => {
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();

      const scaleAfterFarRelease = overview.scale;
      const centerCallsAfterFarRelease = overview.centerRect.mock.calls.length;

      dispatchPointer('pointerdown', 500, 400);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();

      expect(overview.scale).toBe(scaleAfterFarRelease);
      expect(overview.centerRect.mock.calls.length).toBe(centerCallsAfterFarRelease);
    });

    it('拖回节点群并发生真实位移时，小地图应从缩小 scale 恢复放大', () => {
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.scale = 0.08;
      const scaleAfterFarShrink = overview.scale;

      dispatchPointer('pointermove', 30, 30);
      vi.runOnlyPendingTimers();

      expect(overview.scale).toBeGreaterThan(scaleAfterFarShrink);
      expect(overview.scale - scaleAfterFarShrink).toBeLessThanOrEqual(scaleAfterFarShrink * 0.12 + 1e-6);

      dispatchPointer('pointerup', 30, 30);
      vi.runOnlyPendingTimers();
    });

    it('【回归保护】远近拖动导致预览框缩小时，scale 单帧变化必须保持平滑', () => {
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.scale = 0.24;
      const scaleBeforeFarDrag = overview.scale;

      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();

      expect(overview.scale).toBeLessThan(scaleBeforeFarDrag);
      expect(scaleBeforeFarDrag - overview.scale).toBeLessThanOrEqual(scaleBeforeFarDrag * 0.12 + 1e-6);

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();
    });

    it('【回归保护】低 scale 下远近拖动也不能使用固定大步长突变', () => {
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.scale = 0.03;
      const scaleBeforeFarDrag = overview.scale;

      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();

      expect(scaleBeforeFarDrag - overview.scale).toBeLessThanOrEqual(scaleBeforeFarDrag * 0.12 + 1e-6);

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();
    });

    it('【回归保护】scale 接近目标时必须单调收敛，不能越过目标反向抖动', () => {
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.scale = 0.101;

      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();
      const scaleAfterFirstMove = overview.scale;

      dispatchPointer('pointermove', 500, 400);
      vi.runOnlyPendingTimers();

      expect(scaleAfterFirstMove).toBeGreaterThanOrEqual(overview.scale);
      expect(overview.scale).toBeGreaterThan(0.08);

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();
    });

    it('【回归保护】最终 pointerup 坐标也必须在重置前补一帧平滑 scale', () => {
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      overview.scale = 0.24;
      const scaleBeforeRelease = overview.scale;

      dispatchPointer('pointerup', 500, 400);
      vi.runOnlyPendingTimers();

      expect(overview.scale).toBeLessThan(scaleBeforeRelease);
      expect(scaleBeforeRelease - overview.scale).toBeLessThanOrEqual(scaleBeforeRelease * 0.12 + 1e-6);
    });

    it('松开后位置不受拖拽中途 overview.scale 变化影响（稳定 view→doc 映射）', () => {
      // 【2026-05-09 根因回归】拖拽过程中如果 transformViewToDoc 依赖的
      // overview.scale 变化（applyOverviewUpdate 通过 smartLerp 修改 scale），
      // 会让同一 client 坐标在不同帧映射到不同 doc 点，松手时累计漂移。
      // 本用例显式在 pointermove 之间修改 overview.scale，验证最终
      // diagram.position 仍只与 (起始点 → 释放点) 的 client 位移成比例。
      const overview = service.overviewInstance as unknown as {
        centerRect: ReturnType<typeof vi.fn>;
        scale: number;
        transformViewToDoc: (point: InstanceType<typeof go.Point>) => InstanceType<typeof go.Point>;
      };
      // 让 transformViewToDoc 反映 scale（更接近真实 GoJS 行为）：
      // doc = viewPt / overview.scale（假设 overview.position=0）。
      overview.transformViewToDoc = (point) =>
        new go.Point(point.x / overview.scale, point.y / overview.scale);
      overview.scale = 1;

      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const positionBeforeMove = context.getDiagramPosition().copy();

      dispatchPointer('pointermove', 80, 60);
      vi.runOnlyPendingTimers();

      // 在中途模拟 applyOverviewUpdate 修改 overview.scale —— 在出现该修复前，
      // 这会让后续帧 transformViewToDoc 给出不同的 doc 坐标，导致松手位置漂移。
      overview.scale = 0.5;

      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();

      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      // 起始中心来自主图 viewportBounds.center (400, 300)，view 映射因子=1。
      // client 位移 (100, 70) → viewport center 推到 (500, 370)，
      // viewport 大小 800x600 → diagram.position = (100, 70)。
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
      expect(context.getDiagramPosition().x).not.toBe(positionBeforeMove.x);

      // 松手帧不再主动重居中；主视图位置仍必须由最后一次指针坐标决定，避免缩放变化造成漂移。
      const callsAfterRelease = overview.centerRect.mock.calls.length;
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();
      expect(overview.centerRect.mock.calls.length).toBeGreaterThanOrEqual(callsAfterRelease);
    });

    it('【根因回归 2026-05-11】press → release（不移动）后 overview.scale 必须严格保持稳定（消除 smartLerp 残差跳动）', () => {
      // 真正的根因：旧实现在 applyOverviewUpdate 中无条件用 smartLerp（18%/45%）
      // 推进 overview.scale 向 target 收敛。终止条件 `|target - current| > 0.002`
      // 意味着 idle 状态 scale 长期停在"接近但不等于 target"的位置。
      //   - press 触发一次 apply → smartLerp 推进一小步 → scale 变化 1 次。
      //   - release 触发一次 apply → smartLerp 再推进一小步 → scale 变化 2 次。
      //   - 每次 scale 变化都让节点位置 `(loc - position) * scale` 重新映射到不同
      //     canvas 像素 → 视觉上即"缩略块跃动且与主视图脱节"。
      // 修复后：仅当 box 正被实际拖拽（hasManualBoxMovement）才走 smartLerp，
      // press/release 不动场景一律 snap 到 target，apply 对稳定输入严格幂等。
      const overview = service.overviewInstance as unknown as {
        scale: number;
      };

      // 模拟真实使用场景：用户已经看过流程图，scale 已收敛到 target。
      // 这里通过先回放一次 ViewportBoundsChanged 让 idle apply 把 scale snap 到 target。
      context.getViewportListener()?.();
      vi.runOnlyPendingTimers();
      const scaleAfterIdle = overview.scale;

      // press 不动
      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      const scaleAfterPress = overview.scale;

      // release 不动
      dispatchPointer('pointerup', 20, 20);
      vi.runOnlyPendingTimers();
      const scaleAfterRelease = overview.scale;

      // 关键断言：稳定输入 ⇒ 稳定 scale ⇒ 缩略块无跃动。
      // 严格相等（snap 实现保证完全幂等，而非"近似相等"）。
      expect(scaleAfterPress).toBe(scaleAfterIdle);
      expect(scaleAfterRelease).toBe(scaleAfterIdle);

      // 主视图位置同样不应变化。
      expect(context.getDiagramPosition().x).toBe(0);
      expect(context.getDiagramPosition().y).toBe(0);
    });

    it('【回归保护】实际拖拽 box（press → move → release）仍能正常驱动主视图位置变化', () => {
      // 修复 smartLerp 残差不应破坏真实拖拽行为：当用户产生实际位移时，
      // hasManualBoxMovement=true，smartLerp 平滑动画照常生效，diagram.position
      // 按 client 位移成比例更新。
      dispatchPointer('pointerdown', 20, 20);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointermove', 120, 90);
      vi.runOnlyPendingTimers();
      dispatchPointer('pointerup', 120, 90);
      vi.runOnlyPendingTimers();

      // client 位移 (100, 70) 应反映到 diagram.position（mock 中 view→doc 因子=1）。
      expect(context.getDiagramPosition().x).toBe(100);
      expect(context.getDiagramPosition().y).toBe(70);
    });
  });
}
