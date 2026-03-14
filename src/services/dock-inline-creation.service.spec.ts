import { TestBed } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DockInlineCreationService,
  DockInlineCreationContext,
} from './dock-inline-creation.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ProjectStateService } from './project-state.service';
import { PARKING_CONFIG } from '../config/parking.config';
import { DockEntry, DockPendingDecision } from '../models/parking-dock';

// ---------------------------------------------------------------------------
//  Helper: build a minimal DockEntry with sensible defaults
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
  return {
    title: overrides.taskId,
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 25,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'auto',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Mock services
// ---------------------------------------------------------------------------

const mockBlackBox = {
  create: vi.fn().mockReturnValue({
    ok: true,
    value: { id: 'bb-entry-1' },
  }),
  markAsCompleted: vi.fn().mockReturnValue({ ok: true, value: { id: 'bb-entry-1' } }),
  archive: vi.fn().mockReturnValue({ ok: true, value: { id: 'bb-entry-1' } }),
};

const mockCategoryLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  category: vi.fn().mockReturnValue(mockCategoryLogger),
};

const mockToast = {
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
};

const mockTaskOps = {
  addTask: vi.fn().mockReturnValue({ ok: true, value: 'new-task-id' }),
  updateTaskExpectedMinutes: vi.fn(),
  updateTaskCognitiveLoad: vi.fn(),
  updateTaskWaitMinutes: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockProjectState = {
  activeProjectId: vi.fn().mockReturnValue('proj-1'),
};

// ---------------------------------------------------------------------------
//  Build a minimal DockInlineCreationContext from writable signals
// ---------------------------------------------------------------------------

function buildContext(initial?: {
  entries?: DockEntry[];
  dockedCount?: number;
}): {
  ctx: DockInlineCreationContext;
  entries: ReturnType<typeof signal<DockEntry[]>>;
  setMainTask: ReturnType<typeof vi.fn>;
  rebalanceAutoZones: ReturnType<typeof vi.fn>;
} {
  const entries = signal<DockEntry[]>(initial?.entries ?? []);
  const dockedCountOverride = initial?.dockedCount;
  const dockedCount = dockedCountOverride !== undefined
    ? computed(() => dockedCountOverride)
    : computed(() => entries().length);
  const setMainTask = vi.fn();
  const rebalanceAutoZones = vi.fn();

  const ctx: DockInlineCreationContext = {
    entries,
    dockedCount,
    focusSessionContext: signal<{ id: string; startedAt: number } | null>(null),
    softLimitNoticeShown: signal(false),
    muteWaitTone: signal(false),
    firstDragIntervened: signal(false),
    firstMainSelectionWindow: signal<{ taskId: string; expiresAt: number } | null>(null),
    suspendChainRootTaskId: signal<string | null>(null),
    pendingDecision: signal<DockPendingDecision | null>(null),
    highlightedIds: signal<Set<string>>(new Set()),
    waitEndNotifiedIds: new Set<string>(),
    setMainTask,
    rebalanceAutoZones,
  };

  return { ctx, entries, setMainTask, rebalanceAutoZones };
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

describe('DockInlineCreationService', () => {
  let service: DockInlineCreationService;
  let entries: ReturnType<typeof signal<DockEntry[]>>;
  let setMainTask: ReturnType<typeof vi.fn>;
  let rebalanceAutoZones: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        DockInlineCreationService,
        { provide: BlackBoxService, useValue: mockBlackBox },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: ProjectStateService, useValue: mockProjectState },
      ],
    });

    service = TestBed.inject(DockInlineCreationService);

    const built = buildContext();
    entries = built.entries;
    setMainTask = built.setMainTask;
    rebalanceAutoZones = built.rebalanceAutoZones;
    service.init(built.ctx);
  });

  // =========================================================================
  //  1. ensureDockCapacity — under hard limit
  // =========================================================================

  describe('ensureDockCapacity', () => {
    it('should return true when under hard limit', () => {
      // Default context has 0 entries → well below hard limit
      const result = service.ensureDockCapacity('Test Task');
      expect(result).toBe(true);
      expect(mockToast.warning).not.toHaveBeenCalled();
    });

    // =========================================================================
    //  2. ensureDockCapacity — at hard limit → toast warning
    // =========================================================================

    it('should return false at hard limit and show toast', () => {
      const hardLimit = PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT;

      // Rebuild context with dockedCount at hard limit
      const built = buildContext({ dockedCount: hardLimit });
      entries = built.entries;
      service.init(built.ctx);

      const result = service.ensureDockCapacity('Blocked Task');
      expect(result).toBe(false);
      expect(mockToast.warning).toHaveBeenCalledWith(
        '停泊坞已满',
        expect.stringContaining('Blocked Task'),
      );
    });
  });

  // =========================================================================
  //  3. createInDock — adds an entry
  // =========================================================================

  describe('createInDock', () => {
    it('should add an entry to the entries signal', () => {
      const taskId = service.createInDock('My Task', 'backup');

      expect(taskId).toBeTypeOf('string');
      expect(taskId).not.toBeNull();

      const current = entries();
      expect(current).toHaveLength(1);
      expect(current[0].title).toBe('My Task');
      expect(current[0].lane).toBe('backup');
      expect(current[0].sourceKind).toBe('dock-created');
      expect(current[0].status).toBe('pending_start');
    });

    // =========================================================================
    //  4. createInDock — returns null when capacity exceeded
    // =========================================================================

    it('should return null when capacity exceeded', () => {
      const hardLimit = PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT;
      const built = buildContext({ dockedCount: hardLimit });
      entries = built.entries;
      service.init(built.ctx);

      const taskId = service.createInDock('Overflow Task', 'combo-select');
      expect(taskId).toBeNull();
      // entries should remain empty
      expect(built.entries()).toHaveLength(0);
    });
  });

  // =========================================================================
  //  5. getInlineArchiveCandidates — only dock-created entries
  // =========================================================================

  describe('getInlineArchiveCandidates', () => {
    it('should return only dock-created entries', () => {
      const built = buildContext({
        entries: [
          makeEntry({ taskId: 'proj-1', sourceKind: 'project-task' }),
          makeEntry({ taskId: 'inline-1', sourceKind: 'dock-created', status: 'completed' }),
          makeEntry({ taskId: 'proj-2', sourceKind: 'project-task' }),
          makeEntry({ taskId: 'inline-2', sourceKind: 'dock-created', status: 'pending_start' }),
        ],
      });
      service.init(built.ctx);

      const candidates = service.getInlineArchiveCandidates();
      expect(candidates).toHaveLength(2);
      expect(candidates.map(c => c.taskId)).toEqual(['inline-1', 'inline-2']);
    });
  });

  // =========================================================================
  //  6. archiveInlineEntriesToActiveProject — creates tasks in project
  // =========================================================================

  describe('archiveInlineEntriesToActiveProject', () => {
    it('should create tasks in project for dock-created entries', () => {
      const built = buildContext({
        entries: [
          makeEntry({
            taskId: 'inline-1',
            title: 'Inline Task 1',
            sourceKind: 'dock-created',
            status: 'pending_start',
            sourceBlackBoxEntryId: 'bb-1',
            inlineArchiveStatus: 'pending',
          }),
        ],
      });
      service.init(built.ctx);

      mockTaskOps.addTask.mockReturnValue({ ok: true, value: 'created-task-1' });

      const result = service.archiveInlineEntriesToActiveProject();

      expect(result.converted).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockTaskOps.addTask).toHaveBeenCalledWith(
        'Inline Task 1',
        '',
        null,
        null,
        false,
      );
      expect(built.rebalanceAutoZones).toHaveBeenCalled();

      // Entry should be rewritten with the new task id
      const updated = built.entries().find(e => e.taskId === 'created-task-1');
      expect(updated).toBeDefined();
      expect(updated!.sourceKind).toBe('project-task');
      expect(updated!.inlineArchiveStatus).toBe('archived');
    });

    it('should return {0,0} when no dock-created entries exist', () => {
      const built = buildContext({
        entries: [makeEntry({ taskId: 'proj-1', sourceKind: 'project-task' })],
      });
      service.init(built.ctx);

      const result = service.archiveInlineEntriesToActiveProject();
      expect(result).toEqual({ converted: 0, failed: 0 });
      expect(mockTaskOps.addTask).not.toHaveBeenCalled();
    });

    it('should mark entries as failed when no active project', () => {
      mockProjectState.activeProjectId.mockReturnValue(null);

      const built = buildContext({
        entries: [
          makeEntry({
            taskId: 'inline-1',
            sourceKind: 'dock-created',
            inlineArchiveStatus: 'pending',
          }),
        ],
      });
      service.init(built.ctx);

      const result = service.archiveInlineEntriesToActiveProject();
      expect(result).toEqual({ converted: 0, failed: 1 });

      const updated = built.entries().find(e => e.taskId === 'inline-1');
      expect(updated!.inlineArchiveStatus).toBe('failed');
    });
  });
});
