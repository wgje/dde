import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';
import { createRequire } from 'node:module';

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

const realGo = createRequire(import.meta.url)('gojs/release/go.js') as typeof import('gojs');

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
  const model = new realGo.GraphLinksModel([], [], {
    linkKeyProperty: 'key',
    nodeKeyProperty: 'key',
    linkFromPortIdProperty: 'fromPortId',
    linkToPortIdProperty: 'toPortId',
  });
  (model as unknown as { skipsUndoManager: boolean }).skipsUndoManager = false;
  model.undoManager.isEnabled = false;
  return model;
}

type TestDiagram = go.Diagram & {
  emitLayoutCompleted: () => void;
  latestLayoutListener: () => ((event: go.DiagramEvent) => void) | undefined;
  layoutListenerCount: () => number;
};

function createDiagram(model: go.GraphLinksModel): TestDiagram {
  const layoutListeners = new Set<(event: go.DiagramEvent) => void>();
  const diagram = {
    model,
    selection: { each: vi.fn() },
    nodes: { each: vi.fn() },
    clearSelection: vi.fn(),
    findNodeForKey: vi.fn(() => null),
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    skipsUndoManager: false,
    scale: 1,
    position: new go.Point(0, 0),
    documentBounds: new go.Rect(0, 0, 300, 200),
    viewportBounds: new go.Rect(0, 0, 600, 400),
    addDiagramListener: vi.fn((name: string, listener: (event: go.DiagramEvent) => void) => {
      if (name === 'LayoutCompleted') layoutListeners.add(listener);
    }),
    removeDiagramListener: vi.fn((name: string, listener: (event: go.DiagramEvent) => void) => {
      if (name === 'LayoutCompleted') layoutListeners.delete(listener);
    }),
    emitLayoutCompleted: () => [...layoutListeners].forEach(listener => listener({ diagram } as unknown as go.DiagramEvent)),
    latestLayoutListener: () => [...layoutListeners].at(-1),
    layoutListenerCount: () => layoutListeners.size,
  };
  return diagram as unknown as TestDiagram;
}

function applyFitToContents(owner: { diagram: go.Diagram }): void {
  const { diagram } = owner;
  const documentBounds = diagram.documentBounds;
  const viewportBounds = diagram.viewportBounds;
  const scale = Math.max(0.3, Math.min(1.5, Math.min(
    viewportBounds.width / (documentBounds.width + 100),
    viewportBounds.height / (documentBounds.height + 100),
  )));
  const width = viewportBounds.width / scale;
  const height = viewportBounds.height / scale;
  const center = documentBounds.center;
  const fittedViewport = new go.Rect(center.x - width / 2, center.y - height / 2, width, height);
  diagram.scale = scale;
  diagram.position = new go.Point(fittedViewport.x, fittedViewport.y);
  (diagram as unknown as { viewportBounds: go.Rect }).viewportBounds = fittedViewport;
}

