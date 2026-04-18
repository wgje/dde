import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowZoomService } from './flow-zoom.service';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';

describe('FlowZoomService', () => {
  let service: FlowZoomService;

  const mockProjectState = {
    activeProjectId: vi.fn(() => 'project-1'),
    updateViewState: vi.fn(),
  };

  const mockSyncCoordinator = {
    markLocalChanges: vi.fn(),
    schedulePersist: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

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
});
