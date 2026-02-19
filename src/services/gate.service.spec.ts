/**
 * Gate 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GateService } from './gate.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import {
  gateState,
  gatePendingItems,
  gateCurrentIndex,
  gateSnoozeCount,
  focusPreferences,
  setBlackBoxEntries,
  resetGateState,
} from '../state/focus-stores';
import { BlackBoxEntry } from '../models/focus';

describe('GateService', () => {
  let service: GateService;
  let mockBlackBoxService: {
    markAsRead: ReturnType<typeof vi.fn>;
    markAsCompleted: ReturnType<typeof vi.fn>;
    snooze: ReturnType<typeof vi.fn>;
  };

  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const getDateOffset = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const createMockEntry = (overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry => ({
    id: crypto.randomUUID(),
    projectId: 'test-project',
    userId: 'test-user',
    content: '测试条目',
    date: getDateOffset(0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isRead: false,
    isCompleted: false,
    isArchived: false,
    snoozeCount: 0,
    deletedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    resetGateState();
    setBlackBoxEntries([]);
    focusPreferences.set({
      gateEnabled: true,
      spotlightEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3,
    });
    localStorage.clear();

    mockBlackBoxService = {
      markAsRead: vi.fn().mockReturnValue({ ok: true, value: {} }),
      markAsCompleted: vi.fn().mockReturnValue({ ok: true, value: {} }),
      snooze: vi.fn().mockReturnValue({ ok: true, value: {} }),
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        GateService,
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
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

    it('有待处理项目时应该激活大门并进入 entering 动画', () => {
      const entry = createMockEntry({
        date: getDateOffset(-1),
        isCompleted: false,
      });
      setBlackBoxEntries([entry]);

      service.checkGate();

      expect(gateState()).toBe('reviewing');
      expect(gatePendingItems().length).toBe(1);
      expect(['entering', 'idle']).toContain(service.cardAnimation());
    });

    it('大门被禁用时应该进入 disabled', () => {
      focusPreferences.update(p => ({ ...p, gateEnabled: false }));
      setBlackBoxEntries([createMockEntry({ date: getDateOffset(-1) })]);

      service.checkGate();

      expect(gateState()).toBe('disabled');
    });
  });

  describe('动作状态机', () => {
    it('markAsRead 应该触发 heave_read 动画', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      const result = service.markAsRead();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.markAsRead).toHaveBeenCalledWith(entry.id);
      expect(['heave_read', 'idle']).toContain(service.cardAnimation());
    });

    it('markAsCompleted 应该触发 heavy_drop 动画', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      const result = service.markAsCompleted();

      expect(result.ok).toBe(true);
      expect(mockBlackBoxService.markAsCompleted).toHaveBeenCalledWith(entry.id);
      expect(['heavy_drop', 'idle']).toContain(service.cardAnimation());
    });

    it('heavy_drop 完成后应触发 impactTick 并结束 gate', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      service.markAsCompleted();
      const before = service.impactTick();

      service.onHeavyDropComplete();

      expect(service.impactTick()).toBeGreaterThan(before);
      expect(gateState()).toBe('completed');
    });

    it('heave_read 完成后应推进到下一条并进入 settling', () => {
      const first = createMockEntry({ date: getDateOffset(-1) });
      const second = createMockEntry({ date: getDateOffset(-2) });
      gatePendingItems.set([first, second]);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');

      service.markAsRead();
      service.onHeaveReadComplete();

      expect(gateCurrentIndex()).toBe(1);
      expect(['settling', 'idle']).toContain(service.cardAnimation());
    });
  });

  describe('snooze compatibility', () => {
    it('跳过次数上限后返回错误', () => {
      const entry = createMockEntry({ date: getDateOffset(-1) });
      gatePendingItems.set([entry]);
      gateCurrentIndex.set(0);
      gateSnoozeCount.set(3);
      gateState.set('reviewing');

      const result = service.snooze();

      expect(result.ok).toBe(false);
    });
  });

  describe('reset / bypass', () => {
    it('forceBypass 应设为 bypassed', () => {
      gateState.set('reviewing');
      service.forceBypass();
      expect(gateState()).toBe('bypassed');
    });

    it('reset 应重置状态与动画', () => {
      gateState.set('reviewing');
      gatePendingItems.set([createMockEntry({ date: getDateOffset(-1) })]);
      service.cardAnimation.set('heavy_drop');

      service.reset();

      expect(gateState()).toBe('checking');
      expect(gatePendingItems().length).toBe(0);
      expect(service.cardAnimation()).toBe('idle');
    });
  });
});
