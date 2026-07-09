import { TestBed } from '@angular/core/testing';
import { Injector, NgZone, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('FlowDiagramEffectsService', () => {
  let service: FlowDiagramEffectsService;
  let diagram: {
    isInitialized: boolean;
    updateDiagram: ReturnType<typeof vi.fn>;
  };
  let projectTasks: ReturnType<typeof signal<Task[]>>;
  let retryDiagramCommand: ReturnType<typeof signal<number>>;
  let rafCallbacks: FrameRequestCallback[];
  let nextRafId: number;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    projectTasks = signal<Task[]>([createTask('task-1')]);
    retryDiagramCommand = signal(0);
    diagram = {
      isInitialized: true,
      updateDiagram: vi.fn(),
    };
    rafCallbacks = [];
    nextRafId = 1;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return nextRafId++;
      }),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });

    TestBed.configureTestingModule({
      providers: [
        FlowDiagramEffectsService,
        {
          provide: ProjectStateService,
          useValue: {
            tasks: projectTasks,
            activeProject: signal(null),
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
        {
          provide: FlowCommandService,
          useValue: {
            centerNodeCommand: signal(null),
            retryDiagramCommand,
            clearCenterCommand: vi.fn(),
          },
        },
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
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: originalCancelAnimationFrame,
    });
    TestBed.resetTestingModule();
  });

  function flushNextRaf(): void {
    const callback = rafCallbacks.shift();
    if (!callback) throw new Error('Expected pending rAF callback');
    callback(0);
  }

  it('clears a forced update when the frame is dropped because the view was destroyed', () => {
    let destroyed = true;

    service.scheduleRafDiagramUpdate(projectTasks(), true, () => destroyed);
    flushNextRaf();

    expect(diagram.updateDiagram).not.toHaveBeenCalled();

    destroyed = false;
    service.scheduleRafDiagramUpdate(projectTasks(), false, () => destroyed);
    flushNextRaf();

    expect(diagram.updateDiagram).toHaveBeenCalledWith(projectTasks(), false);
  });

  it('clears a forced update when pending rAF work is cancelled during cleanup', () => {
    service.scheduleRafDiagramUpdate(projectTasks(), true, () => false);
    service.cancelPendingRaf();

    service.scheduleRafDiagramUpdate(projectTasks(), false, () => false);
    flushNextRaf();

    expect(diagram.updateDiagram).toHaveBeenCalledWith(projectTasks(), false);
  });

  it('does not replay a consumed retry command when the effect is recreated', () => {
    const injector = TestBed.inject(Injector);
    const retryInitDiagram = vi.fn();

    const firstEffect = service.createRetryCommandEffect(injector, retryInitDiagram);
    TestBed.flushEffects();

    retryDiagramCommand.set(1);
    TestBed.flushEffects();

    expect(retryInitDiagram).toHaveBeenCalledTimes(1);

    firstEffect.destroy();
    const secondEffect = service.createRetryCommandEffect(injector, retryInitDiagram);
    TestBed.flushEffects();

    expect(retryInitDiagram).toHaveBeenCalledTimes(1);

    secondEffect.destroy();
  });
});
