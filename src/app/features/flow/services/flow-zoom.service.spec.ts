import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowZoomService } from './flow-zoom.service';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';

describe('FlowZoomService', () => {
  let service: FlowZoomService;
  let activeProjectId = 'project-1';

  const mockProjectState = {
    activeProjectId: vi.fn(() => activeProjectId),
    updateViewState: vi.fn(),
  };

  const mockSyncCoordinator = {
    markLocalChanges: vi.fn(),
    schedulePersist: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    activeProjectId = 'project-1';

    TestBed.configureTestingModule({
      providers: [
        FlowZoomService,
        { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
      ],
    });

    service = TestBed.inject(FlowZoomService);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function attachDiagram(initialScale = 1, initialPosition = new go.Point(0, 0)) {
    let scale = initialScale;
    let position = initialPosition.copy();

    const diagram = {
      get scale(): number {
        return scale;
      },
      set scale(value: number) {
        scale = value;
      },
      get position(): go.Point {
        return position;
      },
      set position(value: go.Point) {
        position = value;
      },
      commandHandler: {
        increaseZoom: vi.fn(),
        decreaseZoom: vi.fn(),
      },
      select: vi.fn(),
      findNodeForKey: vi.fn(() => null),
      centerRect: vi.fn(),
      scrollToRect: vi.fn(),
      documentBounds: new go.Rect(0, 0, 200, 100),
      viewportBounds: new go.Rect(0, 0, 500, 300),
    };

    service.setDiagram(diagram as unknown as go.Diagram);
    return diagram;
  }

  it('guard 为 false 时不应保存视图状态', () => {
    attachDiagram(1.1, new go.Point(12, 34));
    service.setViewStatePersistenceGuard(() => false);

    service.saveViewState();

    expect(mockProjectState.updateViewState).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.markLocalChanges).not.toHaveBeenCalled();
  });

  it('取消待执行保存后不应再把缩放结果写回 store', () => {
    attachDiagram(1, new go.Point(10, 20));
    service.setViewStatePersistenceGuard(() => true);

    service.setZoom(1.6);
    service.cancelPendingViewStateSave();
    vi.advanceTimersByTime(400);

    expect(mockProjectState.updateViewState).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.schedulePersist).not.toHaveBeenCalled();
  });

  it('取消待执行保存时即使浏览器 timer handle 为 0 也应清理，防止 teardown 后 stale 保存写回', () => {
    attachDiagram(1, new go.Point(10, 20));
    service.setViewStatePersistenceGuard(() => true);
    const zeroTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => zeroTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    try {
      service.setZoom(1.6);
      service.cancelPendingViewStateSave();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(zeroTimer);
      expect(
        (service as unknown as { viewStateSaveTimer: ReturnType<typeof setTimeout> | null }).viewStateSaveTimer
      ).toBeNull();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('fit 延迟保存绑定原项目，切到其他项目后不得写入', () => {
    activeProjectId = 'project-b';
    const diagram = attachDiagram();

    service.fitToContents({
      projectId: 'project-b',
      diagram: diagram as unknown as go.Diagram,
      isCurrent: () => true,
    });
    activeProjectId = 'project-c';
    vi.advanceTimersByTime(300);

    expect(mockProjectState.updateViewState).not.toHaveBeenCalled();
  });

  it('fit owner guard 必须传播到其排队的保存', () => {
    activeProjectId = 'project-b';
    let isCurrent = true;
    const diagram = attachDiagram();

    service.fitToContents({
      projectId: 'project-b',
      diagram: diagram as unknown as go.Diagram,
      isCurrent: () => isCurrent,
    });
    isCurrent = false;
    vi.advanceTimersByTime(300);

    expect(mockProjectState.updateViewState).not.toHaveBeenCalled();
  });

  it('fit 延迟保存使用 fit 完成时复制的视口值', () => {
    activeProjectId = 'project-b';
    const diagram = attachDiagram();

    service.fitToContents({ projectId: 'project-b', diagram: diagram as unknown as go.Diagram, isCurrent: () => true });
    const expected = { scale: diagram.scale, positionX: diagram.position.x, positionY: diagram.position.y };
    diagram.scale = 2.8;
    diagram.position = new go.Point(900, 700);
    vi.advanceTimersByTime(300);

    expect(mockProjectState.updateViewState).toHaveBeenLastCalledWith('project-b', expected);
  });

  it('同项目连续保存只持久化最后一次调用时复制的视口值', () => {
    const diagram = attachDiagram(1, new go.Point(10, 20));
    service.setZoom(1.2);
    diagram.position = new go.Point(14, 28);
    service.setZoom(1.4);
    diagram.scale = 2.8; diagram.position = new go.Point(280, 560);
    vi.advanceTimersByTime(300);

    expect(mockProjectState.updateViewState).toHaveBeenCalledTimes(1);
    expect(mockProjectState.updateViewState).toHaveBeenCalledWith('project-1', { scale: 1.4, positionX: 14, positionY: 28 });
  });
});
