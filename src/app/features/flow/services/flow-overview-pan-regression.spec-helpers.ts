import { expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowOverviewService } from './flow-overview.service';

type GoPoint = InstanceType<typeof go.Point>;
type GoRect = InstanceType<typeof go.Rect>;
type GoSize = InstanceType<typeof go.Size>;

export interface FlowOverviewPanRegressionSpecContext {
  getService: () => FlowOverviewService;
  getDiagramPosition: () => GoPoint;
  setDiagramPosition: (position: GoPoint) => void;
  setObservedViewportPosition: (position: GoPoint) => void;
  setDocumentBounds: (bounds: GoRect) => void;
  getViewportListener: () => (() => void) | null;
  getDocumentBoundsListener: () => (() => void) | null;
  dispatchPointer: (type: string, clientX: number, clientY: number) => void;
}

interface FlowOverviewPanRegressionSpecHelpers {
  runViewportListener: () => void;
  runDocumentBoundsListener: () => void;
  setMainViewport: (x: number, y: number) => void;
}

function createPanRegressionSpecHelpers(
  context: FlowOverviewPanRegressionSpecContext,
): FlowOverviewPanRegressionSpecHelpers {
  return {
    runViewportListener: () => context.getViewportListener()?.(),
    runDocumentBoundsListener: () => context.getDocumentBoundsListener()?.(),
    setMainViewport: (x: number, y: number): void => {
      const position = new go.Point(x, y);
      context.setDiagramPosition(position);
      context.setObservedViewportPosition(position.copy());
    },
  };
}

function trackFixedBoundsWrites(overview: { fixedBounds: GoRect | undefined }) {
  let count = 0;
  let stored: GoRect | undefined = overview.fixedBounds;

  Object.defineProperty(overview, 'fixedBounds', {
    configurable: true,
    get(): GoRect | undefined {
      return stored;
    },
    set(value: GoRect | undefined) {
      count += 1;
      stored = value;
    },
  });

  return {
    get count(): number {
      return count;
    },
    reset(): void {
      count = 0;
    },
  };
}

function registerStableBoundsPassivePanSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】主图在稳定边界内拖动画布时不应重居中小地图底图', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: { position: GoPoint };
      centerRect: ReturnType<typeof vi.fn>;
      fixedBounds: GoRect | undefined;
      requestUpdate: ReturnType<typeof vi.fn>;
    };
    const fixedBoundsWrites = trackFixedBoundsWrites(overview);

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();
    overview.centerRect.mockClear();
    overview.requestUpdate.mockClear();
    fixedBoundsWrites.reset();

    helpers.setMainViewport(20, 20);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(fixedBoundsWrites.count).toBe(0);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.requestUpdate).not.toHaveBeenCalled();
    expect(overview.box.position.x).toBe(20);
    expect(overview.box.position.y).toBe(20);
  });
}

function registerImmediateOverviewDragSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】主图拖动后立刻拖小地图预览框，起点必须使用当前 viewport 不瞬移', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: { position: GoPoint };
      centerRect: ReturnType<typeof vi.fn>;
      updateDelay: number;
    };

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();
    overview.centerRect.mockClear();

    helpers.setMainViewport(120, 90);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(overview.updateDelay).toBe(0);
    expect(overview.box.position.x).toBe(120);
    expect(overview.box.position.y).toBe(90);

    context.dispatchPointer('pointerdown', 140, 110);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointermove', 160, 130);
    vi.runOnlyPendingTimers();

    expect(context.getDiagramPosition().x).toBe(140);
    expect(context.getDiagramPosition().y).toBe(110);
    expect(overview.centerRect).not.toHaveBeenCalled();

    context.dispatchPointer('pointerup', 160, 130);
    vi.runOnlyPendingTimers();
  });
}

function registerReleasedDragGhostRefreshSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】小地图拖拽释放后的旧刷新不应在主图拖动时重绘缩略任务块残影', () => {
    const overview = context.getService().overviewInstance as unknown as {
      updateAllTargetBindings: ReturnType<typeof vi.fn>;
    };

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    context.dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointerup', 120, 90);

    const bindingCallsBeforeMainPan = overview.updateAllTargetBindings.mock.calls.length;
    helpers.setMainViewport(140, 110);
    helpers.runViewportListener();
    vi.advanceTimersByTime(0);

    expect(overview.updateAllTargetBindings.mock.calls.length).toBe(bindingCallsBeforeMainPan);
  });
}

function registerPendingRefreshDoesNotOverrideMainPanSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】小地图拖拽释放后的待处理刷新不应覆盖随后的主图 pan', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: { position: GoPoint };
      centerRect: ReturnType<typeof vi.fn>;
      requestUpdate: ReturnType<typeof vi.fn>;
    };

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    context.dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointerup', 120, 90);

    const releasePosition = context.getDiagramPosition().copy();
    overview.centerRect.mockClear();
    overview.requestUpdate.mockClear();

    context.setDiagramPosition(new go.Point(releasePosition.x + 80, releasePosition.y + 60));
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(overview.box.position.x).toBe(releasePosition.x + 80);
    expect(overview.box.position.y).toBe(releasePosition.y + 60);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.requestUpdate).not.toHaveBeenCalled();
  });
}

function registerMainPanSyncsBoxGeometrySpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】主图 pan 必须同步 GoJS box 的视觉几何，不能只改 position', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: {
        position: GoPoint;
        location: GoPoint;
        selectionObject: { desiredSize: GoSize; strokeWidth: number };
        isSelected: boolean;
      };
      centerRect: ReturnType<typeof vi.fn>;
      requestUpdate: ReturnType<typeof vi.fn>;
      scale: number;
    };

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    context.dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointerup', 120, 90);

    const releasePosition = context.getDiagramPosition().copy();
    const nextPosition = new go.Point(releasePosition.x + 80, releasePosition.y + 60);
    const staleStrokeWidth = 2 / overview.scale;
    overview.box.location = new go.Point(
      releasePosition.x - staleStrokeWidth / 2,
      releasePosition.y - staleStrokeWidth / 2,
    );
    overview.box.selectionObject.desiredSize = new go.Size(1, 1);
    overview.box.isSelected = false;
    overview.centerRect.mockClear();
    overview.requestUpdate.mockClear();

    context.setDiagramPosition(nextPosition);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    const expectedStrokeWidth = 2 / overview.scale;
    expect(overview.box.position.x).toBe(nextPosition.x);
    expect(overview.box.position.y).toBe(nextPosition.y);
    expect(overview.box.location.x).toBe(nextPosition.x - expectedStrokeWidth / 2);
    expect(overview.box.location.y).toBe(nextPosition.y - expectedStrokeWidth / 2);
    expect(overview.box.selectionObject.desiredSize.width).toBe(800);
    expect(overview.box.selectionObject.desiredSize.height).toBe(600);
    expect(overview.box.selectionObject.strokeWidth).toBe(expectedStrokeWidth);
    expect(overview.box.isSelected).toBe(true);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.requestUpdate).not.toHaveBeenCalled();
  });
}

function registerEscapedBoundsExpandsOnceSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】主图拖出稳定边界时只扩边一次，后续边界内平移继续被动同步', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: { position: GoPoint };
      centerRect: ReturnType<typeof vi.fn>;
      fixedBounds: GoRect | undefined;
      scale: number;
    };
    const fixedBoundsWrites = trackFixedBoundsWrites(overview);

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();
    overview.centerRect.mockClear();
    fixedBoundsWrites.reset();
    const scaleBeforeMainPan = overview.scale;

    helpers.setMainViewport(1400, 1000);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(fixedBoundsWrites.count).toBeGreaterThan(0);
    expect(overview.scale).toBe(scaleBeforeMainPan);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.box.position.x).toBe(1400);
    expect(overview.box.position.y).toBe(1000);

    const fixedBoundsWriteCountAfterEscape = fixedBoundsWrites.count;
    overview.centerRect.mockClear();

    helpers.setMainViewport(1420, 1020);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(fixedBoundsWrites.count).toBe(fixedBoundsWriteCountAfterEscape);
    expect(overview.scale).toBe(scaleBeforeMainPan);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.box.position.x).toBe(1420);
    expect(overview.box.position.y).toBe(1020);
  });
}

