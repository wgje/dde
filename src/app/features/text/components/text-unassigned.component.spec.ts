import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextUnassignedComponent } from './text-unassigned.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import type { Task } from '../../../../models';

describe('TextUnassignedComponent', () => {
  let fixture: ComponentFixture<TextUnassignedComponent>;
  let component: TextUnassignedComponent;

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '原始标题',
    content: '',
    status: 'active',
    stage: null,
    order: 0,
    projectId: 'project-1',
    parentId: null,
    level: 0,
    path: 'task-1',
    sortKey: 'task-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userId: 'local-user',
    isExpanded: false,
    attachments: [],
    tags: [],
    parkingMeta: null,
    ...overrides,
  });

  const tasks = signal<Task[]>([]);
  const mockTaskAdapter = {
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    deleteTask: vi.fn(),
    moveTaskToStage: vi.fn(() => ({ ok: true })),
  };
  const mockUiState = {
    isTextSidebarVisible: signal(true),
    isTextUnassignedOpen: signal(true),
  };
  const mockProjectState = {
    unassignedTasks: tasks,
    getTask: vi.fn((taskId: string) => tasks().find(task => task.id === taskId) ?? null),
  };
  const mockParkingService = {
    parkTask: vi.fn(),
  };
  const mockDockEngine = {
    dockTask: vi.fn(() => true),
  };
  const mockReminderService = {
    setReminder: vi.fn(),
    cancelReminder: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tasks.set([createTask()]);

    await TestBed.configureTestingModule({
      imports: [TextUnassignedComponent],
      providers: [
        { provide: TaskOperationAdapterService, useValue: mockTaskAdapter },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: SimpleReminderService, useValue: mockReminderService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TextUnassignedComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('parkTaskNow should persist draft edits before parking and sync the dock', () => {
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void };
      localContent: { set: (value: string) => void };
      reminderMenuTaskId: { set: (value: string | null) => void; (): string | null };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('停泊前标题');
    internal.localContent.set('停泊前正文');
    internal.reminderMenuTaskId.set(task.id);
    fixture.detectChanges();

    const parkButton = fixture.nativeElement.querySelector('[data-testid="text-unassigned-park-button"]') as HTMLButtonElement | null;
    parkButton?.click();

    expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledWith(task.id, '停泊前标题');
    expect(mockTaskAdapter.updateTaskContent).toHaveBeenCalledWith(task.id, '停泊前正文');
    expect(mockParkingService.parkTask).toHaveBeenCalledWith(task.id);
    expect(mockDockEngine.dockTask).toHaveBeenCalledWith(task.id, undefined, {
      sourceSection: 'text',
      zoneSource: 'auto',
    });
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
    expect(internal.reminderMenuTaskId()).toBeNull();
  });

  it('should disable the park button when the task is already parked', () => {
    tasks.set([
      createTask({
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      }),
    ]);
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void };
      isEditMode: { set: (value: boolean) => void };
    };
    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    fixture.detectChanges();

    const parkButton = fixture.nativeElement.querySelector('[data-testid="text-unassigned-park-button"]') as HTMLButtonElement | null;
    expect(parkButton?.disabled).toBe(true);
  });
});
