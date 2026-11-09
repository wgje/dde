/**
 * TaskStore/ProjectStore/ConnectionStore 测试
 * 
 * 测试 O(1) 查找、批量操作和状态管理
 */
import { TaskStore, ProjectStore, ConnectionStore } from './stores';
import { Task, Project, Connection } from '../../../models';

describe('TaskStore', () => {
  let store: TaskStore;
  
  beforeEach(() => {
    store = new TaskStore();
  });
  
  afterEach(() => {
    store.clear();
  });
  
  const createMockTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  });
  
  describe('getTask - O(1) 查找', () => {
    it('应该返回存在的任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      
      expect(store.getTask('task-1')).toEqual(task);
    });
    
    it('应该对不存在的任务返回 undefined', () => {
      expect(store.getTask('non-existent')).toBeUndefined();
    });
  });
  
  describe('setTask', () => {
    it('应该添加新任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      
      expect(store.tasksMap().size).toBe(1);
      expect(store.tasks().length).toBe(1);
    });
    
    it('应该更新现有任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      
      const updatedTask = { ...task, title: 'Updated Title', updatedAt: new Date(Date.now() + 1).toISOString() };
      store.setTask(updatedTask, 'project-1');
      
      expect(store.getTask('task-1')?.title).toBe('Updated Title');
      expect(store.tasksMap().size).toBe(1);
    });

    it('相同 revision 但结构字段变化时不得吞掉更新', () => {
      const updatedAt = '2026-07-15T00:00:00.000Z';
      store.setTask(createMockTask('task-1', { stage: null, updatedAt }), 'project-1');

      store.setTask(createMockTask('task-1', {
        stage: 2,
        parentId: 'parent-1',
        rank: 2000,
        updatedAt,
      }), 'project-1');

      expect(store.getTask('task-1')).toMatchObject({
        stage: 2,
        parentId: 'parent-1',
        rank: 2000,
      });
    });

    it('相同 revision 的任务跨项目移动后清理旧项目不得删除实体', () => {
      const movedTask = createMockTask('task-moved', {
        updatedAt: '2026-07-15T00:00:00.000Z',
      });
      store.setTask(movedTask, 'project-a');

      store.setTask(movedTask, 'project-b');
      store.clearProject('project-a');

      expect(store.getTask('task-moved')).toEqual(movedTask);
      expect(store.getTaskProjectId('task-moved')).toBe('project-b');
      expect(store.getTasksByProject('project-a')).toEqual([]);
      expect(store.getTasksByProject('project-b')).toEqual([movedTask]);
    });
  });
  
  describe('setTasks - 批量设置', () => {
    it('应该批量设置任务', () => {
      const tasks = [
        createMockTask('task-1'),
        createMockTask('task-2'),
        createMockTask('task-3')
      ];
      
      store.setTasks(tasks, 'project-1');
      
      expect(store.tasksMap().size).toBe(3);
      expect(store.tasks().length).toBe(3);
    });
    
    it('应该替换项目的所有任务', () => {
      store.setTasks([createMockTask('old-1'), createMockTask('old-2')], 'project-1');
      store.setTasks([createMockTask('new-1')], 'project-1');
      
      expect(store.getTasksByProject('project-1').length).toBe(1);
      expect(store.getTasksByProject('project-1')[0].id).toBe('new-1');
    });

    it('整组设置跨项目移动后清理旧项目不得删除任务', () => {
      const moved = createMockTask('task-set-moved', {
        updatedAt: '2026-07-15T00:00:00.000Z',
      });
      store.setTask(moved, 'project-a');

      store.setTasks([moved], 'project-b');
      store.clearProject('project-a');

      expect(store.getTask('task-set-moved')).toEqual(moved);
      expect(store.getTaskProjectId('task-set-moved')).toBe('project-b');
      expect(store.getTasksByProject('project-a')).toEqual([]);
      expect(store.getTasksByProject('project-b')).toEqual([moved]);
    });

    it('多项目替换应清除被移除任务的实体、归属和停泊索引', () => {
      const parked = createMockTask('parked', {
        parkingMeta: {
          state: 'parked',
          parkedAt: '2026-07-15T00:00:00.000Z',
          lastVisitedAt: '2026-07-15T00:00:00.000Z',
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      store.setTasksForMultipleProjects([{ tasks: [createMockTask('keep'), parked], projectId: 'project-1' }]);

      store.setTasksForMultipleProjects([{ tasks: [createMockTask('keep')], projectId: 'project-1' }]);

      expect(store.getTask('parked')).toBeUndefined();
      expect(store.getTaskProjectId('parked')).toBeNull();
      expect(store.parkedTaskIds().has('parked')).toBe(false);
      expect(store.getTasksByProject('project-1').map(task => task.id)).toEqual(['keep']);
    });

    it('多项目设置将任务迁入新项目后清理旧项目不得删除实体', () => {
      const moved = createMockTask('task-multi-moved');
      store.setTask(moved, 'project-a');

      store.setTasksForMultipleProjects([{ tasks: [moved], projectId: 'project-b' }]);
      store.clearProject('project-a');

      expect(store.getTask('task-multi-moved')).toEqual(moved);
      expect(store.getTaskProjectId('task-multi-moved')).toBe('project-b');
      expect(store.getTasksByProject('project-a')).toEqual([]);
      expect(store.getTasksByProject('project-b')).toEqual([moved]);
    });

    it('多项目迁移同时解除停泊时必须清理 parked 索引', () => {
      const parked = createMockTask('task-unparked-on-move', {
        parkingMeta: {
          state: 'parked',
          parkedAt: '2026-07-15T00:00:00.000Z',
          lastVisitedAt: '2026-07-15T00:00:00.000Z',
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      const moved = { ...parked, parkingMeta: null };
      store.setTask(parked, 'project-a');

      store.setTasksForMultipleProjects([{ tasks: [moved], projectId: 'project-b' }]);

      expect(store.getTaskProjectId('task-unparked-on-move')).toBe('project-b');
      expect(store.parkedTaskIds().has('task-unparked-on-move')).toBe(false);
      expect(store.parkedTasks()).toEqual([]);
    });

    it('多项目入口遇到重复任务 ID 必须在修改任何索引前拒绝', () => {
      const existing = createMockTask('existing-task');
      store.setTask(existing, 'project-existing');
      const before = store.captureState();

      expect(() => store.setTasksForMultipleProjects([
        { tasks: [createMockTask('duplicate-task')], projectId: 'project-a' },
        { tasks: [createMockTask('duplicate-task')], projectId: 'project-b' },
      ])).toThrow(/duplicate task id/i);

      expect(store.captureState()).toEqual(before);
    });
  });

  describe('bulkSetTasks', () => {
    it('批量跨项目移动后清理旧项目不得删除任务', () => {
      const original = createMockTask('task-bulk-moved', {
        updatedAt: '2026-07-15T00:00:00.000Z',
      });
      const moved = { ...original, title: 'Moved task' };
      store.setTask(original, 'project-a');

      store.bulkSetTasks([moved], 'project-b');
      store.clearProject('project-a');

      expect(store.getTask('task-bulk-moved')).toEqual(moved);
      expect(store.getTaskProjectId('task-bulk-moved')).toBe('project-b');
      expect(store.getTasksByProject('project-a')).toEqual([]);
      expect(store.getTasksByProject('project-b')).toEqual([moved]);
    });
  });
  
  describe('removeTask', () => {
    it('应该删除任务', () => {
      const task = createMockTask('task-1');
      store.setTask(task, 'project-1');
      store.removeTask('task-1', 'project-1');
      
      expect(store.getTask('task-1')).toBeUndefined();
      expect(store.tasksMap().size).toBe(0);
    });

    it('使用过期项目删除并恢复后，清理旧索引不得删除新项目实体', () => {
      const original = createMockTask('task-recovered');
      const restored = { ...original, title: 'Restored in C' };
      store.setTask(original, 'project-a');
      store.setTask(original, 'project-b');

      store.removeTask('task-recovered', 'project-a');
      store.setTask(restored, 'project-c');
      store.clearProject('project-b');

      expect(store.getTask('task-recovered')).toEqual(restored);
      expect(store.getTaskProjectId('task-recovered')).toBe('project-c');
      expect(store.getTasksByProject('project-b')).toEqual([]);
      expect(store.getTasksByProject('project-c')).toEqual([restored]);
    });
  });

  describe('bulkRemoveTasks', () => {
    it('使用过期项目批量删除并恢复后，清理旧索引不得删除新项目实体', () => {
      const original = createMockTask('task-bulk-recovered');
      const restored = { ...original, title: 'Bulk restored in C' };
      store.setTask(original, 'project-a');
      store.setTask(original, 'project-b');

      store.bulkRemoveTasks(['task-bulk-recovered'], 'project-a');
      store.setTask(restored, 'project-c');
      store.clearProject('project-b');

      expect(store.getTask('task-bulk-recovered')).toEqual(restored);
      expect(store.getTaskProjectId('task-bulk-recovered')).toBe('project-c');
      expect(store.getTasksByProject('project-b')).toEqual([]);
      expect(store.getTasksByProject('project-c')).toEqual([restored]);
    });
  });
  
  describe('getTasksByProject', () => {
    it('应该返回指定项目的所有任务', () => {
      store.setTask(createMockTask('task-1'), 'project-1');
      store.setTask(createMockTask('task-2'), 'project-1');
      store.setTask(createMockTask('task-3'), 'project-2');
      
      expect(store.getTasksByProject('project-1').length).toBe(2);
      expect(store.getTasksByProject('project-2').length).toBe(1);
    });
    
    it('应该对不存在的项目返回空数组', () => {
      expect(store.getTasksByProject('non-existent')).toEqual([]);
    });
  });
  
  describe('clearProject', () => {
    it('应该清除指定项目的所有任务', () => {
      store.setTask(createMockTask('task-1'), 'project-1');
      store.setTask(createMockTask('task-2'), 'project-2');
      
      store.clearProject('project-1');
      
      expect(store.getTasksByProject('project-1').length).toBe(0);
      expect(store.getTasksByProject('project-2').length).toBe(1);
    });
  });
  
  describe('clear', () => {
    it('应该清除所有任务', () => {
      store.setTask(createMockTask('task-1'), 'project-1');
      store.setTask(createMockTask('task-2'), 'project-2');
      
      store.clear();
      
      expect(store.tasksMap().size).toBe(0);
      expect(store.tasks().length).toBe(0);
    });
  });
});

describe('ProjectStore', () => {
  let store: ProjectStore;
  
  beforeEach(() => {
    store = new ProjectStore();
  });
  
  afterEach(() => {
    store.clear();
  });
  
  const createMockProject = (id: string): Project => ({
    id,
    name: `Project ${id}`,
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: []
  });
  
  describe('getProject - O(1) 查找', () => {
    it('应该返回存在的项目', () => {
      const project = createMockProject('project-1');
      store.setProject(project);
      
      expect(store.getProject('project-1')).toEqual(project);
    });
    
    it('应该对不存在的项目返回 undefined', () => {
      expect(store.getProject('non-existent')).toBeUndefined();
    });
  });
  
  describe('activeProject', () => {
    it('应该返回当前活动项目', () => {
      const project = createMockProject('project-1');
      store.setProject(project);
      store.activeProjectId.set('project-1');
      
      expect(store.activeProject()?.id).toBe('project-1');
    });
    
    it('应该在没有活动项目时返回 null', () => {
      expect(store.activeProject()).toBeNull();
    });
  });
  
  describe('setProjects - 批量设置', () => {
    it('应该批量设置项目', () => {
      const projects = [
        createMockProject('project-1'),
        createMockProject('project-2')
      ];
      
      store.setProjects(projects);
      
      expect(store.projectsMap().size).toBe(2);
      expect(store.projects().length).toBe(2);
    });
  });
  
  describe('removeProject', () => {
    it('应该删除项目', () => {
      store.setProject(createMockProject('project-1'));
      store.removeProject('project-1');
      
      expect(store.getProject('project-1')).toBeUndefined();
    });
    
    it('应该清除活动项目 ID（如果删除的是活动项目）', () => {
      store.setProject(createMockProject('project-1'));
      store.activeProjectId.set('project-1');
      store.removeProject('project-1');
      
      expect(store.activeProjectId()).toBeNull();
    });
  });
});

describe('ConnectionStore', () => {
  let store: ConnectionStore;
  
  beforeEach(() => {
    store = new ConnectionStore();
  });
  
  afterEach(() => {
    store.clear();
  });
  
  const createMockConnection = (id: string, overrides: Partial<Connection> = {}): Connection => ({
    id,
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  });

  describe('setConnection', () => {
    it('相同 revision 但端点变化时不得吞掉更新', () => {
      const updatedAt = '2026-07-15T00:00:00.000Z';
      store.setConnection(createMockConnection('conn-1', { updatedAt }), 'project-1');

      store.setConnection(createMockConnection('conn-1', {
        source: 'task-2',
        target: 'task-3',
        updatedAt,
      }), 'project-1');

      expect(store.getConnection('conn-1')).toMatchObject({ source: 'task-2', target: 'task-3' });
    });

    it('相同 revision 的连接跨项目移动后清理旧项目不得删除实体', () => {
      const moved = createMockConnection('conn-moved', {
        updatedAt: '2026-07-15T00:00:00.000Z',
      });
      store.setConnection(moved, 'project-a');

      store.setConnection(moved, 'project-b');
      store.clearProject('project-a');

      expect(store.getConnection('conn-moved')).toEqual(moved);
      expect(store.getConnectionsByProject('project-a')).toEqual([]);
      expect(store.getConnectionsByProject('project-b')).toEqual([moved]);
    });
  });
  
  describe('getConnection - O(1) 查找', () => {
    it('应该返回存在的连接', () => {
      const connection = createMockConnection('conn-1');
      store.setConnection(connection, 'project-1');
      
      expect(store.getConnection('conn-1')).toEqual(connection);
    });
    
    it('应该对不存在的连接返回 undefined', () => {
      expect(store.getConnection('non-existent')).toBeUndefined();
    });
  });
  
  describe('setConnections - 批量设置', () => {
    it('应该批量设置连接', () => {
      const connections = [
        createMockConnection('conn-1'),
        createMockConnection('conn-2')
      ];
      
      store.setConnections(connections, 'project-1');
      
      expect(store.connectionsMap().size).toBe(2);
      expect(store.connections().length).toBe(2);
    });

    it('整组设置跨项目移动后清理旧项目不得删除连接', () => {
      const moved = createMockConnection('conn-set-moved');
      store.setConnection(moved, 'project-a');

      store.setConnections([moved], 'project-b');
      store.clearProject('project-a');

      expect(store.getConnection('conn-set-moved')).toEqual(moved);
      expect(store.getConnectionProjectId('conn-set-moved')).toBe('project-b');
      expect(store.getConnectionsByProject('project-a')).toEqual([]);
      expect(store.getConnectionsByProject('project-b')).toEqual([moved]);
    });

    it('多项目替换应清除被移除连接实体', () => {
      store.setConnectionsForMultipleProjects([{
        projectId: 'project-1',
        connections: [createMockConnection('keep'), createMockConnection('remove')],
      }]);

      store.setConnectionsForMultipleProjects([{
        projectId: 'project-1',
        connections: [createMockConnection('keep')],
      }]);

      expect(store.getConnection('remove')).toBeUndefined();
      expect(store.getConnectionsByProject('project-1').map(connection => connection.id)).toEqual(['keep']);
    });

    it('多项目设置将连接迁入新项目后清理旧项目不得删除实体', () => {
      const moved = createMockConnection('conn-multi-moved');
      store.setConnection(moved, 'project-a');

      store.setConnectionsForMultipleProjects([{ connections: [moved], projectId: 'project-b' }]);
      store.clearProject('project-a');

      expect(store.getConnection('conn-multi-moved')).toEqual(moved);
      expect(store.getConnectionProjectId('conn-multi-moved')).toBe('project-b');
      expect(store.getConnectionsByProject('project-a')).toEqual([]);
      expect(store.getConnectionsByProject('project-b')).toEqual([moved]);
    });

    it('多项目入口遇到重复连接 ID 必须在修改任何索引前拒绝', () => {
      const existing = createMockConnection('existing-connection');
      store.setConnection(existing, 'project-existing');
      const before = store.captureState();

      expect(() => store.setConnectionsForMultipleProjects([
        { connections: [createMockConnection('duplicate-connection')], projectId: 'project-a' },
        { connections: [createMockConnection('duplicate-connection')], projectId: 'project-b' },
      ])).toThrow(/duplicate connection id/i);

      expect(store.captureState()).toEqual(before);
    });
  });

  describe('bulkSetConnections', () => {
    it('批量跨项目移动后清理旧项目不得删除连接', () => {
      const original = createMockConnection('conn-bulk-moved', {
        updatedAt: '2026-07-15T00:00:00.000Z',
      });
      const moved = { ...original, target: 'task-3' };
      store.setConnection(original, 'project-a');

      store.bulkSetConnections([moved], 'project-b');
      store.clearProject('project-a');

      expect(store.getConnection('conn-bulk-moved')).toEqual(moved);
      expect(store.getConnectionProjectId('conn-bulk-moved')).toBe('project-b');
      expect(store.getConnectionsByProject('project-a')).toEqual([]);
      expect(store.getConnectionsByProject('project-b')).toEqual([moved]);
    });
  });

  describe('removeConnection', () => {
    it('删除连接时必须同步清理反向归属索引', () => {
      store.setConnection(createMockConnection('conn-remove'), 'project-a');

      store.removeConnection('conn-remove', 'project-a');

      expect(store.getConnection('conn-remove')).toBeUndefined();
      expect(store.getConnectionProjectId('conn-remove')).toBeNull();
      expect(store.getConnectionsByProject('project-a')).toEqual([]);
    });
  });

  describe('bulkRemoveConnections', () => {
    it('批量删除连接时必须同步清理反向归属索引', () => {
      store.setConnection(createMockConnection('conn-remove-a'), 'project-a');
      store.setConnection(createMockConnection('conn-keep'), 'project-a');

      store.bulkRemoveConnections(['conn-remove-a'], 'project-a');

      expect(store.getConnection('conn-remove-a')).toBeUndefined();
      expect(store.getConnectionProjectId('conn-remove-a')).toBeNull();
      expect(store.getConnectionProjectId('conn-keep')).toBe('project-a');
      expect(store.getConnectionsByProject('project-a').map(connection => connection.id)).toEqual(['conn-keep']);
    });
  });
  
  describe('getConnectionsByProject', () => {
    it('应该返回指定项目的所有连接', () => {
      store.setConnection(createMockConnection('conn-1'), 'project-1');
      store.setConnection(createMockConnection('conn-2'), 'project-2');
      
      expect(store.getConnectionsByProject('project-1').length).toBe(1);
      expect(store.getConnectionsByProject('project-2').length).toBe(1);
    });
  });
});
