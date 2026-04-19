import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { SimpleSyncService, TombstoneService } from '../core-bridge';
import { ConflictDetectionService } from './conflict-detection.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { Connection, Project } from '../models';

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

const mockConflictDetectionService = {
  mergeConnections: vi.fn((localConnections: Connection[], remoteConnections: Connection[]) => [
    ...localConnections,
    ...remoteConnections,
  ]),
};

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
        { provide: ConflictDetectionService, useValue: mockConflictDetectionService },
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

  describe('performDeltaSync connection merge', () => {
    it('should reuse connection LWW merge instead of raw replacement', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '本地标题',
          description: '本地描述',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      const mergedConnections: Connection[] = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        title: '本地标题',
        description: '本地描述',
        updatedAt: '2026-04-19T00:00:00.000Z',
      }];

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue(mergedConnections);

      await service.performDeltaSync('project-1');

      expect(mockConflictDetectionService.mergeConnections).toHaveBeenCalledWith(
        currentProject.connections,
        [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }]
      );

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.connections).toEqual(mergedConnections);
    });

    it('should keep deleted connection tombstones in project state', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      const deletedConnections: Connection[] = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        deletedAt: '2026-04-19T00:01:00.000Z',
        updatedAt: '2026-04-19T00:01:00.000Z',
      }];

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: deletedConnections,
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue(deletedConnections);

      await service.performDeltaSync('project-1');

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.connections).toEqual(deletedConnections);
    });
  });
});
