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
import { UserSessionService } from '../../../../services/user-session.service';
import type { Task } from '../../../../models';

describe('TextViewTaskOpsService', () => {
  let service: TextViewTaskOpsService;
  let hostElement: HTMLElement;
  let outerScrollContainer: HTMLElement;
  let stageTaskList: HTMLElement;
  const mockTaskOpsAdapter = {
    addTask: vi.fn(),
  };
  const mockToast = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const mockUserSession = {
    isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
  };

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
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: ProjectStateService, useValue: {} },
        { provide: UiStateService, useValue: {} },
        { provide: ToastService, useValue: mockToast },
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
        { provide: UserSessionService, useValue: mockUserSession },
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
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(false);
    mockTaskOpsAdapter.addTask.mockReset();
    mockToast.info.mockReset();
    mockToast.error.mockReset();
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

  it('should block create actions while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    service.onCreateUnassigned();

    expect(mockTaskOpsAdapter.addTask).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建任务暂不可用，owner 确认完成前保持只读');
  });

  it('should clear the current selection when clicking the container blank area', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const outside = document.createElement('div');
    hostElement.appendChild(outside);

    service.onContainerClick({ target: outside } as Event);

    expect(selectedTaskId()).toBeNull();
  });

  it('should keep the current selection when clicking inside a task card', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-1');
    const inner = document.createElement('span');
    taskCard.appendChild(inner);
    hostElement.appendChild(taskCard);

    service.onContainerClick({ target: inner } as Event);

    expect(selectedTaskId()).toBe('task-1');
  });

  it('should keep the current selection when the click target is detached but the event path still includes the task card', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-1');
    const detachedButton = document.createElement('button');

    service.onContainerClick({
      target: detachedButton,
      composedPath: () => [detachedButton, taskCard, hostElement, document.body, document, window],
    } as Event);

    expect(selectedTaskId()).toBe('task-1');
  });

  it('should ignore the same container click after arming the guard from an internal card interaction', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-1');
    const inner = document.createElement('span');

    service.armContainerClickGuard('task-1');
    service.onContainerClick({
      target: document.body,
      composedPath: () => [inner, taskCard, hostElement, document.body, document, window],
    } as Event);

    expect(selectedTaskId()).toBe('task-1');

    service.onContainerClick({ target: document.body } as Event);

    expect(selectedTaskId()).toBeNull();
  });

  it('should let the first real outside click through after the container guard expires unused', () => {
    const selectedTaskId = signal<string | null>('task-1');

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.armContainerClickGuard('task-1');
    service.onContainerClick({ target: document.body } as Event);

    expect(selectedTaskId()).toBeNull();
  });

  it('should reveal the compact title preview and focus the real title input when scrolling to a new task', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const revealEditor = vi.fn();
    const inputFocus = vi.fn();
    const inputSelect = vi.fn();
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    try {
      const taskCard = document.createElement('div');
      taskCard.setAttribute('data-task-id', 'task-1');
      Object.defineProperty(taskCard, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView,
      });

      const previewButton = document.createElement('button');
      previewButton.setAttribute('data-title-preview-trigger', '');
      previewButton.addEventListener('click', () => {
        revealEditor();
        const input = document.createElement('input');
        input.setAttribute('data-title-input', '');
        Object.defineProperty(input, 'focus', {
          configurable: true,
          value: inputFocus,
        });
        Object.defineProperty(input, 'select', {
          configurable: true,
          value: inputSelect,
        });
        taskCard.appendChild(input);
      });

      taskCard.appendChild(previewButton);
      hostElement.appendChild(taskCard);

      service.scrollToTaskAndFocus('task-1', 'input[data-title-input]');
      vi.runAllTimers();

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(revealEditor).toHaveBeenCalledTimes(1);
      expect(taskCard.querySelector('input[data-title-input]')).not.toBeNull();
      expect(inputFocus).toHaveBeenCalledTimes(1);
      expect(inputSelect).toHaveBeenCalledTimes(1);
    } finally {
      rafSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should keep the current task selected when the same task emits select again', () => {
    const selectedTaskId = signal<string | null>('task-1');
    const focusFlowNode = { emit: vi.fn() };

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: focusFlowNode as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.onTaskSelect({ id: 'task-1' } as Task);

    expect(selectedTaskId()).toBe('task-1');
    expect(focusFlowNode.emit).not.toHaveBeenCalled();
  });

  it('should select a different task and focus its flow node on desktop', () => {
    const selectedTaskId = signal<string | null>(null);
    const focusFlowNode = { emit: vi.fn() };

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: focusFlowNode as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.onTaskSelect({ id: 'task-2' } as Task);

    expect(selectedTaskId()).toBe('task-2');
    expect(focusFlowNode.emit).toHaveBeenCalledWith('task-2');
  });

  it('should ignore invalid task select payloads', () => {
    const selectedTaskId = signal<string | null>('task-1');
    const focusFlowNode = { emit: vi.fn() };

    service.init({
      selectedTaskId,
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: focusFlowNode as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => undefined,
    });

    service.onTaskSelect(undefined);

    expect(selectedTaskId()).toBe('task-1');
    expect(focusFlowNode.emit).not.toHaveBeenCalled();
  });
});