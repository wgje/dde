import { describe, expect, it } from 'vitest';
import type { Task } from '../models';
import { detectCycles, detectOrphans, sanitizeProject } from './validation';

interface ValidationProjectGraphSpecContext {
  createTask: (overrides?: Partial<Task>) => Task;
}

export function registerValidationProjectGraphSpecs(context: ValidationProjectGraphSpecContext): void {
  describe('validation — sanitizeProject (连接/父子关系修复)', () => {
    it('丢弃 parentId 指向不存在任务的引用', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [
          { id: 't1', title: 'a', parentId: 'missing' },
        ],
        connections: [],
      });
      expect(project.tasks[0].parentId).toBeNull();
    });

    it('清除自环 parentId (task.parentId === task.id)', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [{ id: 't1', title: 'a', parentId: 't1' }],
        connections: [],
      });
      expect(project.tasks[0].parentId).toBeNull();
    });

    it('过滤掉引用缺失任务的连接', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [{ id: 't1' }, { id: 't2' }],
        connections: [
          { source: 't1', target: 't2', id: 'c-ok' },
          { source: 't1', target: 'missing', id: 'c-bad' },
        ],
      });
      expect(project.connections).toHaveLength(1);
      expect(project.connections[0].id).toBe('c-ok');
    });

    it('过滤掉自环连接', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [{ id: 't1' }],
        connections: [{ source: 't1', target: 't1', id: 'self' }],
      });
      expect(project.connections).toHaveLength(0);
    });

    it('connections 项缺失 source 或 target 被丢弃', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [{ id: 't1' }, { id: 't2' }],
        connections: [{ source: 't1', id: 'bad' }],
      });
      expect(project.connections).toHaveLength(0);
    });

    it('viewState 非法数字字段被丢弃', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [],
        connections: [],
        viewState: { scale: 'bogus', positionX: 0, positionY: 0 },
      });
      expect(project.viewState).toBeUndefined();
    });

    it('合法 viewState 被保留', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [],
        connections: [],
        viewState: { scale: 1.5, positionX: 100, positionY: 200 },
      });
      expect(project.viewState).toEqual({ scale: 1.5, positionX: 100, positionY: 200 });
    });

    it('flowchartUrl 中的 javascript: 被剥离', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [],
        connections: [],
        flowchartUrl: 'javascript:alert(1)',
      });
      expect(project.flowchartUrl).toBe('');
    });

    it('项目恢复时保留任务 attentionMeta', () => {
      const project = sanitizeProject({
        id: 'p',
        name: 'P',
        tasks: [
          {
            id: 't1',
            title: 'a',
            attentionMeta: {
              items: [
                {
                  id: 'att-1',
                  text: '恢复后仍在',
                  level: 'blocker',
                  done: true,
                  createdAt: '2026-06-01T09:00:00.000Z',
                  updatedAt: '2026-06-01T10:00:00.000Z',
                },
              ],
            },
          },
        ],
        connections: [],
      });

      expect(project.tasks[0].attentionMeta?.items[0]).toEqual({
        id: 'att-1',
        text: '恢复后仍在',
        level: 'blocker',
        done: true,
        createdAt: '2026-06-01T09:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
      });
    });
  });

  describe('validation — detectCycles', () => {
    it('无环图 → hasCycle=false', () => {
      const tasks = [
        context.createTask({ id: 'a' }),
        context.createTask({ id: 'b', parentId: 'a' }),
        context.createTask({ id: 'c', parentId: 'b' }),
      ];
      expect(detectCycles(tasks).hasCycle).toBe(false);
    });

    it('检测出自环（a → a）', () => {
      const tasks = [context.createTask({ id: 'a', parentId: 'a' })];
      const r = detectCycles(tasks);
      expect(r.hasCycle).toBe(true);
      expect(r.cycleNodes).toContain('a');
    });

    it('检测出长环（a → b → c → a）', () => {
      const tasks = [
        context.createTask({ id: 'a', parentId: 'c' }),
        context.createTask({ id: 'b', parentId: 'a' }),
        context.createTask({ id: 'c', parentId: 'b' }),
      ];
      expect(detectCycles(tasks).hasCycle).toBe(true);
    });

    it('空列表 → hasCycle=false', () => {
      expect(detectCycles([]).hasCycle).toBe(false);
    });
  });

  describe('validation — detectOrphans', () => {
    it('识别 parentId 指向不存在任务的孤儿', () => {
      const tasks = [
        context.createTask({ id: 't1', parentId: 'missing' }),
        context.createTask({ id: 't2' }),
      ];
      expect(detectOrphans(tasks)).toEqual(['t1']);
    });

    it('无孤儿时返回空数组', () => {
      const tasks = [
        context.createTask({ id: 'a' }),
        context.createTask({ id: 'b', parentId: 'a' }),
      ];
      expect(detectOrphans(tasks)).toEqual([]);
    });

    it('parentId 为 null 不算孤儿', () => {
      const tasks = [context.createTask({ id: 'a', parentId: null })];
      expect(detectOrphans(tasks)).toEqual([]);
    });
  });
}
