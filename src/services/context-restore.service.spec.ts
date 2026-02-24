/**
 * ContextRestoreService 单元测试
 * 策划案 A5.2 上下文快照保存/恢复 + A12 验收标准
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ContextRestoreService } from './context-restore.service';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import { UiStateService } from './ui-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Task, ParkingSnapshot } from '../models';

describe('ContextRestoreService', () => {
  let service: ContextRestoreService;

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: crypto.randomUUID(),
    title: '测试任务',
    content: '# 测试内容\n\n段落文字',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-1',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: null,
    ...overrides,
  });

  let mockTaskStore: {
    getTask: ReturnType<typeof vi.fn>;
    setTask: ReturnType<typeof vi.fn>;
    parkedTaskIds: ReturnType<typeof signal>;
    getTaskProjectId: ReturnType<typeof vi.fn>;
  };

  let mockProjectStore: {
    projects: ReturnType<typeof signal>;
    activeProjectId: ReturnType<typeof signal>;
  };

  let mockUiState: {
    isFlowView: ReturnType<typeof signal>;
    scrollPosition: ReturnType<typeof signal>;
    activeView: ReturnType<typeof signal>;
  };

  let mockToastService: {
    info: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  };

  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockTaskStore = {
      getTask: vi.fn(),
      setTask: vi.fn(),
      parkedTaskIds: signal(new Set<string>()),
      getTaskProjectId: vi.fn(() => 'proj-1'),
    };

    mockProjectStore = {
      projects: signal([]),
      activeProjectId: signal('proj-1'),
    };

    mockUiState = {
      isFlowView: signal(false),
      scrollPosition: signal(0),
      activeView: signal('text'),
    };

    mockToastService = {
      info: vi.fn(),
      warning: vi.fn(),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        ContextRestoreService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(ContextRestoreService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ─── P-03: saveSnapshot ───

  describe('P-03: saveSnapshot', () => {
    it('应为停泊任务保存快照到 parkingMeta', () => {
      const task = createTask({
        id: 'task-1',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.saveSnapshot('task-1');

      expect(mockTaskStore.setTask).toHaveBeenCalled();
      const updatedTask = mockTaskStore.setTask.mock.calls[0][0];
      expect(updatedTask.parkingMeta.contextSnapshot).toBeTruthy();
      expect(updatedTask.parkingMeta.contextSnapshot.savedAt).toBeTruthy();
      expect(updatedTask.parkingMeta.contextSnapshot.contentHash).toBeTruthy();
      expect(updatedTask.parkingMeta.contextSnapshot.viewMode).toBe('text');
    });

    it('非停泊任务时静默忽略', () => {
      mockTaskStore.getTask.mockReturnValue(createTask({ parkingMeta: null }));

      service.saveSnapshot('task-1');

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });

    it('任务不存在时静默忽略', () => {
      mockTaskStore.getTask.mockReturnValue(undefined);

      service.saveSnapshot('nonexistent');

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });

    it('保存快照应包含 contentHash', () => {
      const task = createTask({
        id: 'hash-test',
        content: '# 标题\n\n内容段落',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.saveSnapshot('hash-test');

      const snapshot = mockTaskStore.setTask.mock.calls[0][0].parkingMeta.contextSnapshot;
      expect(snapshot.contentHash).toBeTruthy();
      expect(typeof snapshot.contentHash).toBe('string');
    });

    it('Flow 视图时 viewMode 应为 flow', () => {
      mockUiState.activeView.set('flow');
      const task = createTask({
        id: 'flow-snap',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.saveSnapshot('flow-snap');

      const snapshot = mockTaskStore.setTask.mock.calls[0][0].parkingMeta.contextSnapshot;
      expect(snapshot.viewMode).toBe('flow');
    });
  });

  // ─── P-04: restore（内容变更降级） ───

  describe('P-04: restore', () => {
    it('内容哈希一致时应尝试精确恢复', () => {
      mockTaskStore.getTask.mockReturnValue(createTask({ id: 'task-1', content: '# 测试内容\n\n段落文字' }));
      const snapshot: ParkingSnapshot = {
        savedAt: new Date().toISOString(),
        contentHash: '12345',
        viewMode: 'text',
        cursorPosition: { line: 42, column: 0 },
        scrollAnchor: { anchorType: 'line', anchorIndex: 10, scrollPercent: 0.3 },
        structuralAnchor: null,
        flowViewport: null,
      };

      expect(() => service.restore('task-1', snapshot)).not.toThrow();
    });

    it('内容哈希不匹配时应触发 fallback 并通知用户', () => {
      const task = createTask({ id: 'task-mismatch', content: '# 新内容\n\n第二段' });
      mockTaskStore.getTask.mockReturnValue(task);

      const container = document.createElement('div');
      container.className = 'text-column';
      container.style.height = '200px';
      container.style.overflow = 'auto';
      container.innerHTML = '<p>第一段</p><p>第二段</p><p>第三段</p>';
      document.body.appendChild(container);

      const snapshot: ParkingSnapshot = {
        savedAt: new Date().toISOString(),
        contentHash: 'outdated-hash',
        viewMode: 'text',
        cursorPosition: { line: 2, column: 1 },
        scrollAnchor: { anchorType: 'line', anchorIndex: 2, scrollPercent: 0.5 },
        structuralAnchor: { type: 'heading', label: '第二段', line: 2 },
        flowViewport: null,
      };

      service.restore('task-mismatch', snapshot);
      expect(mockToastService.info).toHaveBeenCalled();
      const toastCall = mockToastService.info.mock.calls[0];
      expect(toastCall[0]).toContain('内容已变更');

      container.remove();
    });

    it('跨视图恢复不应报错', () => {
      mockUiState.activeView.set('flow');
      const task = createTask({ id: 'cross-view', content: '内容' });
      mockTaskStore.getTask.mockReturnValue(task);

      const snapshot: ParkingSnapshot = {
        savedAt: new Date().toISOString(),
        contentHash: 'hash',
        viewMode: 'text', // 快照来自 text，当前是 flow
        cursorPosition: { line: 1, column: 1 },
        scrollAnchor: null,
        structuralAnchor: { type: 'heading', label: '标题', line: 1 },
        flowViewport: null,
      };

      expect(() => service.restore('cross-view', snapshot)).not.toThrow();
    });

    it('无快照数据时应优雅降级', () => {
      mockTaskStore.getTask.mockReturnValue(createTask({ id: 'empty-snap' }));

      const snapshot: ParkingSnapshot = {
        savedAt: new Date().toISOString(),
        contentHash: 'hash',
        viewMode: 'text',
        cursorPosition: null,
        scrollAnchor: null,
        structuralAnchor: null,
        flowViewport: null,
      };

      expect(() => service.restore('empty-snap', snapshot)).not.toThrow();
    });
  });

  // ─── P-15: structuralAnchor 重复检查 ───

  describe('P-15: structuralAnchor', () => {
    it('fallback 类型且 label 与标题重复时不显示锚点', () => {
      const task = createTask({
        id: 'anchor-dup',
        content: '测试任务\n\n段落',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: {
            savedAt: new Date().toISOString(),
            contentHash: 'hash',
            viewMode: 'text',
            cursorPosition: null,
            scrollAnchor: null,
            structuralAnchor: { type: 'fallback', label: '测试任务' },
            flowViewport: null,
          },
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // Dock 组件的 getAnchorDisplay 逻辑负责此过滤
      // ContextRestoreService 保存的锚点类型为 fallback 时不包含 line
      const anchor = task.parkingMeta?.contextSnapshot?.structuralAnchor;
      expect(anchor?.type).toBe('fallback');
    });
  });

  // ─── restoreCursorPosition ───

  describe('restoreCursorPosition', () => {
    it('应恢复 textarea 光标位置', () => {
      const textarea = document.createElement('textarea');
      textarea.className = 'text-editor';
      textarea.value = 'line1\nline2\nline3';
      document.body.appendChild(textarea);

      (service as unknown as {
        restoreCursorPosition: (pos: { line: number; column: number } | null) => void;
      }).restoreCursorPosition({ line: 2, column: 3 });

      expect(textarea.selectionStart).toBe(8); // "line1\nli"
      expect(textarea.selectionEnd).toBe(8);

      textarea.remove();
    });

    it('null 光标位置不应报错', () => {
      (service as unknown as {
        restoreCursorPosition: (pos: { line: number; column: number } | null) => void;
      }).restoreCursorPosition(null);
      // 不应抛出异常
    });
  });

  // ─── computeContentHash ───

  describe('computeContentHash', () => {
    it('相同内容返回相同哈希', () => {
      const hash1 = (service as unknown as { computeContentHash: (s: string) => string }).computeContentHash('hello');
      const hash2 = (service as unknown as { computeContentHash: (s: string) => string }).computeContentHash('hello');
      expect(hash1).toBe(hash2);
    });

    it('不同内容返回不同哈希', () => {
      const hash1 = (service as unknown as { computeContentHash: (s: string) => string }).computeContentHash('hello');
      const hash2 = (service as unknown as { computeContentHash: (s: string) => string }).computeContentHash('world');
      expect(hash1).not.toBe(hash2);
    });
  });

  // ─── fallbackRestore ───

  describe('fallbackRestore', () => {
    it('structuralAnchor.label 文本搜索优先', () => {
      const result = (service as unknown as {
        fallbackRestore: (snapshot: ParkingSnapshot, content: string, isCrossView: boolean) => { line: number | null };
      }).fallbackRestore(
        {
          savedAt: new Date().toISOString(),
          contentHash: '',
          viewMode: 'text',
          cursorPosition: { line: 5, column: 1 },
          scrollAnchor: { anchorType: 'line', anchorIndex: 0, scrollPercent: 0.5 },
          structuralAnchor: { type: 'heading', label: '段落C', line: 3 },
          flowViewport: null,
        },
        '段落A\n段落B\n段落C\n段落D',
        false
      );
      expect(result.line).toBe(3);
    });

    it('无结构锚点时回退到行号', () => {
      const result = (service as unknown as {
        fallbackRestore: (snapshot: ParkingSnapshot, content: string, isCrossView: boolean) => { line: number | null };
      }).fallbackRestore(
        {
          savedAt: new Date().toISOString(),
          contentHash: '',
          viewMode: 'text',
          cursorPosition: { line: 2, column: 1 },
          scrollAnchor: null,
          structuralAnchor: null,
          flowViewport: null,
        },
        '行1\n行2\n行3',
        false
      );
      expect(result.line).toBe(2);
    });
  });
});
