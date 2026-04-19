import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { SimpleSyncService, TombstoneService } from '../core-bridge';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { Project } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockSimpleSyncService = {
  checkForDrift: vi.fn(),
};

const mockConflictResolutionService = {};

const mockProjectStateService = {
  getProject: vi.fn(),
  updateProjects: vi.fn(),
};

const mockTombstoneService = {
  getLocalTombstones: vi.fn(() => new Set<string>()),
};

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    tasks: [],
    connections: [],
    createdDate: '2026-04-18T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('DeltaSyncCoordinatorService', () => {
  let service: DeltaSyncCoordinatorService;

  beforeEach(() => {
    vi.clearAllMocks();

    const injector = Injector.create({
      providers: [
        DeltaSyncCoordinatorService,
        { provide: SimpleSyncService, useValue: mockSimpleSyncService },
        { provide: ConflictResolutionService, useValue: mockConflictResolutionService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: TombstoneService, useValue: mockTombstoneService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(DeltaSyncCoordinatorService));
  });

  describe('hasProjectContentDifference', () => {
    it('should detect connection title or description changes with the same counts', () => {
      const project1 = createProject({
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '旧标题',
          description: '旧描述',
        }],
      });
      const project2 = createProject({
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '新标题',
          description: '新描述',
        }],
      });

      expect(service.hasProjectContentDifference(project1, project2)).toBe(true);
    });

    it('should not report a difference when connection content is unchanged', () => {
      const connections = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        title: '标题',
        description: '描述',
        deletedAt: undefined,
      }];

      const project1 = createProject({ connections });
      const project2 = createProject({ connections: [{ ...connections[0] }] });

      expect(service.hasProjectContentDifference(project1, project2)).toBe(false);
    });
  });
});