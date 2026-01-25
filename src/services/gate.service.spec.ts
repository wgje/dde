/**
 * Gate 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GateService } from './gate.service';
import { BlackBoxService } from './black-box.service';
import { PreferenceService } from './preference.service';
import { LoggerService } from './logger.service';
import { 
  gateState,
  gatePendingItems,
  gateCurrentIndex,
  gateSnoozeCount,
  focusPreferences,
  setBlackBoxEntries,
  resetGateState
} from '../app/core/state/focus-stores';
import { BlackBoxEntry } from '../models/focus';

describe('GateService', () => {
  let service: GateService;
  let mockBlackBoxService: {
    markAsRead: ReturnType<typeof vi.fn>;
    markAsCompleted: ReturnType<typeof vi.fn>;
    snooze: ReturnType<typeof vi.fn>;
  };
  let mockPreferenceService: Record<string, unknown>;
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const createMockEntry = (overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry => ({
    id: crypto.randomUUID(),
    projectId: 'test-project',
    userId: 'test-user',
    content: '测试条目',
    date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isRead: false,
    isCompleted: false,
    isArchived: false,
    snoozeCount: 0,
    deletedAt: null,
    ...overrides
  });

  beforeEach(() => {
    // 重置状态
    resetGateState();
    setBlackBoxEntries([]);
    focusPreferences.set({
      gateEnabled: true,
      spotlightEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3
    });
    localStorage.clear();

    mockBlackBoxService = {
      markAsRead: vi.fn().mockReturnValue({ ok: true, value: {} }),
      markAsCompleted: vi.fn().mockReturnValue({ ok: true, value: {} }),
      snooze: vi.fn().mockReturnValue({ ok: true, value: {} })
    };

    mockPreferenceService = {};

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        GateService,
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: LoggerService, useValue: mockLoggerService }
      ]
    });

    service = TestBed.inject(GateService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('checkGate', () => {
    it('无待处理项目时应该跳过大门', () => {
      service.checkGate();

      expect(gateState()).toBe('bypassed');
    });

    it('有待处理项目时应该激活大门', () => {
      // 设置昨天的未读条目
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const entry = createMockEntry({ 
        date: yesterday.toISOString().split('T')[0],
        isRead: false,
        isCompleted: false 
      });
      setBlackBoxEntries([entry]);

      service.checkGate();

      expect(gateState()).toBe('reviewing');
      expect(gatePendingItems().length).toBe(1);
    });

    it('大门被禁用时应该跳过', () => {
      focusPreferences.update(p => ({ ...p, gateEnabled: false }));
      setBlackBoxEntries([createMockEntry()]);

      service.checkGate();

      expect(gateState()).toBe('disabled');
    });
  });

  describe('markAsRead', () => {
    it('应该标记当前条目为已读', () => {
      const entry = createMockEntry();
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      const result = service.markAsRead();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.markAsRead).toHaveBeenCalledWith(entry.id);
    });

    it('无当前条目时应该返回错误', () => {
      gatePendingItems.set([]);
      gateState.set('reviewing');

      const result = service.markAsRead();

      expect(result.ok).toBe(false);
    });
  });

  describe('markAsCompleted', () => {
    it('应该标记当前条目为完成', () => {
      const entry = createMockEntry();
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      const result = service.markAsCompleted();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith(entry.id);
    });
  });

  describe('snooze', () => {
    it('应该跳过当前条目', () => {
      const entry = createMockEntry();
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateSnoozeCount.set(0);
      gateState.set('reviewing');

      const result = service.snooze();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.snooze).toHaveBeenCalled();
    });

    it('跳过次数已达上限时应该返回错误', () => {
      const entry = createMockEntry();
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateSnoozeCount.set(3);  // 达到上限
      gateState.set('reviewing');

      const result = service.snooze();

      expect(result.ok).toBe(false);
    });
  });

  describe('getCurrentEntry', () => {
    it('应该返回当前条目', () => {
      const entry = createMockEntry();
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);

      const current = service.getCurrentEntry();

      expect(current).toEqual(entry);
    });

    it('无条目时应该返回 null', () => {
      gatePendingItems.set([]);

      const current = service.getCurrentEntry();

      expect(current).toBeNull();
    });
  });

  describe('forceBypass', () => {
    it('应该强制跳过大门', () => {
      gateState.set('reviewing');

      service.forceBypass();

      expect(gateState()).toBe('bypassed');
    });
  });

  describe('reset', () => {
    it('应该重置大门状态', () => {
      gateState.set('reviewing');
      gatePendingItems.set([createMockEntry()]);

      service.reset();

      // resetGateState() 设置状态为 'checking'，准备重新检查
      expect(gateState()).toBe('checking');
      expect(gatePendingItems().length).toBe(0);
    });
  });
});
