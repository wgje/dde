import { Injector } from '@angular/core';
import { vi, type Mock } from 'vitest';

import type { Connection, Project } from '../models';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskConnectionService } from './task-connection.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';

type MockFn = Mock<(...args: any[]) => any>;

export interface TaskConnectionServiceSpecContext {
  service: TaskConnectionService;
  projectState: {
    activeProject: MockFn;
    getTask: MockFn;
  };
  recorder: {
    recordAndUpdate: MockFn;
    recordAndUpdateDebounced: MockFn;
    recordAndUpdateDurably: MockFn;
  };
}

export interface TaskConnectionServiceSpecHarness {
  getActiveProject(): Project;
  setActiveProject(project: Project): void;
}

export function createProject(connections: Connection[] = []): Project {
  return {
    id: 'proj-1',
    name: 'Project 1',
    description: '',
    createdDate: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    tasks: [
      { id: 'task-1' },
      { id: 'task-2' },
      { id: 'task-3' },
      { id: 'task-4' },
    ] as Project['tasks'],
    connections,
  } as Project;
}

export function createTaskConnectionServiceSpecContext(
  harness: TaskConnectionServiceSpecHarness,
): TaskConnectionServiceSpecContext {
  const projectState = {
    activeProject: vi.fn(() => harness.getActiveProject()),
    getTask: vi.fn((taskId: string) => harness.getActiveProject().tasks.find(task => task.id === taskId) ?? null),
  };

  const recorder = {
    recordAndUpdate: vi.fn((mutator: (project: Project) => Project) => {
      harness.setActiveProject(mutator(harness.getActiveProject()));
    }),
    recordAndUpdateDebounced: vi.fn((mutator: (project: Project) => Project) => {
      harness.setActiveProject(mutator(harness.getActiveProject()));
    }),
    recordAndUpdateDurably: vi.fn(async (mutator: (project: Project) => Project) => {
      harness.setActiveProject(mutator(harness.getActiveProject()));
      return true;
    }),
  };

  const injector = Injector.create({
    providers: [
      { provide: TaskConnectionService, useClass: TaskConnectionService },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        },
      },
      { provide: ProjectStateService, useValue: projectState },
      { provide: TaskRecordTrackingService, useValue: recorder },
    ],
  });

  const context: TaskConnectionServiceSpecContext = {
    service: injector.get(TaskConnectionService),
    projectState,
    recorder,
  };

  return context;
}
