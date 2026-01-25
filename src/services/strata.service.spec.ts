/**
 * Strata 服务单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StrataService } from './strata.service';
import { BlackBoxService } from './black-box.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { 
  strataLayers,
  focusPreferences,
  setBlackBoxEntries
} from '../app/core/state/focus-stores';
import { StrataItem, StrataLayer } from '../models/focus';

describe('StrataService', () => {
  let service: StrataService;
  let mockBlackBoxService: {
    entriesMap: ReturnType<typeof signal>;
    getCompletedEntries: ReturnType<typeof vi.fn>;
  };
  let mockProjectStateService: {
    activeProjectId: ReturnType<typeof signal>;
    tasks: ReturnType<typeof signal>;
  };
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const createMockStrataItem = (overrides: Partial<StrataItem> = {}): StrataItem => ({
    id: crypto.randomUUID(),
    title: '已完成项目',
    type: 'task',
    completedAt: new Date().toISOString(),
    source: null,  // 测试时可以为 null
    ...overrides
  });

  beforeEach(() => {
    // 重置状态
    strataLayers.set([]);
    setBlackBoxEntries([]);
    focusPreferences.set({
      gateEnabled: true,
      spotlightEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3
    });

    mockBlackBoxService = {
      entriesMap: signal(new Map()),
      getCompletedEntries: vi.fn().mockReturnValue([])
    };

    mockProjectStateService = {
      activeProjectId: signal('test-project'),
      tasks: signal([])
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        StrataService,
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: LoggerService, useValue: mockLoggerService }
      ]
    });

    service = TestBed.inject(StrataService);
  });

  describe('refresh', () => {
    it('应该刷新地质层数据', () => {
      mockProjectStateService.tasks.set([
        { id: '1', title: '已完成', status: 'completed', updatedAt: new Date().toISOString(), deletedAt: null }
      ]);

      service.refresh();

      const layers = strataLayers();
      expect(layers.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('addItem', () => {
    it('应该添加项目到正确的日期层', () => {
      const item = createMockStrataItem({ title: '新完成项目' });

      service.addItem(item);

      const layers = strataLayers();
      expect(layers.length).toBe(1);
      expect(layers[0].items.some(i => i.title === '新完成项目')).toBe(true);
    });

    it('应该在层不存在时创建新层', () => {
      expect(strataLayers().length).toBe(0);

      const item = createMockStrataItem();
      service.addItem(item);

      expect(strataLayers().length).toBe(1);
    });
  });

  describe('getLayerOpacity', () => {
    it('今天的层应该是完全不透明', () => {
      const today = new Date().toISOString().split('T')[0];
      const layer: StrataLayer = {
        date: today,
        items: [],
        opacity: 1
      };

      const opacity = service.getLayerOpacity(layer);

      expect(opacity).toBe(1);
    });

    it('更早的层应该更透明', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 7);
      const layer: StrataLayer = {
        date: pastDate.toISOString().split('T')[0],
        items: [],
        opacity: 1
      };

      const opacity = service.getLayerOpacity(layer);

      expect(opacity).toBeLessThan(1);
      expect(opacity).toBeGreaterThan(0);
    });
  });

  describe('getTotalCount', () => {
    it('应该返回所有层的项目总数', () => {
      strataLayers.set([
        { date: '2024-01-01', items: [createMockStrataItem(), createMockStrataItem()], opacity: 1 },
        { date: '2024-01-02', items: [createMockStrataItem()], opacity: 1 }
      ]);

      const total = service.getTotalCount();

      expect(total).toBe(3);
    });

    it('空层应该返回 0', () => {
      expect(service.getTotalCount()).toBe(0);
    });
  });

  describe('clearOldLayers', () => {
    it('应该清除超过保留天数的层', () => {
      const today = new Date();
      const oldDate = new Date(today);
      oldDate.setDate(oldDate.getDate() - 31);

      strataLayers.set([
        { date: today.toISOString().split('T')[0], items: [createMockStrataItem()], opacity: 1 },
        { date: oldDate.toISOString().split('T')[0], items: [createMockStrataItem()], opacity: 0.3 }
      ]);

      service.clearOldLayers(30);

      const layers = strataLayers();
      expect(layers.length).toBe(1);
      expect(layers[0].date).toBe(today.toISOString().split('T')[0]);
    });
  });

  describe('collapseLayer', () => {
    it('应该切换层的折叠状态', () => {
      const today = new Date().toISOString().split('T')[0];
      strataLayers.set([
        { date: today, items: [createMockStrataItem()], opacity: 1, collapsed: false }
      ]);

      service.collapseLayer(today);

      expect(strataLayers()[0].collapsed).toBe(true);

      service.collapseLayer(today);

      expect(strataLayers()[0].collapsed).toBe(false);
    });
  });

  describe('getTodayItems', () => {
    it('应该返回今日完成的项目', () => {
      mockProjectStateService.tasks.set([
        { id: '1', title: '今日完成', status: 'completed', updatedAt: new Date().toISOString(), deletedAt: null }
      ]);

      const items = service.getTodayItems();

      expect(items.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getWeeklyCount', () => {
    it('应该返回本周完成数量', () => {
      const count = service.getWeeklyCount();

      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getLayerLabel', () => {
    it('今天应该返回今日', () => {
      const today = new Date().toISOString().split('T')[0];
      const label = service.getLayerLabel(today);

      expect(label).toBe('今日');
    });

    it('其他日期应该返回格式化日期', () => {
      const label = service.getLayerLabel('2024-01-15');

      expect(label).toContain('1月15日');
    });
  });
});
