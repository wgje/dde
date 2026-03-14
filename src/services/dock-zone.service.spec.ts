import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockZoneService } from './dock-zone.service';
import { TaskStore } from '../core-bridge';
import { ProjectStateService } from './project-state.service';
import { DockEntry, DockLane } from '../models/parking-dock';
import { Task } from '../models';

/**
 * Helper: build a minimal DockEntry with required fields.
 * Override any field via `overrides`.
 */
function makeDockEntry(taskId: string, overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    taskId,
    title: overrides.title ?? taskId,
    sourceProjectId: overrides.sourceProjectId ?? null,
    status: overrides.status ?? 'pending_start',
    load: overrides.load ?? 'low',
    expectedMinutes: overrides.expectedMinutes ?? null,
    waitMinutes: overrides.waitMinutes ?? null,
    waitStartedAt: overrides.waitStartedAt ?? null,
    lane: overrides.lane ?? 'combo-select',
    zoneSource: overrides.zoneSource ?? 'auto',
    isMain: overrides.isMain ?? false,
    dockedOrder: overrides.dockedOrder ?? 0,
    manualOrder: overrides.manualOrder,
    detail: overrides.detail ?? '',
    sourceKind: overrides.sourceKind ?? 'project-task',
    systemSelected: overrides.systemSelected ?? false,
    recommendedScore: overrides.recommendedScore ?? null,
    manualMainSelected: overrides.manualMainSelected,
    relationScore: overrides.relationScore,
    relationReason: overrides.relationReason,
    ...overrides,
  };
}

/**
 * Helper: build a minimal Task.
 */
function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: overrides.title ?? id,
    content: overrides.content ?? '',
    stage: overrides.stage ?? null,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 0,
    rank: overrides.rank ?? 1,
    status: overrides.status ?? 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: id,
    deletedAt: null,
    ...overrides,
  };
}

describe('DockZoneService', () => {
  let service: DockZoneService;

  const taskMap = new Map<string, Task>();
  const taskProjectMap = new Map<string, string>();
  const projectConnections = new Map<
    string,
    Array<{ id: string; source: string; target: string; deletedAt?: string | null }>
  >();

  const mockTaskStore = {
    getTask: vi.fn((id: string) => taskMap.get(id) ?? undefined),
    getTaskProjectId: vi.fn((id: string) => taskProjectMap.get(id) ?? null),
    getTasksByProject: vi.fn((projectId: string) =>
      Array.from(taskMap.values()).filter(t => taskProjectMap.get(t.id) === projectId),
    ),
  };

  const mockProjectState = {
    getProject: vi.fn((id: string) => ({
      id,
      name: id,
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: projectConnections.get(id) ?? [],
    })),
  };

  /** Seed a task into the local maps so mocks return it. */
  const seedTask = (id: string, projectId: string, overrides: Partial<Task> = {}): Task => {
    const task = makeTask(id, overrides);
    taskMap.set(id, task);
    taskProjectMap.set(id, projectId);
    return task;
  };

  const seedConnection = (projectId: string, source: string, target: string): void => {
    const list = projectConnections.get(projectId) ?? [];
    list.push({ id: `${source}->${target}`, source, target, deletedAt: null });
    projectConnections.set(projectId, list);
  };

  beforeEach(() => {
    taskMap.clear();
    taskProjectMap.clear();
    projectConnections.clear();
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        DockZoneService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStateService, useValue: mockProjectState },
      ],
    });

    service = TestBed.inject(DockZoneService);
  });

  // --------------------------------------------------------------------------
  // resolveSourceProjectId
  // --------------------------------------------------------------------------
  describe('resolveSourceProjectId', () => {
    it('returns entry.sourceProjectId when present', () => {
      const entry = makeDockEntry('t1', { sourceProjectId: 'proj-A' });
      const result = service.resolveSourceProjectId(entry);
      expect(result).toBe('proj-A');
    });

    it('falls back to taskStore.getTaskProjectId when entry has no sourceProjectId', () => {
      taskProjectMap.set('t2', 'proj-B');
      const entry = makeDockEntry('t2', { sourceProjectId: null });
      const result = service.resolveSourceProjectId(entry);
      expect(result).toBe('proj-B');
      expect(mockTaskStore.getTaskProjectId).toHaveBeenCalledWith('t2');
    });
  });

  // --------------------------------------------------------------------------
  // pickReferenceMainEntry
  // --------------------------------------------------------------------------
  describe('pickReferenceMainEntry', () => {
    it('returns the first isMain entry', () => {
      const entries: DockEntry[] = [
        makeDockEntry('t1', { isMain: false, dockedOrder: 0 }),
        makeDockEntry('t2', { isMain: true, dockedOrder: 1 }),
        makeDockEntry('t3', { isMain: true, dockedOrder: 2 }),
      ];
      const result = service.pickReferenceMainEntry(undefined, entries);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('t2');
    });

    it('excludes specified taskId', () => {
      const entries: DockEntry[] = [
        makeDockEntry('t1', { isMain: true, dockedOrder: 0 }),
        makeDockEntry('t2', { isMain: true, dockedOrder: 1 }),
      ];
      const result = service.pickReferenceMainEntry('t1', entries);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('t2');
    });

    it('returns null when no main entries exist', () => {
      const entries: DockEntry[] = [
        makeDockEntry('t1', { isMain: false }),
        makeDockEntry('t2', { isMain: false }),
      ];
      const result = service.pickReferenceMainEntry(undefined, entries);
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // buildAdjacencyFingerprint
  // --------------------------------------------------------------------------
  describe('buildAdjacencyFingerprint', () => {
    it('produces stable fingerprints regardless of task order', () => {
      const taskA = makeTask('a', { parentId: 'root' });
      const taskB = makeTask('b', { parentId: 'root' });

      const fp1 = service.buildAdjacencyFingerprint([taskA, taskB]);
      const fp2 = service.buildAdjacencyFingerprint([taskB, taskA]);
      expect(fp1).toBe(fp2);
      expect(fp1.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // inferAutoLaneForTask
  // --------------------------------------------------------------------------
  describe('inferAutoLaneForTask', () => {
    it('assigns combo-select for directly connected tasks', () => {
      const mainTask = seedTask('main-1', 'proj-1');
      const candidateTask = seedTask('cand-1', 'proj-1', { parentId: 'main-1' });
      seedConnection('proj-1', 'main-1', 'cand-1');

      const entries: DockEntry[] = [
        makeDockEntry('main-1', {
          isMain: true,
          sourceProjectId: 'proj-1',
          dockedOrder: 0,
        }),
      ];

      const result = service.inferAutoLaneForTask(candidateTask, 'proj-1', undefined, entries);
      expect(result.lane).toBe('combo-select' as DockLane);
      expect(result.relationScore).toBeGreaterThanOrEqual(50);
      expect(result.relationReason).toContain('auto:');
    });

    it('assigns backup for unconnected cross-project tasks', () => {
      seedTask('main-1', 'proj-1');
      const foreignTask = seedTask('foreign-1', 'proj-2');

      const entries: DockEntry[] = [
        makeDockEntry('main-1', {
          isMain: true,
          sourceProjectId: 'proj-1',
          dockedOrder: 0,
        }),
      ];

      const result = service.inferAutoLaneForTask(foreignTask, 'proj-2', undefined, entries);
      expect(result.lane).toBe('backup' as DockLane);
    });
  });
});