function registerContinuousPanDoesNotRewriteBoundsSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】小地图拖拽后主图持续 pan 一整屏不应反复重写 fixedBounds', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: { position: GoPoint };
      centerRect: ReturnType<typeof vi.fn>;
      fixedBounds: GoRect | undefined;
      requestUpdate: ReturnType<typeof vi.fn>;
      updateAllTargetBindings: ReturnType<typeof vi.fn>;
    };
    const fixedBoundsWrites = trackFixedBoundsWrites(overview);

    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    context.dispatchPointer('pointerdown', 20, 20);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointermove', 120, 90);
    vi.runOnlyPendingTimers();
    context.dispatchPointer('pointerup', 120, 90);
    vi.runOnlyPendingTimers();

    fixedBoundsWrites.reset();
    overview.centerRect.mockClear();
    overview.updateAllTargetBindings.mockClear();

    helpers.setMainViewport(1400, 1000);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(fixedBoundsWrites.count).toBeGreaterThan(0);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.box.position.x).toBe(1400);
    expect(overview.box.position.y).toBe(1000);
    const fixedBoundsWriteCountAfterEscape = fixedBoundsWrites.count;
    overview.requestUpdate.mockClear();

    helpers.setMainViewport(2200, 1600);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(fixedBoundsWrites.count).toBe(fixedBoundsWriteCountAfterEscape);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.box.position.x).toBe(2200);
    expect(overview.box.position.y).toBe(1600);
    expect(overview.requestUpdate).not.toHaveBeenCalled();
    expect(overview.updateAllTargetBindings).not.toHaveBeenCalled();
  });
}

function registerViewportWindowPanOnlyMovesBoxSpec(
  context: FlowOverviewPanRegressionSpecContext,
  helpers: FlowOverviewPanRegressionSpecHelpers,
): void {
  it('【回归保护】主图仍在 fixedBounds 内但离开小地图可见窗口时，只移动预览框不移动底图', () => {
    const overview = context.getService().overviewInstance as unknown as {
      box: { position: GoPoint };
      centerRect: ReturnType<typeof vi.fn>;
      fixedBounds: GoRect | undefined;
      position: GoPoint;
      scale: number;
    };
    const fixedBoundsWrites = trackFixedBoundsWrites(overview);

    context.setDocumentBounds(new go.Rect(-2000, -2000, 5000, 4000));
    helpers.runDocumentBoundsListener();
    vi.runOnlyPendingTimers();
    overview.centerRect.mockClear();
    fixedBoundsWrites.reset();
    const scaleBeforeMainPan = overview.scale;

    overview.position = new go.Point(0, 0);
    helpers.setMainViewport(1400, 1000);
    helpers.runViewportListener();
    vi.runOnlyPendingTimers();

    expect(fixedBoundsWrites.count).toBe(0);
    expect(overview.scale).toBe(scaleBeforeMainPan);
    expect(overview.centerRect).not.toHaveBeenCalled();
    expect(overview.position.x).toBe(0);
    expect(overview.position.y).toBe(0);
    expect(overview.box.position.x).toBe(1400);
    expect(overview.box.position.y).toBe(1000);
  });
}

export function registerFlowOverviewPanRegressionSpecs(context: FlowOverviewPanRegressionSpecContext): void {
  const helpers = createPanRegressionSpecHelpers(context);

  registerStableBoundsPassivePanSpec(context, helpers);
  registerImmediateOverviewDragSpec(context, helpers);
  registerReleasedDragGhostRefreshSpec(context, helpers);
  registerPendingRefreshDoesNotOverrideMainPanSpec(context, helpers);
  registerMainPanSyncsBoxGeometrySpec(context, helpers);
  registerEscapedBoundsExpandsOnceSpec(context, helpers);
  registerContinuousPanDoesNotRewriteBoundsSpec(context, helpers);
  registerViewportWindowPanOnlyMovesBoxSpec(context, helpers);
}
