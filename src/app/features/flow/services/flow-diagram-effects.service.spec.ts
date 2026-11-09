import { TestBed } from '@angular/core/testing';
import { Injector, NgZone, signal } from '@angular/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { PreferenceService } from '../../../../services/preference.service';
import { LoggerService } from '../../../../services/logger.service';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import { FlowCommandService } from './flow-command.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowDiagramEffectsService } from './flow-diagram-effects.service';
import type { Task } from '../../../../models';

function createTask(id: string): Task {
  return {
    id,
    title: id,
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: id,
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: null,
  };
}

function restoreOwnProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property);
    return;
  }
  Object.defineProperty(target, property, descriptor);
}

describe('FlowDiagramEffectsService', () => {
  const suiteRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const suiteCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  let service: FlowDiagramEffectsService;
  let diagram: {
    isInitialized: boolean;
    readonly activeProjectId: string | null;
    updateDiagram: ReturnType<typeof vi.fn>;
  };
  let activeProjectId: ReturnType<typeof signal<string | null>>;
  let activeProjectGeneration: number;
  let projectTasks: ReturnType<typeof signal<Task[]>>;
  let flowCommand: FlowCommandService;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let originalRequestAnimationFrameDescriptor: PropertyDescriptor | undefined;
  let originalCancelAnimationFrameDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    activeProjectId = signal<string | null>('project-a');
    activeProjectGeneration = 1;
    projectTasks = signal<Task[]>([createTask('task-1')]);
    diagram = {
      isInitialized: true,
      get activeProjectId() { return activeProjectId(); },
      updateDiagram: vi.fn(() => true),
    };
    rafCallbacks = new Map();
    nextRafId = 1;
    originalRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'requestAnimationFrame',
    );
    originalCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'cancelAnimationFrame',
    );

    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const id = nextRafId++;
        rafCallbacks.set(id, callback);
        return id;
      }),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn((id: number) => {
        rafCallbacks.delete(id);
      }),
    });

    TestBed.configureTestingModule({
      providers: [
        FlowDiagramEffectsService,
        {
          provide: ProjectStateService,
          useValue: {
            activeProjectId,
            tasks: projectTasks,
            activeProject: signal(null),
            captureActiveProjectOwner: () => ({
              projectId: activeProjectId(),
              generation: activeProjectGeneration,
            }),
            isActiveProjectOwnerCurrent: (owner: { projectId: string | null; generation: number }) => (
              owner.projectId === activeProjectId()
              && owner.generation === activeProjectGeneration
            ),
          },
        },
        {
          provide: UiStateService,
          useValue: {
            searchQuery: signal(''),
          },
        },
        {
          provide: PreferenceService,
          useValue: {
            theme: signal('light'),
          },
        },
        {
          provide: FlowDiagramService,
          useValue: diagram,
        },
        FlowCommandService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: NgZone,
          useValue: new NgZone({ enableLongStackTrace: false }),
        },
        {
          provide: ExternalSourceLinkService,
          useValue: {
            activeLinks: signal([]),
          },
        },
      ],
    });

    service = TestBed.inject(FlowDiagramEffectsService);
    flowCommand = TestBed.inject(FlowCommandService);
    vi.spyOn(flowCommand, 'markViewReady');
    rafCallbacks.clear();
  });

  afterEach(() => {
    restoreOwnProperty(
      globalThis,
      'requestAnimationFrame',
      originalRequestAnimationFrameDescriptor,
    );
    restoreOwnProperty(
      globalThis,
      'cancelAnimationFrame',
      originalCancelAnimationFrameDescriptor,
    );
    TestBed.resetTestingModule();
  });

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'))
      .toEqual(suiteRequestAnimationFrameDescriptor);
    expect(Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'))
      .toEqual(suiteCancelAnimationFrameDescriptor);
  });

  function flushNextRaf(): void {
    const next = rafCallbacks.entries().next();
    if (next.done) throw new Error('Expected pending rAF callback');
    const [id, callback] = next.value;
    rafCallbacks.delete(id);
    callback(0);
  }

  it('clears a forced update when the frame is dropped because the view was destroyed', () => {
    let destroyed = true;

    service.scheduleRafDiagramUpdate(projectTasks(), true, () => destroyed);
    flushNextRaf();

    expect(diagram.updateDiagram).not.toHaveBeenCalled();
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();

    destroyed = false;
    service.scheduleRafDiagramUpdate(projectTasks(), false, () => destroyed);
    flushNextRaf();

    expect(diagram.updateDiagram).toHaveBeenCalledWith(projectTasks(), false);
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
  });

  it('clears a forced update when pending rAF work is cancelled during cleanup', () => {
    service.scheduleRafDiagramUpdate(projectTasks(), true, () => false);
    service.cancelPendingRaf();

    service.scheduleRafDiagramUpdate(projectTasks(), false, () => false);
    flushNextRaf();

    expect(diagram.updateDiagram).toHaveBeenCalledWith(projectTasks(), false);
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
  });

  it('schedules a diagram update when only the active project identity changes', () => {
    const injector = TestBed.inject(Injector);
    const scheduleUpdate = vi.fn();
    const effectRef = service.createTasksEffect(injector, scheduleUpdate);
    TestBed.flushEffects();

    expect(scheduleUpdate).toHaveBeenCalledTimes(1);

    activeProjectId.set('project-b');
    TestBed.flushEffects();

    expect(scheduleUpdate).toHaveBeenCalledTimes(2);
    expect(scheduleUpdate).toHaveBeenLastCalledWith(projectTasks(), false);
    effectRef.destroy();
  });

  it('coalesces switched-project updates without publishing readiness from the effect', () => {
    const tasksA = [createTask('task-a')];
    const tasksB = [createTask('task-b')];
    const tasksC = [createTask('task-c')];
    projectTasks.set(tasksA);

    service.scheduleRafDiagramUpdate(tasksA, false, () => false);
    activeProjectId.set('project-b');
    projectTasks.set(tasksB);
    service.scheduleRafDiagramUpdate(tasksB, false, () => false);
    activeProjectId.set('project-c');
    projectTasks.set(tasksC);
    service.scheduleRafDiagramUpdate(tasksC, false, () => false);

    expect(rafCallbacks.size).toBe(1);
    expect(diagram.updateDiagram).not.toHaveBeenCalled();
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();

    flushNextRaf();

    expect(diagram.updateDiagram).toHaveBeenCalledTimes(1);
    expect(diagram.updateDiagram).toHaveBeenCalledWith(tasksC, false);
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
  });

  it('does not mark the current project ready when the diagram update returns false or throws', () => {
    diagram.updateDiagram.mockReturnValueOnce(false);
    service.scheduleRafDiagramUpdate(projectTasks(), false, () => false);
    flushNextRaf();

    diagram.updateDiagram.mockImplementationOnce(() => {
      throw new Error('unexpected update failure');
    });
    service.scheduleRafDiagramUpdate(projectTasks(), false, () => false);

    expect(flushNextRaf).toThrow('unexpected update failure');
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
  });

  it('claims non-destructively and acknowledges the exact command after execution', () => {
    const executeCenterOnNode = vi.fn();
    const claimPending = vi.spyOn(flowCommand, 'claimPendingCenterCommand');
    const acknowledgePending = vi.spyOn(flowCommand, 'acknowledgePendingCenterCommand');
    const centerEffect = service.createCenterCommandEffect(
      TestBed.inject(Injector),
      executeCenterOnNode,
    );
    flowCommand.centerOnNode('task-1', true);
    TestBed.flushEffects();

    expect(claimPending).not.toHaveBeenCalled();
    expect(executeCenterOnNode).not.toHaveBeenCalled();
    expect(flowCommand.centerNodeCommand()).toEqual({ taskId: 'task-1', openDetail: true });

    flowCommand.markViewReady({ projectId: 'project-a', generation: activeProjectGeneration });
    TestBed.flushEffects();
    TestBed.flushEffects();

    expect(claimPending).toHaveBeenCalledOnce();
    expect(acknowledgePending).toHaveBeenCalledOnce();
    expect(executeCenterOnNode).toHaveBeenCalledOnce();
    expect(executeCenterOnNode).toHaveBeenCalledWith('task-1', true);
    expect(flowCommand.centerNodeCommand()).toBeNull();
    centerEffect.destroy();
  });

  it('does not replay a consumed retry command when the effect is recreated', () => {
    const injector = TestBed.inject(Injector);
    const retryInitDiagram = vi.fn();

    const firstEffect = service.createRetryCommandEffect(injector, retryInitDiagram);
    TestBed.flushEffects();

    flowCommand.retryDiagram();
    TestBed.flushEffects();

    expect(retryInitDiagram).toHaveBeenCalledTimes(1);

    firstEffect.destroy();
    const secondEffect = service.createRetryCommandEffect(injector, retryInitDiagram);
    TestBed.flushEffects();

    expect(retryInitDiagram).toHaveBeenCalledTimes(1);

    secondEffect.destroy();
  });
});
