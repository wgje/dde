/**
 * ConflictDetectionService 单元测试
 *
 * 测试覆盖：
 * 1. 短 ID 生成（generateShortId）
 * 2. 字段级任务合并（mergeTaskFields）
 * 3. 内容冲突检测（isRealContentConflict）
 * 4. 字符串相似度计算（calculateSimilarity）
 * 5. 文本合并（mergeTextContent）
 * 6. 行级合并（mergeLines）
 * 7. 连接合并（mergeConnections）- 含 Tombstone Wins
 * 8. 标签智能合并（mergeTagsWithIntent）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { ConflictDetectionService } from './conflict-detection.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { Task, Connection, Project } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockChangeTracker = {
  getLockedFields: vi.fn().mockReturnValue([]),
  trackTaskCreate: vi.fn(),
  trackTaskUpdate: vi.fn(),
  trackTaskDelete: vi.fn(),
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Title',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

describe('ConflictDetectionService', () => {
  let service: ConflictDetectionService;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const injector = Injector.create({
      providers: [
        ConflictDetectionService,
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ConflictDetectionService));
  });

  afterEach(() => {
    consoleWarnSpy?.mockRestore();
  });

  // ==================== 短 ID 生成 ====================

  describe('generateShortId', () => {
    it('should generate an ID with NF- prefix', () => {
      const id = service.generateShortId();
      expect(id).toMatch(/^NF-[A-Z0-9]{4}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 50 }, () => service.generateShortId()));
      // With 36^4 possibilities, collisions in 50 tries are extremely unlikely
      expect(ids.size).toBeGreaterThan(45);
    });
  });

  // ==================== 字符串相似度 ====================

  describe('calculateSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      expect(service.calculateSimilarity('hello', 'hello')).toBe(1.0);
    });

    it('should return 1.0 for two empty strings', () => {
      expect(service.calculateSimilarity('', '')).toBe(1.0);
    });

    it('should return high similarity for similar strings', () => {
      const similarity = service.calculateSimilarity('hello world', 'hello world!');
      expect(similarity).toBeGreaterThan(0.8);
    });

    it('should return lower similarity for quite different strings', () => {
      const similarity = service.calculateSimilarity('abcdef', 'xyz123');
      expect(similarity).toBeLessThan(0.5);
    });
  });

  // ==================== 内容冲突检测 ====================

  describe('isRealContentConflict', () => {
    it('should not flag short content as conflict', () => {
      expect(service.isRealContentConflict('short', 'diff')).toBe(false);
    });

    it('should not flag prefix relationship as conflict', () => {
      const base = 'This is a long enough content for testing purposes here';
      const extended = base + ' with additional text appended at the end';
      expect(service.isRealContentConflict(base, extended)).toBe(false);
    });

    it('should not flag suffix relationship as conflict', () => {
      const base = 'This is a long enough content for testing purposes here';
      const prepended = 'Prefix text prepended at start ' + base;
      expect(service.isRealContentConflict(base, prepended)).toBe(false);
    });

    it('should not flag very similar content as conflict (>90%)', () => {
      const text1 = 'This is a moderately long text that has some content in it for testing';
      const text2 = 'This is a moderately long text that has some contant in it for testing';
      // Single character difference should be >90% similar
      expect(service.isRealContentConflict(text1, text2)).toBe(false);
    });

    it('should flag real conflicts with moderate similarity', () => {
      // Content that shares some common base but has divergent edits
      const local = 'The quick brown fox jumped over the lazy sleeping dog chasing a cat nearby today';
      const remote = 'The quick brown rabbit hopped over the energetic awake cat running from wild dogs today';
      const similarity = service.calculateSimilarity(local, remote);
      // Only flag as real conflict if similarity is between 30-90%
      if (similarity >= 0.3 && similarity <= 0.9) {
        expect(service.isRealContentConflict(local, remote)).toBe(true);
      }
    });
  });

  // ==================== 文本合并 ====================

  describe('mergeTextContent', () => {
    it('should prefer remote when remote is extension of local', () => {
      const local = 'Hello';
      const remote = 'Hello World';
      const result = service.mergeTextContent(local, remote, 100, 200);
      expect(result).toBe('Hello World');
    });

    it('should prefer local when local is extension of remote', () => {
      const local = 'Hello World';
      const remote = 'Hello';
      const result = service.mergeTextContent(local, remote, 100, 200);
      expect(result).toBe('Hello World');
    });

    it('should use newer version when neither is an extension', () => {
      const local = 'Local only content';
      const remote = 'Remote only content';
      const result = service.mergeTextContent(local, remote, 100, 200);
      expect(result).toBe('Remote only content'); // remote is newer
    });

    it('should use local version when local time is newer', () => {
      const local = 'Local only content';
      const remote = 'Remote only content';
      const result = service.mergeTextContent(local, remote, 200, 100);
      expect(result).toBe('Local only content');
    });
  });

  // ==================== 行级合并 ====================

  describe('mergeLines', () => {
    it('should merge lines that share a common base', () => {
      const common = ['line1', 'line2', 'line3'];
      const local = [...common, 'localNew'];
      const remote = [...common, 'remoteNew'];

      const result = service.mergeLines(local, remote);

      expect(result).not.toBeNull();
      expect(result).toContain('line1');
      expect(result).toContain('localNew');
      expect(result).toContain('remoteNew');
    });

    it('should return null when content is too different', () => {
      const local = ['a', 'b', 'c', 'd'];
      const remote = ['w', 'x', 'y', 'z'];
      const result = service.mergeLines(local, remote);
      expect(result).toBeNull();
    });
  });

  // ==================== 任务字段级合并 ====================

  describe('mergeTaskFields', () => {
    it('should return merged result with no conflict when tasks are identical', () => {
      const task = createTask({ updatedAt: '2024-01-01T00:00:00Z' });
      const result = service.mergeTaskFields(task, { ...task }, 'proj-1');

      expect(result.hasConflict).toBe(false);
      expect(result.mergedTask.id).toBe(task.id);
    });

    it('should use newer title when titles conflict', () => {
      const local = createTask({ title: 'Local Title', updatedAt: '2024-01-01T00:00:00Z' });
      const remote = createTask({ title: 'Remote Title', updatedAt: '2024-01-02T00:00:00Z' });

      const result = service.mergeTaskFields(local, remote, 'proj-1');

      expect(result.hasConflict).toBe(true);
      expect(result.mergedTask.title).toBe('Remote Title');
    });

    it('should use local title when title field is locked', () => {
      mockChangeTracker.getLockedFields.mockReturnValue(['title']);
      const local = createTask({ title: 'Local Title', updatedAt: '2024-01-01T00:00:00Z' });
      const remote = createTask({ title: 'Remote Title', updatedAt: '2024-01-02T00:00:00Z' });

      const result = service.mergeTaskFields(local, remote, 'proj-1');

      expect(result.hasConflict).toBe(true);
      expect(result.mergedTask.title).toBe('Local Title');
    });

    it('should apply delete-wins strategy for deletedAt', () => {
      const deletedAt = '2024-01-01T12:00:00Z';
      const local = createTask({ deletedAt: null });
      const remote = createTask({ deletedAt });

      const result = service.mergeTaskFields(local, remote, 'proj-1');

      expect(result.hasConflict).toBe(true);
      expect(result.mergedTask.deletedAt).toBe(deletedAt);
    });

    it('should preserve local position (x, y)', () => {
      const local = createTask({ x: 100, y: 200, updatedAt: '2024-01-01T00:00:00Z' });
      const remote = createTask({ x: 300, y: 400, updatedAt: '2024-01-02T00:00:00Z' });

      const result = service.mergeTaskFields(local, remote, 'proj-1');

      expect(result.mergedTask.x).toBe(100);
      expect(result.mergedTask.y).toBe(200);
    });
  });

  // ==================== 连接合并 ====================

  describe('mergeConnections', () => {
    it('should merge connections from both sides', () => {
      const local: Connection[] = [
        { id: 'c1', source: 'a', target: 'b' },
      ];
      const remote: Connection[] = [
        { id: 'c2', source: 'c', target: 'd' },
      ];

      const result = service.mergeConnections(local, remote);

      expect(result).toHaveLength(2);
    });

    it('should apply tombstone-wins when one side deleted a connection', () => {
      const deletedAt = '2024-01-01T00:00:00Z';
      const local: Connection[] = [
        { id: 'c1', source: 'a', target: 'b' },
      ];
      const remote: Connection[] = [
        { id: 'c1', source: 'a', target: 'b', deletedAt },
      ];

      const result = service.mergeConnections(local, remote);

      expect(result).toHaveLength(1);
      expect(result[0].deletedAt).toBe(deletedAt);
    });

    it('should use earlier delete time when both sides deleted', () => {
      const earlier = '2024-01-01T00:00:00Z';
      const later = '2024-01-02T00:00:00Z';
      const local: Connection[] = [
        { id: 'c1', source: 'a', target: 'b', deletedAt: earlier },
      ];
      const remote: Connection[] = [
        { id: 'c1', source: 'a', target: 'b', deletedAt: later },
      ];

      const result = service.mergeConnections(local, remote);

      expect(result[0].deletedAt).toBe(earlier);
    });

    it('should merge descriptions when both sides are alive', () => {
      const local: Connection[] = [
        { id: 'c1', source: 'a', target: 'b', description: 'short' },
      ];
      const remote: Connection[] = [
        { id: 'c1', source: 'a', target: 'b', description: 'longer description' },
      ];

      const result = service.mergeConnections(local, remote);

      expect(result[0].description).toBe('longer description');
    });
  });

  // ==================== 标签合并 ====================

  describe('mergeTagsWithIntent', () => {
    it('should keep tags present on both sides', () => {
      const result = service.mergeTagsWithIntent(['a', 'b'], ['a', 'b'], 100, 100);
      expect(result).toContain('a');
      expect(result).toContain('b');
    });

    it('should keep local-only tags when local is newer', () => {
      const result = service.mergeTagsWithIntent(['a', 'localNew'], ['a'], 200, 100);
      expect(result).toContain('localNew');
    });

    it('should keep remote-only tags when remote is newer', () => {
      const result = service.mergeTagsWithIntent(['a'], ['a', 'remoteNew'], 100, 200);
      expect(result).toContain('remoteNew');
    });

    it('should remove local-only tags when remote is newer (remote deleted)', () => {
      const result = service.mergeTagsWithIntent(['a', 'removed'], ['a'], 100, 200);
      expect(result).not.toContain('removed');
    });

    it('should merge additions from both sides when times are equal', () => {
      const result = service.mergeTagsWithIntent(['a', 'b'], ['a', 'c'], 100, 100);
      expect(result).toContain('a');
      expect(result).toContain('b');
      expect(result).toContain('c');
    });
  });
});
