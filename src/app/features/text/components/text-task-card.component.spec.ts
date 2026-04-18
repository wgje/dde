import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextTaskCardComponent } from './text-task-card.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import { TextViewTaskOpsService } from '../services/text-view-task-ops.service';
import type { Task } from '../../../../models';

describe('TextTaskCardComponent', () => {
  const mockDockEngine = {
    dockedTaskIds: vi.fn(() => new Set<string>()),
    focusingEntry: vi.fn(() => null),
  };

  const mockProjectState = {
    compressDisplayId: vi.fn((displayId: string) => displayId),
    activeProjectId: vi.fn(() => null),
    getTask: vi.fn(() => null),
  };

  const mockLogger = {
    warn: vi.fn(),
  };

  const mockTaskAdapter = {
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    addTodoItem: vi.fn(),
    updateTaskExpectedMinutes: vi.fn(),
    updateTaskWaitMinutes: vi.fn(),
    updateTaskCognitiveLoad: vi.fn(),
    updateTaskAttachments: vi.fn(),
  };

  const mockChangeTracker = {
    lockTaskField: vi.fn(),
    unlockTaskField: vi.fn(),
  };

  const mockUiState = {
    markEditing: vi.fn(),
  };

  const mockAttachmentService = {
    uploadFile: vi.fn(),
    markAsDeleted: vi.fn(),
  };

  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  };

  const mockTextViewOps = {
    armContainerClickGuard: vi.fn(),
  };

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '购置零件',
    content: '联系供应商确认规格。',
    status: 'active',
    stage: 1,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    attachments: [],
    tags: [],
    parkingMeta: null,
    expected_minutes: null,
    wait_minutes: null,
    cognitive_load: null,
    displayId: '1,a',
    ...overrides,
  });

  const createComponent = (selected: boolean) => {
    const component = TestBed.runInInjectionContext(() => new TextTaskCardComponent()) as unknown as {
      task: () => Task;
      isMobile: () => boolean;
      isSelected: () => boolean;
      isDragging: () => boolean;
      userId: () => string | null;
      projectId: () => string | null;
      connections: () => null;
      stageNumber: () => number;
      cardClasses: Record<string, boolean>;
      onCardClick: (event: Event) => void;
      select: { emit: ReturnType<typeof vi.fn> };
    };

    component.task = () => createTask();
    component.isMobile = () => false;
    component.isSelected = () => selected;
    component.isDragging = () => false;
    component.userId = () => null;
    component.projectId = () => null;
    component.connections = () => null;
    component.stageNumber = () => 1;
    return component;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProjectState.getTask.mockReturnValue(null);

    await TestBed.configureTestingModule({
      imports: [TextTaskCardComponent],
      providers: [
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: LoggerService, useValue: mockLogger },
        { provide: TaskOperationAdapterService, useValue: mockTaskAdapter },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: UiStateService, useValue: mockUiState },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: ToastService, useValue: mockToast },
        { provide: TextViewTaskOpsService, useValue: mockTextViewOps },
      ],
    }).compileComponents();
  });

  it('should keep virtual list containment for collapsed cards', () => {
    const component = createComponent(false);

    expect(component.cardClasses['virtual-list-item']).toBe(true);
  });

  it('should opt out of virtual list containment once the card is expanded', () => {
    const component = createComponent(true);

    expect(component.cardClasses['virtual-list-item']).toBe(false);
  });

  it('should emit select on repeated desktop clicks when the card is unselected again', () => {
    const component = createComponent(false);
    const stopPropagation = vi.fn();
    const emitSpy = vi.spyOn(component.select, 'emit');

    component.onCardClick({ stopPropagation } as unknown as Event);
    component.onCardClick({ stopPropagation } as unknown as Event);

    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });

  it('should clear selection and still keep button-contained svg clicks non-selecting', () => {
    const component = createComponent(false) as unknown as {
      onCardClick: (event: Event) => void;
      select: { emit: ReturnType<typeof vi.fn> };
    };
    const button = document.createElement('button');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    button.appendChild(svg);

    const stopPropagation = vi.fn();
    const emitSpy = vi.spyOn(component.select, 'emit');
    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '零件',
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection);

    try {
      component.onCardClick({ target: svg, stopPropagation } as unknown as Event);

      expect(removeAllRanges).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalledTimes(1);
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it('should ignore a late click when the task input is no longer available', () => {
    const component = createComponent(false) as unknown as {
      task: () => Task;
      onCardClick: (event: Event) => void;
      select: { emit: ReturnType<typeof vi.fn> };
    };
    const stopPropagation = vi.fn();
    const emitSpy = vi.spyOn(component.select, 'emit');
    component.task = () => {
      throw new Error('task missing');
    };

    expect(() => component.onCardClick({ stopPropagation } as unknown as Event)).not.toThrow();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('should arm the container click guard when a selected card receives a primary pointer down', () => {
    const component = createComponent(true) as unknown as {
      onCardPointerDown: (event: PointerEvent) => void;
    };

    component.onCardPointerDown({ button: 0, isPrimary: true } as unknown as PointerEvent);

    expect(mockTextViewOps.armContainerClickGuard).toHaveBeenCalledTimes(1);
  });

  it('should ignore mobile body touch starts so stage scrolling keeps priority', () => {
    const component = createComponent(false) as unknown as {
      isMobile: () => boolean;
      onTouchStart: (event: TouchEvent) => void;
      touchStart: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(component.touchStart, 'emit');
    component.isMobile = () => true;

    component.onTouchStart({} as TouchEvent);

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('should emit mobile drag start only from the explicit handle touch', () => {
    const component = createComponent(false) as unknown as {
      isMobile: () => boolean;
      onDragHandleTouchStart: (event: TouchEvent) => void;
      touchStart: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(component.touchStart, 'emit');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const event = {
      cancelable: true,
      stopPropagation,
      preventDefault,
    } as unknown as TouchEvent;
    component.isMobile = () => true;

    component.onDragHandleTouchStart(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({
      event,
      task: expect.objectContaining({ id: 'task-1' }),
      gestureMode: 'handle',
    });
  });

  it('should not emit select when clicking an anchor inside the card', () => {
    const component = createComponent(false) as unknown as {
      onCardClick: (event: Event) => void;
      select: { emit: ReturnType<typeof vi.fn> };
    };
    const anchor = document.createElement('a');
    const stopPropagation = vi.fn();
    const emitSpy = vi.spyOn(component.select, 'emit');

    component.onCardClick({ target: anchor, stopPropagation } as unknown as Event);

    expect(emitSpy).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('should emit openLinkedTask when collapsed preview task link is clicked', () => {
    const component = createComponent(false) as unknown as {
      onContentPreviewClick: (event: MouseEvent) => void;
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#task:linked-task');
    anchor.setAttribute('data-link-kind', 'task');
    anchor.setAttribute('data-task-link-id', 'linked-task');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const event = { target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent;

    component.onContentPreviewClick(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({ taskId: 'linked-task', event });
  });

  it('should prevent blocked link clicks inside collapsed preview', () => {
    const component = createComponent(false) as unknown as {
      onContentPreviewClick: (event: MouseEvent) => void;
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#__nf_blocked__');
    anchor.setAttribute('data-link-kind', 'blocked');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    component.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('should handle local links inside collapsed preview without selecting the card', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const component = createComponent(false) as unknown as {
        onContentPreviewClick: (event: MouseEvent) => void;
        openLinkedTask: { emit: ReturnType<typeof vi.fn> };
      };
      const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#local-path');
      anchor.setAttribute('data-link-kind', 'local');
      anchor.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      component.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);
      await Promise.resolve();

      expect(stopPropagation).toHaveBeenCalledTimes(1);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });
});