describe('FlowDiagramDataService', () => {
  let service: FlowDiagramDataService;
  let buildDiagramData: ReturnType<typeof vi.fn>;
  let getLastUpdateType: ReturnType<typeof vi.fn>;
  let getViewState: ReturnType<typeof vi.fn>;
  let activeProject: ReturnType<typeof signal<Project | null>>;
  let activeProjectId: ReturnType<typeof signal<string | null>>;
  let activeProjectGeneration: number;
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
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    window.localStorage.clear();
    project.connections = [];
    getLastUpdateType = vi.fn(() => 'content');
    getViewState = vi.fn(() => activeProject()?.viewState ?? null);
    activeProject = signal<Project | null>(project);
    activeProjectId = signal<string | null>('project-1');
    activeProjectGeneration = 1;
    activeView = signal<'text' | 'flow'>('flow');
    updateViewState = vi.fn();
    markLocalChanges = vi.fn();
    schedulePersist = vi.fn();
    fitToContents = vi.fn(applyFitToContents);
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
            activeProject,
            activeProjectId,
            captureActiveProjectOwner: () => ({
              projectId: activeProjectId(),
              generation: activeProjectGeneration,
            }),
            isActiveProjectOwnerCurrent: (owner: { projectId: string | null; generation: number }) => (
              owner.projectId === activeProjectId()
              && owner.generation === activeProjectGeneration
            ),
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
        { provide: FlowZoomService, useValue: { fitToContents, cancelPendingViewStateSave: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
      ],
    });

    service = TestBed.inject(FlowDiagramDataService);
  });

  function switchProject(id: string, viewState: Project['viewState']): Project {
    const next = { ...project, id, name: id, viewState };
    activeProject.set(next);
    if (activeProjectId() !== id) activeProjectGeneration += 1;
    activeProjectId.set(id);
    return next;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns false when the diagram or active project context is missing', () => {
    expect(service.updateDiagram([rootTask], true)).toBe(false);

    service.setDiagram(createDiagram(createGraphLinksModel()));
    activeProject.set(null);

    expect(service.updateDiagram([rootTask], true)).toBe(false);
  });

  it('returns false when diagram data construction fails', () => {
    service.setDiagram(createDiagram(createGraphLinksModel()));
    buildDiagramData.mockImplementation(() => {
      throw new Error('diagram merge failed');
    });

    expect(service.updateDiagram([rootTask], true)).toBe(false);
  });

  it('prepares readiness only for a real same-project model rebuild', () => {
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
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    const readiness = (service as unknown as {
      viewportReadiness: { beginProjectUpdate: () => boolean };
    }).viewportReadiness;
    const prepare = vi.spyOn(readiness, 'beginProjectUpdate');

    expect(service.updateDiagram([rootTask], true)).toBe(true);
    diagram.emitLayoutCompleted();
    prepare.mockClear();
    expect(service.updateDiagram([rootTask])).toBe(true);
    expect(prepare).not.toHaveBeenCalled();

    getLastUpdateType.mockReturnValue('position');
    expect(service.updateDiagram([{
      ...rootTask,
      updatedAt: '2026-06-01T00:00:01.000Z',
      x: 120,
      y: 80,
    }])).toBe(true);
    expect(prepare).not.toHaveBeenCalled();

    expect(service.updateDiagram([{ ...rootTask, title: 'Changed title' }])).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(buildDiagramData).toHaveBeenCalledTimes(2);
  });

  it('cross-project identical fingerprints rebuild once, then same-project update skips without reapplying viewport', () => {
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    service.updateDiagram([rootTask], true);
    diagram.emitLayoutCompleted();
    diagram.scale = 1.6;

    switchProject('project-b', { scale: 1.8, positionX: 80, positionY: 40 });
    service.updateDiagram([rootTask]);
    diagram.emitLayoutCompleted();
    expect(buildDiagramData).toHaveBeenCalledTimes(2);
    diagram.scale = 1.7;
    service.updateDiagram([rootTask]);
    expect(buildDiagramData).toHaveBeenCalledTimes(2);
    expect(diagram.scale).toBe(1.7);
  });
  it('position-only cross-project update rebuilds while a later same-project position update skips', () => {
    buildDiagramData.mockImplementation((tasks: Task[]) => ({
      nodeDataArray: tasks.map(task => ({ key: task.id, title: task.title, displayId: task.displayId, stage: task.stage, status: task.status, parentId: task.parentId, loc: `${task.x} ${task.y}` })), linkDataArray: [],
    }));
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    service.updateDiagram([rootTask], true);
    diagram.emitLayoutCompleted();
    getLastUpdateType.mockReturnValue('position');
    switchProject('project-b', undefined);
    service.updateDiagram([{ ...rootTask, x: 10, updatedAt: 'b-1' }]);
    diagram.emitLayoutCompleted();
    service.updateDiagram([{ ...rootTask, x: 20, updatedAt: 'b-2' }]);
    expect(buildDiagramData).toHaveBeenCalledTimes(2);
  });
  it('restores B after settlement without overwriting a newer same-project recovery viewport', () => {
    const diagram = createDiagram(createGraphLinksModel()); service.setDiagram(diagram);
    service.updateDiagram([rootTask], true); diagram.emitLayoutCompleted();
    const projectB = switchProject('project-b', { scale: 1.8, positionX: 80, positionY: 40 });
    buildDiagramData.mockImplementationOnce(() => {
      projectB.viewState = { scale: 2.4, positionX: 240, positionY: 120 };
      return { nodeDataArray: [{ key: rootTask.id, loc: '0 0' }], linkDataArray: [] };
    });
    service.updateDiagram([rootTask]);
    expect(diagram.scale).not.toBe(1.8); expect(diagram.layoutListenerCount()).toBe(1);
    diagram.emitLayoutCompleted();
    expect({ scale: diagram.scale, x: diagram.position.x, y: diagram.position.y }).toEqual({ scale: 1.8, x: 80, y: 40 });
    expect(diagram.layoutListenerCount()).toBe(0); expect(diagram.removeDiagramListener).toHaveBeenCalled();
    service.restoreViewState();
    diagram.scale = 3; diagram.position = new go.Point(300, 150); diagram.emitLayoutCompleted();
    expect({ scale: diagram.scale, x: diagram.position.x, y: diagram.position.y }).toEqual({ scale: 3, x: 300, y: 150 });
  });
  it('gives a no-state B exactly one project-owned fallback fit after layout settlement', () => {
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    service.updateDiagram([rootTask], true);
    diagram.emitLayoutCompleted();
    fitToContents.mockClear();
    switchProject('project-b', undefined);
    service.updateDiagram([rootTask]);
    (diagram as unknown as { documentBounds: go.Rect }).documentBounds = new go.Rect(0, 0, 0, 0); diagram.emitLayoutCompleted();
    expect(fitToContents).not.toHaveBeenCalled(); expect(diagram.layoutListenerCount()).toBe(1);
    (diagram as unknown as { documentBounds: go.Rect }).documentBounds = new go.Rect(0, 0, 300, 200);
    diagram.emitLayoutCompleted();
    expect(fitToContents).toHaveBeenCalledTimes(1);
    expect(fitToContents.mock.calls[0]?.[0]).toMatchObject({ projectId: 'project-b', diagram });
    expect(diagram.layoutListenerCount()).toBe(0); diagram.emitLayoutCompleted(); expect(fitToContents).toHaveBeenCalledTimes(1);
  });
  it('data save copies the latest same-project invocation and cancels after project generation changes', () => {
    vi.useFakeTimers();
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    service.updateDiagram([rootTask], true);
    diagram.emitLayoutCompleted();
    vi.advanceTimersByTime(16);
    diagram.scale = 1.2; diagram.position = new go.Point(12, 24); service.saveViewState();
    diagram.scale = 1.4; diagram.position = new go.Point(14, 28); service.saveViewState();
    diagram.scale = 2.8; diagram.position = new go.Point(280, 560);
    vi.advanceTimersByTime(1000);
    expect(updateViewState).toHaveBeenLastCalledWith('project-1', { scale: 1.4, positionX: 14, positionY: 28 });
    updateViewState.mockClear();
    service.saveViewState();
    switchProject('project-b', undefined); service.updateDiagram([rootTask]);
    vi.advanceTimersByTime(1000);
    expect(updateViewState).not.toHaveBeenCalled();
  });
  it('retires stale restore, initial-fit, and layout callbacks when a project transition begins', () => {
    vi.useFakeTimers();
    switchProject('project-a', undefined);
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    service.updateDiagram([rootTask], true);
    const staleLayout = diagram.latestLayoutListener();
    service.restoreViewState();
    switchProject('project-b', undefined); service.updateDiagram([rootTask]);
    vi.advanceTimersByTime(500);
    staleLayout?.({ diagram } as unknown as go.DiagramEvent);
    expect(fitToContents).not.toHaveBeenCalled();
    diagram.emitLayoutCompleted();
    expect(fitToContents).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2])('fences stale flow-activation rAF stage %s by project generation', stage => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => (callbacks.push(callback), callbacks.length)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    switchProject('project-a', undefined);
    activeView.set('text');
    const diagram = createDiagram(createGraphLinksModel()); service.setDiagram(diagram); service.updateDiagram([rootTask], true);
    diagram.emitLayoutCompleted();
    expect(fitToContents).not.toHaveBeenCalled();
    activeView.set('flow');
    service.onFlowActivated();
    if (stage === 2) callbacks.shift()?.(0);
    switchProject('project-b', undefined); service.updateDiagram([rootTask]);
    callbacks.shift()?.(0);
    callbacks.shift()?.(0);
    expect(fitToContents).not.toHaveBeenCalled();
  });
  it('A to B to A restores each state while the first A callback remains invalid', () => {
    const diagram = createDiagram(createGraphLinksModel()); service.setDiagram(diagram);
    switchProject('project-a', { scale: 1.1, positionX: 11, positionY: 11 }); service.updateDiagram([rootTask], true);
    const staleA = diagram.latestLayoutListener();
    switchProject('project-b', { scale: 1.5, positionX: 50, positionY: 50 }); service.updateDiagram([rootTask]); diagram.emitLayoutCompleted();
    switchProject('project-a', { scale: 1.9, positionX: 19, positionY: 19 }); service.updateDiagram([rootTask]); diagram.emitLayoutCompleted();
    staleA?.({ diagram } as unknown as go.DiagramEvent);
    expect({ scale: diagram.scale, x: diagram.position.x }).toEqual({ scale: 1.9, x: 19 });
  });
  it('rejects a missing boundary, rolls back a late merge failure, and retries transactionally', () => {
    const model = createGraphLinksModel();
    const diagram = createDiagram(model);
    service.setDiagram(diagram);
    const mergeNodes = vi.spyOn(model, 'mergeNodeDataArray');
    let start = (model.startTransaction = vi.fn(() => true));
    const readinessCommit = vi.spyOn((service as unknown as { viewportReadiness: { commitProjectUpdate: () => boolean } }).viewportReadiness, 'commitProjectUpdate');
    Object.defineProperty(model.undoManager, 'historyIndex', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(service.updateDiagram([rootTask], true)).toBe(false);
    expect([mergeNodes, start, readinessCommit].map(spy => spy.mock.calls.length).concat(model.nodeDataArray.length, model.linkDataArray.length)).toEqual([0, 0, 0, 0, 0]);
    delete (model as unknown as Record<string, unknown>).startTransaction;
    start = vi.spyOn(model, 'startTransaction');
    delete (model.undoManager as unknown as { historyIndex?: number }).historyIndex;
    expect(service.updateDiagram([rootTask], true)).toBe(true);
    diagram.emitLayoutCompleted();
    model.nodeDataArray.push({ key: 'stale-node', loc: '300 0' });
    model.linkDataArray.push({ key: 'stale-link', from: 'root-task', to: 'stale-node' });
    model.linkDataArray.find(link => link.key === 'root-task-child-task')!.points = '0 0 40 20 80 0';
    model.nodeDataArray.find(node => node.key === 'root-task')!.loc = '25 0';
    const arrays = [model.nodeDataArray, model.linkDataArray] as const;
    const records = [arrays[0].slice(), arrays[1].slice()] as const;
    const properties = records.map(group => group.map(record => Object.entries(record)));
    switchProject('project-b', { scale: 1.8, positionX: 80, positionY: 40 });
    start.mockClear();
    const mergeLinkDataArray = model.mergeLinkDataArray.bind(model);
    const mergeLinks = vi.spyOn(model, 'mergeLinkDataArray').mockImplementationOnce(data => {
      mergeLinkDataArray(data);
      model.linkDataArray.find(link => link.key === 'root-task-child-task')!.points = 'discarded';
    });
    const setProperty = vi.spyOn(model, 'setDataProperty');
    const removeNode = vi.spyOn(model, 'removeNodeData');
    const removeLinkData = model.removeLinkData.bind(model);
    const removeLink = vi.spyOn(model, 'removeLinkData').mockImplementationOnce(data => {
      removeLinkData(data);
      model.setDataProperty(records[0][0], 'loc', 'mutated');
      model.setDataProperty(records[0][0], 'stage', 99);
      throw new Error('late stale-link failure');
    });
    const commit = vi.spyOn(model, 'commitTransaction');
    const rollback = vi.spyOn(model, 'rollbackTransaction');
    const boundary = () => [model.undoManager.isEnabled, model.undoManager.maxHistoryLength, model.undoManager.history.count, model.undoManager.historyIndex, model.undoManager.transactionLevel, model.undoManager.currentTransaction, diagram.skipsUndoManager, model.skipsUndoManager];
    expect(service.updateDiagram([rootTask], true)).toBe(false);
    expect([mergeNodes, mergeLinks, removeNode, removeLink, start, commit, rollback].map(spy => spy.mock.calls.length)).toEqual([2, 1, 1, 1, 1, 0, 1]);
    expect(setProperty).toHaveBeenCalled();
    expect(boundary()).toEqual([false, 999, 0, -1, 0, null, false, false]);
    expect([model.nodeDataArray, model.linkDataArray].every((array, group) => array === arrays[group] && array.length === records[group].length && array.every((record, index) => record === records[group][index]))).toBe(true);
    expect([model.nodeDataArray, model.linkDataArray].map(array => array.map(record => Object.entries(record)))).toEqual(properties);
    removeLink.mockRestore();
    expect(service.updateDiagram([rootTask])).toBe(true);
    expect([[start, commit, rollback].map(spy => spy.mock.calls.length), boundary()]).toEqual([[2, 1, 1], [false, 999, 0, -1, 0, null, false, false]]);
  });
  it('aborts the prepared boundary when readiness rejects commit after mutation', () => {
    const diagram = createDiagram(createGraphLinksModel());
    service.setDiagram(diagram);
    const readiness = (service as unknown as {
      viewportReadiness: { commitProjectUpdate: () => boolean };
    }).viewportReadiness;
    vi.spyOn(readiness, 'commitProjectUpdate').mockReturnValueOnce(false);

    expect(service.updateDiagram([rootTask], true)).toBe(false);
    expect(diagram.layoutListenerCount()).toBe(0);
  });
  it('switching to C rejects an unfinished B layout callback and persists no B viewport into C', () => {
    const diagram = createDiagram(createGraphLinksModel()); service.setDiagram(diagram); service.updateDiagram([rootTask], true);
    switchProject('project-b', { scale: 1.5, positionX: 50, positionY: 50 }); service.updateDiagram([rootTask]);
    const staleB = diagram.latestLayoutListener();
    switchProject('project-c', { scale: 2.1, positionX: 210, positionY: 210 }); service.updateDiagram([rootTask]);
    staleB?.({ diagram } as unknown as go.DiagramEvent);
    expect(diagram.scale).not.toBe(1.5);
    diagram.emitLayoutCompleted();
    expect({ scale: diagram.scale, x: diagram.position.x }).toEqual({ scale: 2.1, x: 210 });
  });

  it('销毁后旧 layout settlement 回调不应操作重新挂载的新 Diagram', () => {
    getViewState.mockReturnValue(null);
    const firstDiagram = createDiagram(createGraphLinksModel());
    const secondDiagram = createDiagram(createGraphLinksModel());

    service.setDiagram(firstDiagram);
    service.updateDiagram([rootTask], true);
    const staleLayout = firstDiagram.latestLayoutListener();
    service.dispose();
    service.setDiagram(secondDiagram);
    staleLayout?.({ diagram: firstDiagram } as unknown as go.DiagramEvent);

    expect(fitToContents).not.toHaveBeenCalled();
  });

  it('preserves existing keyed link points while refreshing route data', () => {
    const existingPoints = '0 0 40 20 80 0';
    const model = new realGo.GraphLinksModel(
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
    (model as unknown as { skipsUndoManager: boolean }).skipsUndoManager = false;
    const diagram = {
      model,
      selection: { each: vi.fn() },
      nodes: { each: vi.fn() },
      clearSelection: vi.fn(),
      addDiagramListener: vi.fn(),
      removeDiagramListener: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      skipsUndoManager: false,
    } as unknown as go.Diagram;

    service.setDiagram(diagram);

    expect(service.updateDiagram([rootTask, childTask], true)).toBe(true);

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
    const model = new realGo.GraphLinksModel(
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
    (model as unknown as { skipsUndoManager: boolean }).skipsUndoManager = false;
    const diagram = {
      model,
      selection: { each: vi.fn() },
      nodes: { each: vi.fn() },
      clearSelection: vi.fn(),
      addDiagramListener: vi.fn(),
      removeDiagramListener: vi.fn(),
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

    const diagram = createDiagram(model);
    service.setDiagram(diagram);
    service.updateDiagram([rootTask], true);
    diagram.emitLayoutCompleted();
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

    const diagram = createDiagram(model);
    service.setDiagram(diagram);
    service.setRelationDisplayMode('hidden', null);
    service.updateDiagram(tasks, true);
    diagram.emitLayoutCompleted();
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
