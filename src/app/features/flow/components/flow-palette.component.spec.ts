import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BlackBoxEntry,
  Project,
  Task,
  UnfinishedItem,
} from '../../../../models';
import { BlackBoxService } from '../../../../services/black-box.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { blackBoxEntriesMap, resetFocusState } from '../../../../state/focus-stores';
import { BlackBoxPanelComponent } from '../../focus/components/black-box/black-box-panel.component';
import { StrataViewComponent } from '../../focus/components/strata/strata-view.component';
import { FlowPaletteComponent } from './flow-palette.component';

@Component({
  selector: 'app-black-box-panel',
  standalone: true,
  template: '<div data-testid="stub-black-box-panel"></div>',
})
class StubBlackBoxPanelComponent {}

@Component({
  selector: 'app-strata-view',
  standalone: true,
  template: '<div data-testid="stub-strata-view"></div>',
})
class StubStrataViewComponent {}

const createTask = (id: string, status: Task['status'] = 'active'): Task => ({
  id,
  title: `Task ${id}`,
  content: '',
  stage: 1,
  parentId: null,
  order: 0,
  rank: 0,
  status,
  x: 0,
  y: 0,
  createdDate: '2026-04-03',
  updatedAt: '2026-04-03T10:00:00Z',
  displayId: id,
  deletedAt: null,
});

const createBlackBoxEntry = (id: string, isCompleted: boolean): BlackBoxEntry => ({
  id,
  projectId: 'project-1',
  userId: 'user-1',
  content: `Entry ${id}`,
  date: '2026-04-03',
  createdAt: '2026-04-03T10:00:00Z',
  updatedAt: '2026-04-03T10:00:00Z',
  isRead: false,
  isCompleted,
  isArchived: false,
  deletedAt: null,
});

describe('FlowPaletteComponent', () => {
  let fixture: ComponentFixture<FlowPaletteComponent>;
  let component: FlowPaletteComponent;

  const tasks = signal<Task[]>([]);
  const unfinishedItems = signal<UnfinishedItem[]>([]);
  const unassignedTasks = signal<Task[]>([]);
  const activeProject = signal<Project | null>({
    id: 'project-1',
    name: '测试项目',
    description: '',
    createdDate: '2026-04-03',
    updatedAt: '2026-04-03T10:00:00Z',
    tasks: [],
    connections: [],
  });

  const mockUiState = {
    isFlowUnfinishedOpen: signal(false),
    isFlowUnassignedOpen: signal(false),
  };

  const mockProjectState = {
    tasks,
    unfinishedItems,
    unassignedTasks,
    activeProject,
  };

  const mockBlackBoxService = {
    pendingCount: signal(0),
    update: vi.fn(),
  };

  const mockFocusPreferenceService = {
    isBlackBoxEnabled: vi.fn(() => true),
  };

  const mockTaskOperationAdapterService = {
    updateTaskStatus: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetFocusState();
    tasks.set([]);
    unfinishedItems.set([]);
    unassignedTasks.set([]);
    activeProject.set({
      id: 'project-1',
      name: '测试项目',
      description: '',
      createdDate: '2026-04-03',
      updatedAt: '2026-04-03T10:00:00Z',
      tasks: [],
      connections: [],
    });

    await TestBed.configureTestingModule({
      imports: [FlowPaletteComponent],
      providers: [
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: TaskOperationAdapterService, useValue: mockTaskOperationAdapterService },
      ],
    })
      .overrideComponent(FlowPaletteComponent, {
        remove: {
          imports: [BlackBoxPanelComponent, StrataViewComponent],
        },
        add: {
          imports: [StubBlackBoxPanelComponent, StubStrataViewComponent],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(FlowPaletteComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
    resetFocusState();
  });

  it('在没有任何任务时应显示 100% 完成率', () => {
    blackBoxEntriesMap.set(new Map([
      ['bb-1', createBlackBoxEntry('bb-1', true)],
      ['bb-2', createBlackBoxEntry('bb-2', false)],
      ['bb-3', createBlackBoxEntry('bb-3', false)],
    ]));

    expect(component.totalTaskCount()).toBe(0);
    expect(component.completionRate()).toBe(100);
  });

  it('在未选中项目时不应误显示 100% 完成率', () => {
    activeProject.set(null);
    blackBoxEntriesMap.set(new Map([
      ['bb-1', createBlackBoxEntry('bb-1', true)],
      ['bb-2', createBlackBoxEntry('bb-2', false)],
    ]));

    expect(component.completionRate()).toBe(0);
  });

  it('在仍有任务时继续按黑匣子完成率计算', () => {
    tasks.set([createTask('task-1')]);
    blackBoxEntriesMap.set(new Map([
      ['bb-1', createBlackBoxEntry('bb-1', true)],
      ['bb-2', createBlackBoxEntry('bb-2', true)],
      ['bb-3', createBlackBoxEntry('bb-3', false)],
    ]));

    expect(component.totalTaskCount()).toBe(1);
    expect(component.completionRate()).toBe(67);
  });
});