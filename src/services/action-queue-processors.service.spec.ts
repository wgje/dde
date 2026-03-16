/**
 * ActionQueueProcessorsService 单元测试
 *
 * 验证 setupProcessors 注册了正确数量的处理器（13 个），
 * 并逐类型验证处理器的行为（通过捕获 registerProcessor mock 调用的 handler）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { ActionQueueService } from './action-queue.service';
import { QueuedAction } from './action-queue.types';
import { SimpleSyncService } from '../core-bridge';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';

// ── Mock factories ───────────────────────────────────────────

const mockLoggerCategory = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const mockLoggerService = { category: vi.fn(() => mockLoggerCategory) };

const mockActionQueueService = {
  registerProcessor: vi.fn(),
  setQueueProcessCallbacks: vi.fn(),
};

const mockSyncService = {
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  saveProjectSmart: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
  deleteProjectFromCloud: vi.fn().mockResolvedValue(true),
  pushTask: vi.fn().mockResolvedValue(true),
  deleteTask: vi.fn().mockResolvedValue(true),
  saveUserPreferences: vi.fn().mockResolvedValue(true),
  saveFocusSession: vi.fn().mockResolvedValue({ ok: true }),
  upsertRoutineTask: vi.fn().mockResolvedValue({ ok: true }),
  incrementRoutineCompletion: vi.fn().mockResolvedValue({ ok: true }),
};

const mockProjectStateService = { updateProjects: vi.fn() };
const mockAuthService = { currentUserId: vi.fn(() => 'test-user') };

// ── Helpers ──────────────────────────────────────────────────

/** Retrieve the handler registered for a given action type */
function getProcessor(type: string): (action: QueuedAction) => Promise<boolean> {
  const call = mockActionQueueService.registerProcessor.mock.calls.find(
    (c: [string, (action: QueuedAction) => Promise<boolean>]) => c[0] === type,
  );
  if (!call) throw new Error(`No processor registered for "${type}"`);
  return call[1];
}

describe('ActionQueueProcessorsService', () => {
  let service: ActionQueueProcessorsService;

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        ActionQueueProcessorsService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    service = TestBed.inject(ActionQueueProcessorsService);
    service.setupProcessors();
  });

  // ── Registration ───────────────────────────────────────────

  it('should register 13 processors', () => {
    expect(mockActionQueueService.registerProcessor).toHaveBeenCalledTimes(13);
  });

  it('should set queue sync callbacks', () => {
    expect(mockActionQueueService.setQueueProcessCallbacks).toHaveBeenCalledOnce();
  });

  // ── project:update ─────────────────────────────────────────

  it('project:update should call saveProjectSmart and update version', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-1', name: 'Test' };

    const result = await handler({ payload: { project } });

    expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(project, 'test-user');
    expect(mockProjectStateService.updateProjects).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('project:update should return false when userId is missing', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(null);
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-1' } } });

    expect(result).toBe(false);
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  // ── project:delete ─────────────────────────────────────────

  it('project:delete should call deleteProjectFromCloud', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({ entityId: 'p-1' });

    expect(mockSyncService.deleteProjectFromCloud).toHaveBeenCalledWith('p-1', 'test-user');
    expect(result).toBe(true);
  });

  // ── task:create ────────────────────────────────────────────

  it('task:create should call pushTask', async () => {
    const handler = getProcessor('task:create');
    const task = { id: 't-1', title: 'Task' };

    const result = await handler({ payload: { task, projectId: 'p-1' } });

    expect(mockSyncService.pushTask).toHaveBeenCalledWith(task, 'p-1', false);
    expect(result).toBe(true);
  });

  // ── focus-session:create ───────────────────────────────────

  it('focus-session:create should return result.ok', async () => {
    const handler = getProcessor('focus-session:create');
    const record = { userId: 'test-user', sessionId: 's-1' };

    const result = await handler({ payload: { record } });

    expect(mockSyncService.saveFocusSession).toHaveBeenCalledWith(record);
    expect(result).toBe(true);
  });

  // ── routine-task:create ────────────────────────────────────

  it('routine-task:create should return result.ok', async () => {
    const handler = getProcessor('routine-task:create');
    const routineTask = { id: 'rt-1', title: 'Routine' };

    const result = await handler({ payload: { routineTask } });

    expect(mockSyncService.upsertRoutineTask).toHaveBeenCalledWith('test-user', routineTask);
    expect(result).toBe(true);
  });

  // ── routine-completion:create ──────────────────────────────

  it('routine-completion:create should return result.ok', async () => {
    const handler = getProcessor('routine-completion:create');
    const completion = { userId: 'test-user', routineTaskId: 'rt-1' };

    const result = await handler({ payload: { completion } });

    expect(mockSyncService.incrementRoutineCompletion).toHaveBeenCalledWith(completion);
    expect(result).toBe(true);
  });

  // ── Error handling ─────────────────────────────────────────

  it('processor should catch exceptions and return false', async () => {
    mockSyncService.pushTask.mockRejectedValueOnce(new Error('network error'));
    const handler = getProcessor('task:create');

    const result = await handler({ payload: { task: { id: 't-1' }, projectId: 'p-1' } });

    expect(result).toBe(false);
    expect(mockLoggerCategory.error).toHaveBeenCalled();
  });
});
