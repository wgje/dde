import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { ChangeTrackerService } from './change-tracker.service';
import {
  CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY,
  CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY,
} from './change-tracker-persistence.helpers';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { Task, Connection } from '../models';

describe('ChangeTrackerService', () => {
  const OWNER_A = 'owner-a';
  const OWNER_B = 'owner-b';
  let service: ChangeTrackerService;
  let currentUserId = signal<string | null>(OWNER_A);
  let persistedOwnerHint = signal<string | null>(OWNER_A);

  const createService = (): ChangeTrackerService => {
    const mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const injector = Injector.create({
      providers: [
        {
          provide: AuthService,
          useValue: {
            currentUserId,
            persistedOwnerHint,
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => mockLogger,
          },
        },
      ],
    });

    // ChangeTrackerService 内部使用 inject()，必须在注入上下文中实例化。
    return runInInjectionContext(injector, () => new ChangeTrackerService());
  };

  const getOwnerStorageKey = (baseKey: string, ownerUserId: string): string =>
    `${baseKey}.${ownerUserId}`;

  const removeTestStorage = (): void => {
    for (const baseKey of [
      CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY,
      CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY,
    ]) {
      localStorage.removeItem(baseKey);
      localStorage.removeItem(getOwnerStorageKey(baseKey, OWNER_A));
      localStorage.removeItem(getOwnerStorageKey(baseKey, OWNER_B));
    }
  };

  const setOwner = (ownerUserId: string | null, ownerHint = ownerUserId): void => {
    persistedOwnerHint.set(ownerHint);
    currentUserId.set(ownerUserId);
  };

  beforeEach(() => {
    removeTestStorage();
    currentUserId = signal<string | null>(OWNER_A);
    persistedOwnerHint = signal<string | null>(OWNER_A);
    service = createService();
  });

  afterEach(() => {
    removeTestStorage();
  });

  describe('owner-scoped persistence', () => {
    const projectId = 'project-owner-scope';
    const taskId = 'task-owner-scope';

    it('应该把待同步变更和字段锁写入带 owner 元数据的 owner-scoped key', () => {
      service.trackTaskCreate(projectId, { ...createMockTask(), id: taskId });
      service.lockTaskField(taskId, projectId, 'title', 60_000);

      expect(localStorage.getItem(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY)).toBeNull();

      const pendingSnapshot = JSON.parse(
        localStorage.getItem(getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, OWNER_A)) ?? 'null',
      );
      const fieldLockSnapshot = JSON.parse(
        localStorage.getItem(getOwnerStorageKey(CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY, OWNER_A)) ?? 'null',
      );
      expect(pendingSnapshot).toMatchObject({ ownerUserId: OWNER_A });
      expect(fieldLockSnapshot).toMatchObject({ ownerUserId: OWNER_A });
    });

    it('认证尚未 settle 时应该按 persisted owner hint 恢复 B，且不读取 A bucket', () => {
      localStorage.setItem(
        getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, OWNER_A),
        createOwnerPendingSnapshot(OWNER_A, projectId, 'task-a'),
      );
      localStorage.setItem(
        getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, OWNER_B),
        createOwnerPendingSnapshot(OWNER_B, projectId, 'task-b'),
      );
      currentUserId.set(null);
      persistedOwnerHint.set(OWNER_B);

      const recoveredService = createService();

      expect(recoveredService.exportPendingChanges().map(change => change.entityId)).toEqual(['task-b']);
    });

    it('A -> B -> A 应隔离内存变更和同 key 字段锁，并恢复各自持久化 bucket', () => {
      service.trackTaskCreate(projectId, { ...createMockTask(), id: 'task-a' });
      service.lockTaskField(taskId, projectId, 'title', 60_000);

      setOwner(OWNER_B);

      expect(service.exportPendingChanges()).toEqual([]);
      expect(service.isTaskFieldLocked(taskId, projectId, 'title')).toBe(false);

      service.trackTaskCreate(projectId, { ...createMockTask(), id: 'task-b' });
      service.lockTaskField(taskId, projectId, 'title', 60_000);
      service.clearAllChanges();

      const ownerAPendingSnapshot = JSON.parse(localStorage.getItem(
        getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, OWNER_A),
      ) ?? 'null') as { ownerUserId?: string; changes?: Array<{ entityId?: string }> };
      expect(ownerAPendingSnapshot.ownerUserId).toBe(OWNER_A);
      expect(ownerAPendingSnapshot.changes?.map(change => change.entityId)).toEqual(['task-a']);

      setOwner(OWNER_A);

      expect(service.exportPendingChanges().map(change => change.entityId)).toEqual(['task-a']);
      expect(service.isTaskFieldLocked(taskId, projectId, 'title')).toBe(true);
    });

    it('legacy ownerless 快照应保留原始字节且不能归给当前 owner', () => {
      const pendingSnapshot = createOwnerlessPendingSnapshot(projectId, 'legacy-task');
      const fieldLockSnapshot = createOwnerlessFieldLockSnapshot(projectId, taskId);
      localStorage.setItem(
        CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY,
        pendingSnapshot,
      );
      localStorage.setItem(
        CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY,
        fieldLockSnapshot,
      );

      const recoveredService = createService();

      expect(recoveredService.exportPendingChanges()).toEqual([]);
      expect(recoveredService.isTaskFieldLocked(taskId, projectId, 'title')).toBe(false);
      expect(localStorage.getItem(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY)).toBe(pendingSnapshot);
      expect(localStorage.getItem(CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY)).toBe(fieldLockSnapshot);
    });

    it('scoped key 中 owner 元数据不匹配时应保留原始字节并 fail closed', () => {
      const storageKey = getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, OWNER_A);
      const raw = createOwnerPendingSnapshot(OWNER_B, projectId, 'foreign-task');
      localStorage.setItem(storageKey, raw);

      const recoveredService = createService();

      expect(recoveredService.exportPendingChanges()).toEqual([]);
      expect(localStorage.getItem(storageKey)).toBe(raw);
    });

    it('损坏的 scoped 快照应 fail closed 且保留原始字节供诊断', () => {
      const storageKey = getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, OWNER_A);
      const raw = '{broken-json';
      localStorage.setItem(storageKey, raw);

      const recoveredService = createService();

      expect(recoveredService.exportPendingChanges()).toEqual([]);
      expect(localStorage.getItem(storageKey)).toBe(raw);
    });
  });

  describe('任务变更追踪', () => {
    const mockTask: Task = {
      id: 'task-1',
      title: 'Test Task',
      content: 'Test Content',
      parentId: null,
      stage: 1,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      hasIncompleteTask: false,
      createdDate: new Date().toISOString()
    };

    it('应该追踪任务创建', () => {
      service.trackTaskCreate('project-1', mockTask);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToCreate).toHaveLength(1);
      expect(changes.tasksToCreate[0].id).toBe('task-1');
      expect(changes.hasChanges).toBe(true);
    });

    it('应该追踪任务更新', () => {
      service.trackTaskUpdate('project-1', mockTask, ['title', 'content']);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToUpdate).toHaveLength(1);
      expect(changes.tasksToUpdate[0].id).toBe('task-1');
    });

    it('应该追踪任务删除', () => {
      service.trackTaskDelete('project-1', 'task-1');

      const changes = service.getProjectChanges('project-1');
      expect(changes.taskIdsToDelete).toHaveLength(1);
      expect(changes.taskIdsToDelete[0]).toBe('task-1');
    });

    it('任务删除应保留删除前 updatedAt 作为服务端 CAS base', () => {
      service.trackTaskDelete('project-1', 'task-1', {
        ...mockTask,
        updatedAt: '2026-05-14T09:20:00.000Z',
      });

      const changes = service.getProjectChanges('project-1');
      expect(changes.taskIdsToDelete).toEqual(['task-1']);
      expect(changes.taskDeleteBaseUpdatedAtMap).toEqual({
        'task-1': '2026-05-14T09:20:00.000Z',
      });
    });

    it('刷新后应恢复待同步删除意图和 CAS base', () => {
      service.trackTaskDelete('project-1', 'task-1', {
        ...mockTask,
        updatedAt: '2026-05-14T09:20:00.000Z',
      });

      const recoveredService = createService();

      const changes = recoveredService.getProjectChanges('project-1');
      expect(changes.taskIdsToDelete).toEqual(['task-1']);
      expect(changes.taskDeleteBaseUpdatedAtMap).toEqual({
        'task-1': '2026-05-14T09:20:00.000Z',
      });
    });

    it('创建后删除应该抵消', () => {
      service.trackTaskCreate('project-1', mockTask);
      service.trackTaskDelete('project-1', 'task-1');

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToCreate).toHaveLength(0);
      expect(changes.taskIdsToDelete).toHaveLength(0);
      expect(changes.hasChanges).toBe(false);
    });

    it('删除后创建应该变为更新', () => {
      service.trackTaskDelete('project-1', 'task-1');
      service.trackTaskCreate('project-1', mockTask);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToUpdate).toHaveLength(1);
      expect(changes.taskIdsToDelete).toHaveLength(0);
    });

    it('多次更新应该合并字段', () => {
      service.trackTaskUpdate('project-1', mockTask, ['title']);
      service.trackTaskUpdate('project-1', { ...mockTask, content: 'Updated' }, ['content']);

      const changes = service.getProjectChanges('project-1');
      expect(changes.tasksToUpdate).toHaveLength(1);
      // 验证最终数据是最新的
      expect(changes.tasksToUpdate[0].content).toBe('Updated');
    });
  });

  describe('连接变更追踪', () => {
    const mockConnection: Connection = {
      id: 'conn-1',
      source: 'task-1',
      target: 'task-2',
      description: 'Test connection'
    };

    it('应该追踪连接创建', () => {
      service.trackConnectionCreate('project-1', mockConnection);

      const changes = service.getProjectChanges('project-1');
      expect(changes.connectionsToCreate).toHaveLength(1);
      expect(changes.connectionsToCreate[0].source).toBe('task-1');
      expect(changes.connectionsToCreate[0].target).toBe('task-2');
    });

    it('应该追踪连接删除', () => {
      service.trackConnectionDelete('project-1', mockConnection);

      const changes = service.getProjectChanges('project-1');
      expect(changes.connectionsToDelete).toHaveLength(1);
      expect(changes.connectionsToDelete[0]).toEqual({ id: 'conn-1', source: 'task-1', target: 'task-2' });
    });

    it('创建后删除应该抵消', () => {
      service.trackConnectionCreate('project-1', mockConnection);
      service.trackConnectionDelete('project-1', mockConnection);

      const changes = service.getProjectChanges('project-1');
      expect(changes.connectionsToCreate).toHaveLength(0);
      expect(changes.connectionsToDelete).toHaveLength(0);
      expect(changes.hasChanges).toBe(false);
    });

    it('同端点但不同 id 的连接不应在待同步队列中互相覆盖', () => {
      service.trackConnectionCreate('project-1', mockConnection);
      service.trackConnectionCreate('project-1', {
        ...mockConnection,
        id: 'conn-2',
        description: 'Another connection with same endpoints'
      });

      const changes = service.getProjectChanges('project-1');

      expect(changes.connectionsToCreate).toHaveLength(2);
      expect(changes.connectionsToCreate.map(connection => connection.id)).toEqual(['conn-1', 'conn-2']);
    });
  });

  describe('项目级操作', () => {
    it('应该按项目隔离变更', () => {
      const task1: Task = { ...createMockTask(), id: 'task-1' };
      const task2: Task = { ...createMockTask(), id: 'task-2' };

      service.trackTaskCreate('project-1', task1);
      service.trackTaskCreate('project-2', task2);

      const changes1 = service.getProjectChanges('project-1');
      const changes2 = service.getProjectChanges('project-2');

      expect(changes1.tasksToCreate).toHaveLength(1);
      expect(changes1.tasksToCreate[0].id).toBe('task-1');
      expect(changes2.tasksToCreate).toHaveLength(1);
      expect(changes2.tasksToCreate[0].id).toBe('task-2');
    });

    it('应该正确清除项目变更', () => {
      service.trackTaskCreate('project-1', createMockTask());
      service.trackTaskCreate('project-2', { ...createMockTask(), id: 'task-2' });

      service.clearProjectChanges('project-1');

      expect(service.hasProjectChanges('project-1')).toBe(false);
      expect(service.hasProjectChanges('project-2')).toBe(true);
    });

    it('应该返回所有有变更的项目ID', () => {
      service.trackTaskCreate('project-1', createMockTask());
      service.trackTaskCreate('project-2', { ...createMockTask(), id: 'task-2' });
      service.trackTaskCreate('project-3', { ...createMockTask(), id: 'task-3' });

      const projectIds = service.getChangedProjectIds();
      expect(projectIds).toHaveLength(3);
      expect(projectIds).toContain('project-1');
      expect(projectIds).toContain('project-2');
      expect(projectIds).toContain('project-3');
    });
  });

  describe('过期变更清理', () => {
    it('应保留 predicate 认领的 durable 记录并清理其余过期记录', () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      service.trackTaskUpdate('project-1', { ...createMockTask(), id: 'task-durable' }, ['status']);
      service.trackTaskUpdate('project-1', { ...createMockTask(), id: 'task-expired' }, ['title']);
      nowSpy.mockReturnValue(2_000);

      try {
        const tracker = service as unknown as {
          pruneExpiredChanges(
            maxAgeMs: number,
            preserveExpired: (record: { entityId: string }) => boolean,
          ): number;
        };
        const cleaned = tracker.pruneExpiredChanges(500, record => record.entityId === 'task-durable');

        expect(cleaned).toBe(1);
        expect(service.getProjectChanges('project-1').tasksToUpdate.map(task => task.id))
          .toEqual(['task-durable']);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('统计和信号', () => {
    it('应该正确更新待同步变更数量', () => {
      expect(service.pendingChangeCount()).toBe(0);

      service.trackTaskCreate('project-1', createMockTask());
      expect(service.pendingChangeCount()).toBe(1);

      service.trackTaskCreate('project-1', { ...createMockTask(), id: 'task-2' });
      expect(service.pendingChangeCount()).toBe(2);

      service.clearProjectChanges('project-1');
      expect(service.pendingChangeCount()).toBe(0);
    });

    it('应该在相同毫秒内保留 batch 水位之后的新编辑', () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      const task = createMockTask();

      try {
        service.trackTaskUpdate('project-1', task, ['title']);
        const batchRevision = service.getCurrentChangeRevision();

        service.trackTaskUpdate('project-1', { ...task, title: 'Updated after snapshot' }, ['title']);

        expect(service.clearTaskChangeIfFresh('project-1', task.id, batchRevision)).toBe(false);
        expect(service.getProjectChanges('project-1').tasksToUpdate[0]?.title).toBe('Updated after snapshot');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('数据完整性验证', () => {
    it('应该检测更新不存在的任务', () => {
      const task = createMockTask();
      service.trackTaskUpdate('project-1', task, ['title']);

      const validation = service.validateChanges('project-1', [], []);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(`待更新的任务 ${task.id} 在当前项目中不存在，无法执行更新操作`);
    });

    it('应该检测删除不存在的任务', () => {
      service.trackTaskDelete('project-1', 'non-existent-task');

      const validation = service.validateChanges('project-1', [], []);
      expect(validation.valid).toBe(true); // 删除不存在的任务是警告，不是错误
      expect(validation.warnings.length).toBeGreaterThan(0);
    });

    it('应该检测创建已存在的任务', () => {
      const task = createMockTask();
      service.trackTaskCreate('project-1', task);

      const validation = service.validateChanges('project-1', [task], []);
      expect(validation.valid).toBe(true);
      expect(validation.warnings).toContain(`待创建的任务 ${task.id} 已存在，将执行更新操作而非创建`);
    });

    it('应该检测孤儿任务（父任务被删除）', () => {
      const parentTask = { ...createMockTask(), id: 'parent-1' };
      const childTask = { ...createMockTask(), id: 'child-1', parentId: 'parent-1' };

      service.trackTaskDelete('project-1', 'parent-1');

      const validation = service.validateChanges('project-1', [parentTask, childTask], []);
      expect(validation.valid).toBe(true);
      expect(validation.warnings.some(w => w.includes('将变为孤儿任务'))).toBe(true);
      expect(validation.recommendations.length).toBeGreaterThan(0);
    });

    it('应该检测连接引用不存在的任务', () => {
      const conn: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        description: 'test'
      };

      service.trackConnectionCreate('project-1', conn);

      const validation = service.validateChanges('project-1', [], []);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('不存在'))).toBe(true);
    });

    it('应该在变更比例过高时给出建议', () => {
      // 创建25个任务（超过20个阈值）
      const tasks = Array.from({ length: 25 }, (_, i) => ({
        ...createMockTask(),
        id: `task-${i}`
      }));

      // 标记85%的任务为更新（21个）
      for (let i = 0; i < 21; i++) {
        service.trackTaskUpdate('project-1', tasks[i], ['title']);
      }

      const validation = service.validateChanges('project-1', tasks, []);
      expect(validation.valid).toBe(true);
      expect(validation.recommendations.some(r => r.includes('变更比例过高'))).toBe(true);
    });
  });

  describe('数据丢失风险检测', () => {
    it('应该检测高风险：更新不存在的任务', () => {
      const task = createMockTask();
      service.trackTaskUpdate('project-1', task, ['title']);

      const risks = service.detectDataLossRisks('project-1', [], []);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.severity === 'high' && r.type === 'task-missing')).toBe(true);
    });

    it('应该检测中风险：连接孤儿化', () => {
      const task1 = { ...createMockTask(), id: 'task-1' };
      const task2 = { ...createMockTask(), id: 'task-2' };
      const conn: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        description: 'test'
      };

      service.trackTaskDelete('project-1', 'task-1');

      const risks = service.detectDataLossRisks('project-1', [task1, task2], [conn]);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.severity === 'medium' && r.type === 'connection-orphan')).toBe(true);
    });

    it('应该检测中风险：父子任务不一致', () => {
      const parentTask = { ...createMockTask(), id: 'parent-1' };
      const childTask = { ...createMockTask(), id: 'child-1', parentId: 'parent-1' };

      service.trackTaskDelete('project-1', 'parent-1');

      const risks = service.detectDataLossRisks('project-1', [parentTask, childTask], []);
      expect(risks.hasRisk).toBe(true);
      expect(risks.risks.some(r => r.type === 'parent-child-inconsistency')).toBe(true);
    });

    it('应该检测低风险：重复操作', () => {
      const task = createMockTask();
      service.trackTaskCreate('project-1', task);

      const risks = service.detectDataLossRisks('project-1', [task], []);
      expect(risks.risks.some(r => r.severity === 'low' && r.type === 'duplicate-operation')).toBe(true);
    });

    it('无风险情况应该返回空风险列表', () => {
      const task = createMockTask();
      service.trackTaskUpdate('project-1', task, ['title']);

      const risks = service.detectDataLossRisks('project-1', [task], []);
      expect(risks.hasRisk).toBe(false);
      expect(risks.risks).toHaveLength(0);
    });
  });

  describe('变更报告生成', () => {
    it('应该生成正确的变更报告', () => {
      service.trackTaskCreate('project-1', createMockTask());
      service.trackTaskUpdate('project-1', { ...createMockTask(), id: 'task-2' }, ['title']);
      service.trackTaskDelete('project-1', 'task-3');

      const report = service.generateChangeReport('project-1');
      expect(report).toContain('项目 project-1 变更摘要');
      expect(report).toContain('总变更数: 3');
      expect(report).toContain('待创建: 1');
      expect(report).toContain('待更新: 1');
      expect(report).toContain('待删除: 1');
    });

    it('无变更时应该返回简单消息', () => {
      const report = service.generateChangeReport('project-1');
      expect(report).toContain('无待同步变更');
    });
  });

  describe('字段锁机制', () => {
    const projectId = 'project-1';
    const taskId = 'task-1';

    it('应该正确锁定和解锁任务字段', () => {
      // 初始状态：未锁定
      expect(service.isTaskFieldLocked(taskId, projectId, 'status')).toBe(false);

      // 锁定
      service.lockTaskField(taskId, projectId, 'status');
      expect(service.isTaskFieldLocked(taskId, projectId, 'status')).toBe(true);

      // 解锁
      service.unlockTaskField(taskId, projectId, 'status');
      expect(service.isTaskFieldLocked(taskId, projectId, 'status')).toBe(false);
    });

    it('应该隔离不同任务的字段锁', () => {
      service.lockTaskField('task-1', projectId, 'title');
      service.lockTaskField('task-2', projectId, 'content');

      expect(service.isTaskFieldLocked('task-1', projectId, 'title')).toBe(true);
      expect(service.isTaskFieldLocked('task-1', projectId, 'content')).toBe(false);
      expect(service.isTaskFieldLocked('task-2', projectId, 'title')).toBe(false);
      expect(service.isTaskFieldLocked('task-2', projectId, 'content')).toBe(true);
    });

    it('应该隔离不同项目的字段锁', () => {
      service.lockTaskField(taskId, 'project-1', 'status');
      service.lockTaskField(taskId, 'project-2', 'title');

      expect(service.isTaskFieldLocked(taskId, 'project-1', 'status')).toBe(true);
      expect(service.isTaskFieldLocked(taskId, 'project-1', 'title')).toBe(false);
      expect(service.isTaskFieldLocked(taskId, 'project-2', 'status')).toBe(false);
      expect(service.isTaskFieldLocked(taskId, 'project-2', 'title')).toBe(true);
    });

    it('应该支持自定义锁定时长', () => {
      // 锁定 50ms
      service.lockTaskField(taskId, projectId, 'status', 50);
      expect(service.isTaskFieldLocked(taskId, projectId, 'status')).toBe(true);
    });

    it('刷新后应恢复未过期字段锁以防止远端旧字段覆盖本地编辑', () => {
      service.lockTaskField(taskId, projectId, 'title', 60_000);

      const recoveredService = createService();

      expect(recoveredService.isTaskFieldLocked(taskId, projectId, 'title')).toBe(true);
      expect(recoveredService.getLockedFields(taskId, projectId)).toEqual(['title']);
    });

    it('应该在超时后自动解锁', async () => {
      vi.useFakeTimers();
      try {
        // 锁定 10ms（非常短）
        service.lockTaskField(taskId, projectId, 'status', 10);
        expect(service.isTaskFieldLocked(taskId, projectId, 'status')).toBe(true);

        // 快进时间超过锁定时长
        await vi.advanceTimersByTimeAsync(20);

        // 超时后应该自动解锁
        expect(service.isTaskFieldLocked(taskId, projectId, 'status')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('应该正确获取被锁定的字段列表', () => {
      service.lockTaskField(taskId, projectId, 'status');
      service.lockTaskField(taskId, projectId, 'title');
      service.lockTaskField(taskId, projectId, 'content');

      const lockedFields = service.getLockedFields(taskId, projectId);
      expect(lockedFields).toHaveLength(3);
      expect(lockedFields).toContain('status');
      expect(lockedFields).toContain('title');
      expect(lockedFields).toContain('content');
    });

    it('应该正确解锁任务的所有字段', () => {
      service.lockTaskField(taskId, projectId, 'status');
      service.lockTaskField(taskId, projectId, 'title');
      service.lockTaskField(taskId, projectId, 'content');

      service.unlockAllTaskFields(taskId, projectId);

      expect(service.getLockedFields(taskId, projectId)).toHaveLength(0);
    });

    it('解锁所有字段时不应影响其他任务的锁', () => {
      service.lockTaskField('task-1', projectId, 'status');
      service.lockTaskField('task-2', projectId, 'status');

      service.unlockAllTaskFields('task-1', projectId);

      expect(service.isTaskFieldLocked('task-1', projectId, 'status')).toBe(false);
      expect(service.isTaskFieldLocked('task-2', projectId, 'status')).toBe(true);
    });

    it('getLockedFields 应该过滤掉超时的锁', async () => {
      vi.useFakeTimers();
      try {
        // 锁定两个字段，一个短超时，一个长超时
        service.lockTaskField(taskId, projectId, 'status', 10); // 10ms
        service.lockTaskField(taskId, projectId, 'title', 5000); // 5s

        // 快进时间让短超时过期
        await vi.advanceTimersByTimeAsync(20);

        const lockedFields = service.getLockedFields(taskId, projectId);
        expect(lockedFields).toHaveLength(1);
        expect(lockedFields).toContain('title');
        expect(lockedFields).not.toContain('status');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clearProjectFieldLocks 应该清除项目所有字段锁', () => {
      service.lockTaskField('task-1', projectId, 'status');
      service.lockTaskField('task-2', projectId, 'title');
      service.lockTaskField('task-1', 'project-2', 'content');

      service.clearProjectFieldLocks(projectId);

      expect(service.isTaskFieldLocked('task-1', projectId, 'status')).toBe(false);
      expect(service.isTaskFieldLocked('task-2', projectId, 'title')).toBe(false);
      // 其他项目的锁不应受影响
      expect(service.isTaskFieldLocked('task-1', 'project-2', 'content')).toBe(true);
    });
  });
});

function createMockTask(): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    content: 'Test Content',
    parentId: null,
    stage: 1,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: '1',
    hasIncompleteTask: false,
    createdDate: new Date().toISOString()
  };
}

function createOwnerPendingSnapshot(
  ownerUserId: string,
  projectId: string,
  taskId: string,
): string {
  return JSON.stringify({
    version: 1,
    ownerUserId,
    changes: [
      {
        entityId: taskId,
        entityType: 'task',
        changeType: 'create',
        projectId,
        timestamp: Date.now(),
        revision: Date.now(),
        data: { ...createMockTask(), id: taskId },
      },
    ],
    savedAt: new Date().toISOString(),
  });
}

function createOwnerlessPendingSnapshot(projectId: string, taskId: string): string {
  const snapshot = JSON.parse(createOwnerPendingSnapshot('legacy-owner', projectId, taskId)) as {
    ownerUserId?: string;
  };
  delete snapshot.ownerUserId;
  return JSON.stringify(snapshot);
}

function createOwnerlessFieldLockSnapshot(projectId: string, taskId: string): string {
  return JSON.stringify({
    version: 1,
    locks: [
      [
        `${projectId}:${taskId}:title`,
        { timestamp: Date.now(), duration: 60_000 },
      ],
    ],
    savedAt: new Date().toISOString(),
  });
}
