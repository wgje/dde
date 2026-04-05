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
    projectId: 'project-1',
    parentId: null,
    level: 0,
    path: 'task-1',
    sortKey: 'task-1',
    createdAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    userId: 'local-user',
    isExpanded: false,
    attachments: [],
    tags: [],
    parkingMeta: null,
    expected_minutes: null,
    wait_minutes: null,
    cognitive_load: null,
    displayId: '1,a',
    createdDate: new Date('2026-04-04T08:00:00.000Z'),
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

    component.onCardClick({ stopPropagation } as Event);
    component.onCardClick({ stopPropagation } as Event);

    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(stopPropagation).toHaveBeenCalledTimes(2);
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

    expect(() => component.onCardClick({ stopPropagation } as Event)).not.toThrow();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('should arm the container click guard when a selected card receives a primary pointer down', () => {
    const component = createComponent(true) as unknown as {
      onCardPointerDown: (event: PointerEvent) => void;
    };

    component.onCardPointerDown({ button: 0, isPrimary: true } as PointerEvent);

    expect(mockTextViewOps.armContainerClickGuard).toHaveBeenCalledTimes(1);
  });
});