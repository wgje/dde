import { beforeEach, describe, expect, it } from 'vitest';

import type { Project, Task } from '../models';
import type { ConflictResolutionService } from './conflict-resolution.service';

export interface ConflictResolutionContentConflictSpecContext {
  service(): ConflictResolutionService;
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
}

export function registerConflictResolutionContentConflictSpecs(
  context: ConflictResolutionContentConflictSpecContext,
): void {
  let service: ConflictResolutionService;
  const { createTestProject, createTestTask } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('内容冲突检测 (isRealContentConflict)', () => {
    /**
     * 通过 smartMerge 间接测试 isRealContentConflict 行为：
     * 冲突副本被直接添加到 project.tasks 中，通过 title 包含 '(冲突副本)' 来识别。
     */
    function findConflictCopies(tasks: Task[]): Task[] {
      return tasks.filter(t => t.title.includes('(冲突副本)'));
    }

    it('短内容（<20字符）不应触发冲突副本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Short Task',
          content: 'Short',
          updatedAt: new Date('2025-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Short Task',
          content: 'Different',
          updatedAt: new Date('2025-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(findConflictCopies(result.project.tasks)).toHaveLength(0);
    });

    it('内容完全不同（<30% 相似度）应使用 LWW，不创建副本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Test Task',
          content: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          updatedAt: new Date('2025-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Test Task',
          content: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
          updatedAt: new Date('2025-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(findConflictCopies(result.project.tasks)).toHaveLength(0);
      expect(result.project.tasks.find(t => t.id === 'task-1')?.content)
        .toBe('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    });

    it('高度相似内容（>90% 相似度）不应创建副本', () => {
      const baseContent = 'This is a long enough content for testing similarity detection.';
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Test Task',
          content: baseContent,
          updatedAt: new Date('2025-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Test Task',
          content: `${baseContent}!`,
          updatedAt: new Date('2025-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(findConflictCopies(result.project.tasks)).toHaveLength(0);
    });

    it('中等相似度（30%-90%）应创建冲突副本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: '原任务',
          content: 'Common prefix here 111222333444555666777888999000 unique local numbers',
          updatedAt: new Date('2025-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: '原任务',
          content: 'Common prefix here @@##$$%%^^&&**()!!~~``|| unique remote symbols',
          updatedAt: new Date('2025-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const conflictCopies = findConflictCopies(result.project.tasks);
      expect(conflictCopies).toHaveLength(1);
      expect(conflictCopies[0].title).toBe('原任务 (冲突副本)');
      expect(conflictCopies[0].content).toBe(
        'Common prefix here 111222333444555666777888999000 unique local numbers',
      );
    });

    it('一方内容是另一方前缀时不应创建副本', () => {
      const baseContent = 'This is a base content with enough length for testing.';
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Test Task',
          content: baseContent,
          updatedAt: new Date('2025-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Test Task',
          content: `${baseContent} And this is additional content.`,
          updatedAt: new Date('2025-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(findConflictCopies(result.project.tasks)).toHaveLength(0);
    });

    it('冲突副本应有正确的元数据', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: '原任务标题',
          content: 'Shared base text 111222333444555666777888999 local unique numbers here',
          x: 100,
          y: 200,
          updatedAt: new Date('2025-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: '原任务标题',
          content: 'Shared base text @@##$$%%^^&&**(())!!~~``| remote unique symbols here',
          updatedAt: new Date('2025-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const conflictCopies = findConflictCopies(result.project.tasks);
      expect(conflictCopies).toHaveLength(1);

      const copy = conflictCopies[0];
      expect(copy.id).not.toBe('task-1');
      expect(copy.title).toBe('原任务标题 (冲突副本)');
      expect(copy.x).toBe(150);
      expect(copy.y).toBe(250);
      expect(copy.shortId).toBeDefined();
      expect(copy.content).toBe(
        'Shared base text 111222333444555666777888999 local unique numbers here',
      );
    });
  });
}
