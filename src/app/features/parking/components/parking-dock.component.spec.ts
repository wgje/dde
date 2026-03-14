import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParkingDockComponent } from '../parking-dock.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { TaskStore } from '../../../core/state/stores';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { success } from '../../../../utils/result';

describe('ParkingDockComponent v3', () => {
  let fixture: ComponentFixture<ParkingDockComponent>;
  let component: ParkingDockComponent;

  const dockedEntries = signal([]);
  const focusMode = signal(false);
  const dockExpanded = signal(true);
  const pendingDecision = signal(null);
  const pendingDecisionEntries = signal([]);

  const mockEngine = {
    dockedEntries,
    dockedCount: computed(() => dockedEntries().length),
    focusMode,
    dockExpanded,
    pendingDecision,
    pendingDecisionEntries,
    isFragmentPhase: signal(false),
    toggleFocusMode: vi.fn(() => focusMode.update(value => !value)),
    setDockExpanded: vi.fn((expanded: boolean) => dockExpanded.set(expanded)),
    choosePendingDecisionCandidate: vi.fn(),
    toggleMuteWaitTone: vi.fn(),
    dockTask: vi.fn(),
    removeFromDock: vi.fn(),
    setMainTask: vi.fn(),
    toggleLoad: vi.fn(),
  };

  const mockTaskStore = {
    getTask: vi.fn(),
  };

  const mockTaskOps = {
    addTask: vi.fn(),
  };

  const mockLogger = {
    category: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    dockedEntries.set([]);
    focusMode.set(false);
    dockExpanded.set(true);
    pendingDecision.set(null);
    pendingDecisionEntries.set([]);
    mockTaskOps.addTask.mockReturnValue(success('new-task-id'));

    await TestBed.configureTestingModule({
      imports: [ParkingDockComponent],
      providers: [
        { provide: DockEngineService, useValue: mockEngine },
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: LoggerService, useValue: mockLogger },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ParkingDockComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('createTask should create in project first, then dock with manual zone source', () => {
    component.newTaskTitle = '新任务';
    component.newTaskDetail = '任务详情';
    component.newTaskZone = 'weak';
    component.newTaskLoad = 'high';
    component.newTaskExpectedMinutes = '25';
    component.newTaskWaitMinutes = '5';

    component.createTask();

    expect(mockTaskOps.addTask).toHaveBeenCalledWith('新任务', '任务详情', null, null, false);
    expect(mockEngine.dockTask).toHaveBeenCalledWith('new-task-id', 'weak', {
      sourceKind: 'dock-created',
      sourceSection: 'dock-create',
      load: 'high',
      expectedMinutes: 25,
      waitMinutes: 5,
      detail: '任务详情',
      zoneSource: 'manual',
    });
  });

  it('onDrop should prefer unified payload protocol taskId', () => {
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({ v: 1, type: 'task', taskId: 'task-1', projectId: 'p-1', source: 'flow' });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTask).toHaveBeenCalledWith('task-1', undefined, {
      sourceSection: 'flow',
      zoneSource: 'auto',
    });
  });

  it('onDrop should fallback to text/plain with auto zone source', () => {
    mockTaskStore.getTask.mockReturnValue({ id: 'legacy-task', status: 'active' });
    const getData = vi.fn((mime: string) => (mime === 'text/plain' ? 'legacy-task' : ''));

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTask).toHaveBeenCalledWith('legacy-task', undefined, {
      sourceSection: undefined,
      zoneSource: 'auto',
    });
  });
});
