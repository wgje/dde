import { beforeEach, describe, expect, it, type Mock } from 'vitest';

import type { Connection, Project, Task } from '../models';
import type { ConflictResolutionService } from './conflict-resolution.service';

export interface ConflictResolutionMergeSpecContext {
  service(): ConflictResolutionService;
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
  createTestConnection(overrides?: Partial<Connection>): Connection;
  mockChangeTrackerService: {
    getLockedFields: Mock;
  };
}

export function registerConflictResolutionMergeSpecs(context: ConflictResolutionMergeSpecContext): void {
  let service: ConflictResolutionService;
  const {
    createTestProject,
    createTestTask,
    createTestConnection,
    mockChangeTrackerService,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('智能合并算法', () => {
    describe('任务合并', () => {
      it('本地新增的任务应该保留', () => {
        const localProject = createTestProject({
          tasks: [
            createTestTask({ id: 'task-1', title: 'Original' }),
            createTestTask({ id: 'task-new-local', title: 'New Local' }),
          ],
        });
        const remoteProject = createTestProject({
          tasks: [createTestTask({ id: 'task-1', title: 'Original' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.tasks).toHaveLength(2);
        expect(result.project.tasks.find(t => t.id === 'task-new-local')).toBeDefined();
      });

      it('远程新增的任务应该保留', () => {
        const localProject = createTestProject({
          tasks: [createTestTask({ id: 'task-1', title: 'Original' })],
        });
        const remoteProject = createTestProject({
          tasks: [
            createTestTask({ id: 'task-1', title: 'Original' }),
            createTestTask({ id: 'task-new-remote', title: 'New Remote' }),
          ],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.tasks).toHaveLength(2);
        expect(result.project.tasks.find(t => t.id === 'task-new-remote')).toBeDefined();
      });

      it('旧的远端 tombstone 不应该删除更新的本地恢复任务', () => {
        const localProject = createTestProject({
          tasks: [createTestTask({
            id: 'task-tombstone-newer-local',
            title: 'Restored locally',
            updatedAt: '2026-01-03T00:00:00.000Z',
            deletedAt: null,
          })],
        });
        const remoteProject = createTestProject({
          tasks: [],
        });
        const tombstones = new Set(['task-tombstone-newer-local']) as Set<string> & {
          deletedAtByTaskId: Map<string, number>;
        };
        tombstones.deletedAtByTaskId = new Map([
          ['task-tombstone-newer-local', Date.parse('2026-01-02T00:00:00.000Z')],
        ]);

        const result = service.smartMerge(localProject, remoteProject, tombstones);

        expect(result.project.tasks.map(t => t.id)).toContain('task-tombstone-newer-local');
        expect(result.project.tasks.find(t => t.id === 'task-tombstone-newer-local')?.deletedAt).toBeNull();
      });

      it('双方都有的任务应该字段级合并', () => {
        const oldTime = new Date('2024-01-01T00:00:00Z').toISOString();
        const newTime = new Date('2024-01-02T00:00:00Z').toISOString();

        const localProject = createTestProject({
          tasks: [createTestTask({
            id: 'task-1',
            title: 'Local Title',
            content: 'Local Content',
            updatedAt: newTime,
          })],
        });
        const remoteProject = createTestProject({
          tasks: [createTestTask({
            id: 'task-1',
            title: 'Remote Title',
            content: 'Remote Content',
            updatedAt: oldTime,
          })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        const mergedTask = result.project.tasks[0];
        expect(mergedTask.title).toBe('Local Title'); // 本地更新时间更新
        expect(result.conflictCount).toBeGreaterThan(0);
      });
    });

    describe('连接合并', () => {
      it('应该合并双方的连接', () => {
        const localProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });
        const remoteProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-2', source: 'task-3', target: 'task-4' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.connections).toHaveLength(2);
      });

      it('重复连接应该去重（相同 id）', () => {
        const localProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });
        const remoteProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.connections).toHaveLength(1);
      });

      it('不同 id 的连接即使 source→target 相同也应该保留', () => {
        const localProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' })],
        });
        const remoteProject = createTestProject({
          connections: [createTestConnection({ id: 'conn-2', source: 'task-1', target: 'task-2' })],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        expect(result.project.connections).toHaveLength(2);
      });

      it('软删除的连接应该正确处理 - 删除优先策略', () => {
        const localProject = createTestProject({
          connections: [
            createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2', deletedAt: null }),
          ],
        });
        const deletedTime = new Date().toISOString();
        const remoteProject = createTestProject({
          connections: [
            createTestConnection({ id: 'conn-1', source: 'task-1', target: 'task-2', deletedAt: deletedTime }),
          ],
        });

        const result = service.smartMerge(localProject, remoteProject, new Set());

        const conn = result.project.connections.find(
          c => c.source === 'task-1' && c.target === 'task-2'
        );
        expect(conn?.deletedAt).toBe(deletedTime);
      });
    });
  });

  describe('字段级合并', () => {
    it('更新时间较新的字段应该胜出', () => {
      const oldTime = new Date('2024-01-01T00:00:00Z').toISOString();
      const newTime = new Date('2024-01-02T00:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Old Title',
          status: 'completed',
          updatedAt: oldTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'New Title',
          status: 'active',
          updatedAt: newTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.title).toBe('New Title');
      expect(task.status).toBe('active');
    });

    it('标签应该合并去重', () => {
      const sameTime = '2024-01-01T12:00:00.000Z';
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          tags: ['tag1', 'tag2'],
          updatedAt: sameTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          tags: ['tag2', 'tag3'],
          updatedAt: sameTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.tags).toEqual(expect.arrayContaining(['tag1', 'tag2', 'tag3']));
      expect(task.tags?.length).toBe(3);
    });

    it('附件应该按 ID 合并', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          attachments: [
            { id: 'att-1', name: 'file1.pdf', url: '/url1', size: 100, type: 'document', createdAt: '' },
          ],
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          attachments: [
            { id: 'att-2', name: 'file2.pdf', url: '/url2', size: 200, type: 'document', createdAt: '' },
          ],
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.attachments?.length).toBe(2);
    });

    it('位置信息应该保留本地值', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          x: 100,
          y: 200,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          x: 500,
          y: 600,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.x).toBe(100); // 保留本地位置
      expect(task.y).toBe(200);
    });

    it('删除标记应该合并（任一方删除则删除）', () => {
      const now = new Date().toISOString();

      const localProject1 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: now,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject1 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: null,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result1 = service.smartMerge(localProject1, remoteProject1, new Set());
      expect(result1.project.tasks[0].deletedAt).toBe(now);

      const localProject2 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: null,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });
      const remoteProject2 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: now,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });

      const result2 = service.smartMerge(localProject2, remoteProject2, new Set());
      expect(result2.project.tasks[0].deletedAt).toBe(now);

      const earlierTime = new Date('2024-01-01T10:00:00Z').toISOString();
      const laterTime = new Date('2024-01-01T11:00:00Z').toISOString();

      const localProject3 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: laterTime,
        })],
      });
      const remoteProject3 = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          deletedAt: earlierTime,
        })],
      });

      const result3 = service.smartMerge(localProject3, remoteProject3, new Set());
      expect(result3.project.tasks[0].deletedAt).toBe(earlierTime);
    });

    it('被锁定的 status 字段应该始终使用本地版本', () => {
      mockChangeTrackerService.getLockedFields.mockReturnValue(['status']);

      const localProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'completed',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'active',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].status).toBe('completed');

      mockChangeTrackerService.getLockedFields.mockReturnValue([]);
    });

    it('被锁定的 title 字段应该始终使用本地版本', () => {
      mockChangeTrackerService.getLockedFields.mockReturnValue(['title']);

      const localProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Local Title',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Remote Title',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].title).toBe('Local Title');

      mockChangeTrackerService.getLockedFields.mockReturnValue([]);
    });

    it('未锁定的字段应该使用 LWW 策略', () => {
      mockChangeTrackerService.getLockedFields.mockReturnValue([]);

      const localProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'active',
          title: 'Local Title',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        tasks: [createTestTask({
          id: 'task-1',
          status: 'completed',
          title: 'Remote Title',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].status).toBe('completed');
      expect(result.project.tasks[0].title).toBe('Remote Title');
    });
  });
}
