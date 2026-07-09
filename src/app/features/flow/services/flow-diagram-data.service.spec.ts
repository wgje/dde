import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowDiagramDataService } from './flow-diagram-data.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowZoomService } from './flow-zoom.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { Connection, Project, Task } from '../../../../models';

function createTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 100,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '1',
    attachments: overrides.attachments ?? [],
    tags: overrides.tags ?? [],
  } as Task;
}

function createGraphLinksModel(): go.GraphLinksModel {
  return new go.GraphLinksModel([], [], {
    linkKeyProperty: 'key',
    nodeKeyProperty: 'key',
    linkFromPortIdProperty: 'fromPortId',
    linkToPortIdProperty: 'toPortId',
  });
}

function createDiagram(model: go.GraphLinksModel): go.Diagram {
  return {
    model,
    selection: { each: vi.fn() },
    nodes: { each: vi.fn() },
    clearSelection: vi.fn(),
    findNodeForKey: vi.fn(() => null),
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    skipsUndoManager: false,
  } as unknown as go.Diagram;
}

describe('FlowDiagramDataService', () => {
  let service: FlowDiagramDataService;
  let buildDiagramData: ReturnType<typeof vi.fn>;
  let getLastUpdateType: ReturnType<typeof vi.fn>;
  let getViewState: ReturnType<typeof vi.fn>;
  let activeProjectId: ReturnType<typeof signal<string | null>>;
  let activeView: ReturnType<typeof signal<'text' | 'flow'>>;
  let updateViewState: ReturnType<typeof vi.fn>;
  let markLocalChanges: ReturnType<typeof vi.fn>;
  let schedulePersist: ReturnType<typeof vi.fn>;
  let fitToContents: ReturnType<typeof vi.fn>;
  let searchQuery: ReturnType<typeof signal<string>>;

  const rootTask = createTask({ id: 'root-task', title: 'Root', stage: 1, displayId: '1' });
  const childTask = createTask({
    id: 'child-task',
    title: 'Child',
    stage: 2,
    parentId: 'root-task',
    displayId: '1,1',
  });
  const project: Project = {
    id: 'project-1',
    name: 'Route Project',
    description: '',
    createdDate: '2026-06-01T00:00:00.000Z',
    tasks: [rootTask, childTask],
    connections: [],
    viewState: { scale: 1, positionX: 0, positionY: 0 },
  };

  beforeEach(() => {
    window.localStorage.clear();
    project.connections = [];
    getLastUpdateType = vi.fn(() => 'content');
    getViewState = vi.fn(() => project.viewState);
    activeProjectId = signal<string | null>('project-1');
    activeView = signal<'text' | 'flow'>('flow');
    updateViewState = vi.fn();
    markLocalChanges = vi.fn();
    schedulePersist = vi.fn();
    fitToContents = vi.fn();
    searchQuery = signal('');
    buildDiagramData = vi.fn(() => ({
      nodeDataArray: [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '0 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      linkDataArray: [
        { key: 'root-task-child-task', from: 'root-task', to: 'child-task', isCrossTree: false, curviness: 20 },
      ],
    }));

    TestBed.configureTestingModule({
      providers: [
        FlowDiagramDataService,
        {
          provide: ProjectStateService,
          useValue: {
            activeProject: signal(project),
            activeProjectId,
            getViewState,
            updateViewState,
          },
        },
        { provide: UiStateService, useValue: { searchQuery, activeView } },
        { provide: TaskOperationAdapterService, useValue: { getLastUpdateType } },
        { provide: SyncCoordinatorService, useValue: { markLocalChanges, schedulePersist } },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: ToastService, useValue: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } },
        { provide: DockEngineService, useValue: { dockedTaskIds: vi.fn(() => new Set<string>()), focusingEntry: vi.fn(() => null) } },
        { provide: FlowDiagramConfigService, useValue: { buildDiagramData } },
        { provide: FlowZoomService, useValue: { fitToContents } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
      ],
    });

    service = TestBed.inject(FlowDiagramDataService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('销毁后旧 initial fit 定时器不应操作重新挂载的新 Diagram', () => {
    vi.useFakeTimers();
    getViewState.mockReturnValue(null);
    const firstDiagram = createDiagram(createGraphLinksModel());
    const secondDiagram = createDiagram(createGraphLinksModel());

    service.setDiagram(firstDiagram);
    service.updateDiagram([rootTask], true);
    service.dispose();
    service.setDiagram(secondDiagram);

    vi.advanceTimersByTime(100);

    expect(fitToContents).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('dispose 应取消 Flow 激活时排队的双 rAF 自动适配', () => {
    const callbacks: FrameRequestCallback[] = [];
    const cancelAnimationFrameSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameSpy);
    getViewState.mockReturnValue(null);
    const diagram = createDiagram(createGraphLinksModel());

    service.setDiagram(diagram);
    (service as unknown as { pendingAutoFitToContents: boolean }).pendingAutoFitToContents = true;
    service.onFlowActivated();
    service.dispose();

    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);
    callbacks.shift()?.(0);
    callbacks.shift()?.(0);

    expect(fitToContents).not.toHaveBeenCalled();
  });

  it('saveViewState should clear debounce timer when the timer handle is 0', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const diagram = {
      ...createDiagram(createGraphLinksModel()),
      scale: 1.25,
      position: new go.Point(12, 24),
    } as unknown as go.Diagram;

    try {
      service.setDiagram(diagram);
      service.saveViewState();
      service.saveViewState();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('cancelPendingViewStateSave should clear debounce timer when the timer handle is 0', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const diagram = {
      ...createDiagram(createGraphLinksModel()),
      scale: 1.25,
      position: new go.Point(12, 24),
    } as unknown as go.Diagram;

    try {
      service.setDiagram(diagram);
      service.saveViewState();
      service.cancelPendingViewStateSave();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('restoreViewState should clear pending restore timer when the timer handle is 0', () => {
    getViewState.mockReturnValue(null);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      service.setDiagram(createDiagram(createGraphLinksModel()));
      service.restoreViewState();
      service.restoreViewState();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('restoreViewState should reset the restore timer after deferring auto-fit outside flow view', async () => {
    vi.useFakeTimers();
    getViewState.mockReturnValue(null);
    activeView.set('text');
    const state = service as unknown as {
      pendingAutoFitToContents: boolean;
      restoreViewStateTimer: ReturnType<typeof setTimeout> | null;
    };

    service.setDiagram(createDiagram(createGraphLinksModel()));
    service.restoreViewState();
    await vi.advanceTimersByTimeAsync(200);

    expect(state.pendingAutoFitToContents).toBe(true);
    expect(state.restoreViewStateTimer).toBeNull();
  });

  it('clearTimers should clear all timeout handles when handles are 0', () => {
    const state = service as unknown as {
      viewStateSaveTimer: ReturnType<typeof setTimeout> | null;
      restoreViewStateTimer: ReturnType<typeof setTimeout> | null;
      autoFitTimer: ReturnType<typeof setTimeout> | null;
      initialFitTimer: ReturnType<typeof setTimeout> | null;
    };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    state.viewStateSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    state.restoreViewStateTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    state.autoFitTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    state.initialFitTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    try {
      service.clearTimers();

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(4);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(state.viewStateSaveTimer).toBeNull();
      expect(state.restoreViewStateTimer).toBeNull();
      expect(state.autoFitTimer).toBeNull();
      expect(state.initialFitTimer).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('preserves existing keyed link points while refreshing route data', () => {
    const existingPoints = '0 0 40 20 80 0';
    const model = new go.GraphLinksModel(
      [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '0 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      [
        {
          key: 'root-task-child-task',
          from: 'root-task',
          to: 'child-task',
          isCrossTree: false,
          curviness: 20,
          points: existingPoints,
          fromPortId: '',
          toPortId: '',
        },
      ],
      {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId',
      },
    );
    const diagram = {
      model,
      selection: { each: vi.fn() },
      nodes: { each: vi.fn() },
      clearSelection: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      skipsUndoManager: false,
    } as unknown as go.Diagram;

    service.setDiagram(diagram);

    service.updateDiagram([rootTask, childTask], true);

    const refreshedLink = model.linkDataArray.find(link => link.key === 'root-task-child-task');
    expect(refreshedLink?.points).toBe(existingPoints);
    expect(refreshedLink?.curviness).toBe(20);
  });

  it('clears existing link points when endpoint locations change', () => {
    const existingPoints = '0 0 40 20 80 0';
    buildDiagramData.mockReturnValueOnce({
      nodeDataArray: [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '32 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      linkDataArray: [
        { key: 'root-task-child-task', from: 'root-task', to: 'child-task', isCrossTree: false, curviness: 20 },
      ],
    });
    const model = new go.GraphLinksModel(
      [
        { key: 'root-task', stage: 1, status: 'active', parentId: null, loc: '0 0' },
        { key: 'child-task', stage: 2, status: 'active', parentId: 'root-task', loc: '150 0' },
      ],
      [
        {
          key: 'root-task-child-task',
          from: 'root-task',
          to: 'child-task',
          isCrossTree: false,
          curviness: 20,
          points: existingPoints,
          fromPortId: '',
          toPortId: '',
        },
      ],
      {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId',
      },
    );
    const diagram = {
      model,
      selection: { each: vi.fn() },
      nodes: { each: vi.fn() },
      clearSelection: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      skipsUndoManager: false,
    } as unknown as go.Diagram;

    service.setDiagram(diagram);

    service.updateDiagram([rootTask, childTask], true);

    const refreshedLink = model.linkDataArray.find(link => link.key === 'root-task-child-task');
    expect(refreshedLink?.points).toBeUndefined();
    expect(refreshedLink?.curviness).toBe(20);
  });

  it('refreshes task blocks when only displayId changes after a position update', () => {
    buildDiagramData.mockImplementation((tasks: Task[]) => ({
      nodeDataArray: tasks.map(task => ({
        key: task.id,
        title: task.title,
        displayId: task.displayId,
        stage: task.stage,
        status: task.status,
        parentId: task.parentId,
        loc: `${task.x} ${task.y}`,
      })),
      linkDataArray: [],
    }));
    const model = createGraphLinksModel();

    service.setDiagram(createDiagram(model));
    service.updateDiagram([{ ...rootTask, displayId: '' }], true);
    getLastUpdateType.mockReturnValue('position');
    service.updateDiagram([{ ...rootTask, displayId: '1' }]);

    expect(buildDiagramData).toHaveBeenCalledTimes(2);
    expect(model.nodeDataArray.find(node => node.key === rootTask.id)?.displayId).toBe('1');
  });

  it('keeps position-only updatedAt changes on the lightweight path', () => {
    buildDiagramData.mockImplementation((tasks: Task[]) => ({
      nodeDataArray: tasks.map(task => ({
        key: task.id,
        title: task.title,
        displayId: task.displayId,
        stage: task.stage,
        status: task.status,
        parentId: task.parentId,
        loc: `${task.x} ${task.y}`,
      })),
      linkDataArray: [],
    }));
    const model = createGraphLinksModel();

    service.setDiagram(createDiagram(model));
    service.updateDiagram([rootTask], true);
    getLastUpdateType.mockReturnValue('position');
    service.updateDiagram([{ ...rootTask, updatedAt: '2026-06-01T00:00:01.000Z', x: 120, y: 80 }]);

    expect(buildDiagramData).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when searchable content changes without a displayId change', () => {
    const model = createGraphLinksModel();

    searchQuery.set('needle');
    service.setDiagram(createDiagram(model));
    service.updateDiagram([{ ...rootTask, content: 'old content' }], true);
    getLastUpdateType.mockReturnValue('position');
    service.updateDiagram([{ ...rootTask, content: 'needle content', updatedAt: '2026-06-01T00:00:01.000Z' }]);

    expect(buildDiagramData).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when relation display mode changes without task or connection data changes', () => {
    const model = createGraphLinksModel();

    service.setDiagram(createDiagram(model));
    service.updateDiagram([rootTask, childTask], true);
    service.setRelationDisplayMode('hidden', null);
    service.updateDiagram([rootTask, childTask]);

    expect(buildDiagramData).toHaveBeenCalledTimes(2);
    expect(buildDiagramData).toHaveBeenLastCalledWith(
      [rootTask, childTask],
      project,
      '',
      expect.any(Map),
      { dockedTaskIds: expect.any(Set), focusedTaskId: null },
      { relationDisplayMode: 'hidden', focusedTaskId: null },
      expect.any(Set),
    );
  });

  it('passes remembered expanded sidecar task ids into diagram data builds', () => {
    window.localStorage.setItem('nanoflow.flow-sidecar-expanded.v1.project-1', JSON.stringify([rootTask.id]));
    buildDiagramData.mockImplementationOnce(() => ({
      nodeDataArray: [
        { key: rootTask.id, stage: 1, status: 'active', parentId: null, loc: '0 0', sidecarHasSignals: true },
      ],
      linkDataArray: [],
    }));
    const model = createGraphLinksModel();

    service.setDiagram(createDiagram(model));
    service.updateDiagram([rootTask], true);

    const expandedTaskIds = buildDiagramData.mock.calls.at(-1)?.[6] as ReadonlySet<string>;
    expect(expandedTaskIds.has(rootTask.id)).toBe(true);
  });

  it('toggles sidecar expansion on node data and persists it per project', () => {
    const model = createGraphLinksModel();
    model.nodeDataArray = [
      { key: rootTask.id, sidecarHasSignals: true, sidecarExpanded: false, sidecarRightBadgeItems: [{ id: 'attention-1' }] },
    ];
    const updateTargetBindings = vi.fn();
    const diagram = {
      ...createDiagram(model),
      findNodeForKey: vi.fn(() => ({ updateTargetBindings })),
    } as unknown as go.Diagram;

    service.setDiagram(diagram);

    expect(service.toggleSidecarExpanded(rootTask.id)).toBe(true);
    expect(model.nodeDataArray[0].sidecarExpanded).toBe(true);
    expect(model.nodeDataArray[0].sidecarRightVisible).toBe(true);
    expect(updateTargetBindings).toHaveBeenCalled();
    expect(window.localStorage.getItem('nanoflow.flow-sidecar-expanded.v1.project-1')).toBe(JSON.stringify([rootTask.id]));

    expect(service.toggleSidecarExpanded(rootTask.id)).toBe(false);
    expect(model.nodeDataArray[0].sidecarExpanded).toBe(false);
    expect(model.nodeDataArray[0].sidecarRightVisible).toBe(false);
    expect(window.localStorage.getItem('nanoflow.flow-sidecar-expanded.v1.project-1')).toBeNull();
  });

  it('keeps hidden relation mode on the lightweight path for position-only changes', () => {
    const peerTask = createTask({ id: 'peer-task', title: 'Peer', stage: 2, displayId: '2' });
    const tasks = [rootTask, childTask, peerTask];
    project.connections = [
      { id: 'cross-position-noise', source: rootTask.id, target: peerTask.id, title: 'Hidden relation' } as Connection,
    ];
    buildDiagramData.mockImplementation((nextTasks: Task[]) => ({
      nodeDataArray: nextTasks.map(task => ({
        key: task.id,
        title: task.title,
        displayId: task.displayId,
        stage: task.stage,
        status: task.status,
        parentId: task.parentId,
        loc: `${task.x} ${task.y}`,
      })),
      linkDataArray: [
        { key: `${rootTask.id}-${childTask.id}`, from: rootTask.id, to: childTask.id, isCrossTree: false, curviness: 20 },
      ],
    }));
    const model = createGraphLinksModel();

    service.setDiagram(createDiagram(model));
    service.setRelationDisplayMode('hidden', null);
    service.updateDiagram(tasks, true);
    getLastUpdateType.mockReturnValue('position');
    service.updateDiagram(tasks.map(task =>
      task.id === rootTask.id
        ? { ...task, updatedAt: '2026-06-01T00:00:01.000Z', x: 120, y: 80 }
        : task,
    ));

    expect(buildDiagramData).toHaveBeenCalledTimes(1);
  });

  it('dispose clears relation display and in-memory sidecar expansion state for the next FlowView instance', () => {
    window.localStorage.setItem('nanoflow.flow-sidecar-expanded.v1.project-1', JSON.stringify([rootTask.id]));
    buildDiagramData.mockImplementation((nextTasks: Task[]) => ({
      nodeDataArray: nextTasks.map(task => ({
        key: task.id,
        title: task.title,
        displayId: task.displayId,
        stage: task.stage,
        status: task.status,
        parentId: task.parentId,
        loc: `${task.x} ${task.y}`,
        sidecarHasSignals: task.id === rootTask.id,
      })),
      linkDataArray: [],
    }));
    const firstModel = createGraphLinksModel();
    service.setDiagram(createDiagram(firstModel));
    service.setRelationDisplayMode('hidden', childTask.id);
    service.updateDiagram([rootTask, childTask], true);

    service.dispose();
    window.localStorage.removeItem('nanoflow.flow-sidecar-expanded.v1.project-1');
    buildDiagramData.mockClear();

    service.setDiagram(createDiagram(createGraphLinksModel()));
    service.updateDiagram([rootTask, childTask], true);

    expect(buildDiagramData).toHaveBeenLastCalledWith(
      [rootTask, childTask],
      project,
      '',
      expect.any(Map),
      { dockedTaskIds: expect.any(Set), focusedTaskId: null },
      { relationDisplayMode: 'all', focusedTaskId: null },
      expect.any(Set),
    );
    const expandedTaskIds = buildDiagramData.mock.calls.at(-1)?.[6] as ReadonlySet<string>;
    expect(expandedTaskIds.size).toBe(0);
  });
});
