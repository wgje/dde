import { ElementRef, NgZone, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextViewTaskOpsService } from './text-view-task-ops.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { TextViewDragDropService } from './text-view-drag-drop.service';

describe('TextViewTaskOpsService', () => {
  let service: TextViewTaskOpsService;
  let hostElement: HTMLElement;
  let outerScrollContainer: HTMLElement;
  let stageTaskList: HTMLElement;

  const mockRect = (element: HTMLElement, top: number, height: number) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: top,
      top,
      left: 0,
      bottom: top + height,
      right: 0,
      width: 320,
      height,
      toJSON: () => ({}),
    } as DOMRect);
  };

  beforeEach(() => {
    hostElement = document.createElement('div');
    hostElement.innerHTML = `
      <div class="text-view-scroll-container"></div>
      <div data-stage-task-list="1"></div>
    `;

    outerScrollContainer = hostElement.querySelector('.text-view-scroll-container') as HTMLElement;
    stageTaskList = hostElement.querySelector('[data-stage-task-list="1"]') as HTMLElement;

    Object.defineProperty(stageTaskList, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    Object.defineProperty(outerScrollContainer, 'clientHeight', {
      configurable: true,
      value: 480,
    });
    Object.defineProperty(outerScrollContainer, 'scrollHeight', {
      configurable: true,
      value: 960,
    });

    mockRect(stageTaskList, 100, 180);

    TestBed.configureTestingModule({
      providers: [
        TextViewTaskOpsService,
        { provide: ElementRef, useValue: new ElementRef(hostElement) },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
        { provide: TaskOperationAdapterService, useValue: {} },
        { provide: ProjectStateService, useValue: {} },
        { provide: UiStateService, useValue: {} },
        { provide: ToastService, useValue: {} },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        { provide: ParkingService, useValue: {} },
        { provide: DockEngineService, useValue: {} },
        {
          provide: TextViewDragDropService,
          useValue: {
            requestSourceStageCollapse: vi.fn(() => null),
            consumeAutoCollapsedSourceStage: vi.fn(() => null),
          },
        },
      ],
    });

    service = TestBed.inject(TextViewTaskOpsService);
  });

  it('should prefer the stage task list when that list can scroll', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });

    expect(service.resolveAutoScrollContainer(1)).toBe(stageTaskList);
  });

  it('should fall back to the outer text view container when the stage list cannot scroll', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 180,
    });

    expect(service.resolveAutoScrollContainer(1)).toBe(outerScrollContainer);
    expect(service.resolveAutoScrollContainer(null)).toBe(outerScrollContainer);
  });

  it('should fall back to the outer text view container when the stage list is already at the bottom edge', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    stageTaskList.scrollTop = 360;

    expect(service.resolveAutoScrollContainer(1, 270)).toBe(outerScrollContainer);
  });

  it('should keep the stage list as the auto-scroll container while it can still scroll downward', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    stageTaskList.scrollTop = 120;

    expect(service.resolveAutoScrollContainer(1, 270)).toBe(stageTaskList);
  });

  it('should fall back to the outer text view container when the stage list is already at the top edge', () => {
    Object.defineProperty(stageTaskList, 'clientHeight', {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(stageTaskList, 'scrollHeight', {
      configurable: true,
      value: 540,
    });
    stageTaskList.scrollTop = 0;

    expect(service.resolveAutoScrollContainer(1, 110)).toBe(outerScrollContainer);
  });
});