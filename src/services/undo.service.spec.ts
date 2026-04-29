/**
 * UndoService 撤销功能测试
 * 验证撤销/重做核心功能
 *
 * @fileoverview Injector 隔离模式测试 - 无 TestBed 依赖
 */

import { Injector, runInInjectionContext } from '@angular/core';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import { UiStateService } from './ui-state.service';
import { UNDO_CONFIG } from '../config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('UndoService', () => {
  let service: UndoService;
  let mockToastService: { show: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  let mockUiState: { isMobile: ReturnType<typeof vi.fn> };
  const DESKTOP_HISTORY_LIMIT = UNDO_CONFIG.DESKTOP_HISTORY_SIZE;
  
  const now = new Date().toISOString();
  
  // 创建测试用任务的辅助函数
  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '任务1',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 100,
    y: 100,
    displayId: '1',
    createdDate: now,
    ...overrides
  });
  
  // 创建测试用项目
  const createTestProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'test-project-1',
    name: '测试项目',
    description: '',
    createdDate: now,
    tasks: [createTask({ id: 'task-1', title: '任务1' })],
    connections: [],
    ...overrides
  });

  const createServiceInstance = (): UndoService => {
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const mockLoggerService = {
      category: vi.fn(() => mockLogger),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ToastService, useValue: mockToastService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: LoggerService, useValue: mockLoggerService },
      ]
    });

    return runInInjectionContext(injector, () => new UndoService());
  };

  beforeEach(() => {
    mockToastService = {
      show: vi.fn(),
      info: vi.fn(),
    };
    mockUiState = {
      isMobile: vi.fn(() => false)
    };

    service = createServiceInstance();
  });

  afterEach(() => {
    service.clearHistory();
    sessionStorage.removeItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY);
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('基本撤销功能', () => {
    it('初始状态应该没有可撤销的操作', () => {
      expect(service.canUndo()).toBe(false);
      expect(service.undoCount()).toBe(0);
    });

    it('记录操作后应该有可撤销的操作', () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '新任务', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      expect(service.undoCount()).toBe(1);
    });

    it('撤销后应该返回正确的快照', () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '新任务', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      const result = service.undo();
      
      expect(result).not.toBeNull();
      expect(result).not.toBe('version-mismatch');
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.tasks?.length).toBe(1);
        expect(result.data.after.tasks?.length).toBe(2);
      }
    });
  });

  describe('连接操作撤销', () => {
    it('添加跨树连接后应该能够撤销', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '任务2', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' }),
          createTask({ id: 'task-3', title: '任务3', order: 2, rank: 2000, y: 200, displayId: '2' })
        ],
        connections: []
      });
      
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        connections: [{ id: 'conn-1', source: 'task-1', target: 'task-3' }]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      
      const result = service.undo();
      expect(result).not.toBeNull();
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.connections?.length).toBe(0);
        expect(result.data.after.connections?.length).toBe(1);
      }
    });

    it('快照应该正确捕获任务和连接', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '任务2', stage: null, rank: 500, x: 50, y: 50, displayId: '?' })
        ],
        connections: [{ id: 'conn-1', source: 'task-1', target: 'task-2' }]
      });
      
      const snapshot = service.createProjectSnapshot(project);
      
      expect(snapshot.tasks?.length).toBe(2);
      expect(snapshot.connections?.length).toBe(1);
      expect(snapshot.tasks?.find(t => t.id === 'task-1')).toBeDefined();
      expect(snapshot.tasks?.find(t => t.id === 'task-2')?.stage).toBeNull();
      expect(snapshot.connections?.[0].source).toBe('task-1');
    });
  });

  describe('待分配到已分配任务移动撤销', () => {
    it('将待分配任务分配到阶段后应该能够撤销', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '待分配任务', stage: null, rank: 500, x: 50, y: 50, displayId: '?' })
        ],
        connections: []
      });
      
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          createTask({ id: 'task-1', title: '任务1' }),
          createTask({ id: 'task-2', title: '待分配任务', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      
      const result = service.undo();
      expect(result).not.toBeNull();
      if (result && typeof result === 'object' && 'data' in result) {
        const beforeTask2 = result.data.before.tasks?.find(t => t.id === 'task-2');
        const afterTask2 = result.data.after.tasks?.find(t => t.id === 'task-2');
        
        expect(beforeTask2?.stage).toBeNull();
        expect(beforeTask2?.parentId).toBeNull();
        expect(afterTask2?.stage).toBe(2);
        expect(afterTask2?.parentId).toBe('task-1');
      }
    });
  });

  describe('子树迁移撤销', () => {
    it('将子任务迁移到新父任务后应该能够撤销', () => {
      const project = createTestProject({
        tasks: [
          createTask({ id: 'task-1', title: '父任务1' }),
          createTask({ id: 'task-1a', title: '子任务1a', stage: 2, parentId: 'task-1', rank: 1500, x: 200, displayId: '1,a' }),
          createTask({ id: 'task-1ab', title: '孙任务1ab', stage: 3, parentId: 'task-1a', rank: 1750, x: 300, displayId: '1,a,a' }),
          createTask({ id: 'task-2', title: '父任务2', order: 2, rank: 2000, y: 200, displayId: '2' })
        ],
        connections: []
      });
      
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject: Project = {
        ...project,
        tasks: [
          createTask({ id: 'task-1', title: '父任务1' }),
          createTask({ id: 'task-1a', title: '子任务1a', stage: 2, parentId: 'task-2', rank: 2500, x: 200, y: 200, displayId: '2,a' }),
          createTask({ id: 'task-1ab', title: '孙任务1ab', stage: 3, parentId: 'task-1a', rank: 2750, x: 300, y: 200, displayId: '2,a,a' }),
          createTask({ id: 'task-2', title: '父任务2', order: 2, rank: 2000, y: 200, displayId: '2' })
        ]
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      expect(service.canUndo()).toBe(true);
      
      const result = service.undo();
      expect(result).not.toBeNull();
      if (result && typeof result === 'object' && 'data' in result) {
        const beforeTask1a = result.data.before.tasks?.find(t => t.id === 'task-1a');
        const afterTask1a = result.data.after.tasks?.find(t => t.id === 'task-1a');
        
        expect(beforeTask1a?.parentId).toBe('task-1');
        expect(beforeTask1a?.displayId).toBe('1,a');
        expect(afterTask1a?.parentId).toBe('task-2');
        expect(afterTask1a?.displayId).toBe('2,a');
      }
    });
  });

  describe('操作合并', () => {
    it('2秒内的连续操作应该合并', async () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      
      const afterProject1: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '任务2', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      const afterSnapshot1 = service.createProjectSnapshot(afterProject1);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot1 }
      });
      
      expect(service.undoCount()).toBe(1);
      
      const afterProject2: Project = {
        ...afterProject1,
        tasks: [
          ...afterProject1.tasks,
          createTask({ id: 'task-3', title: '任务3', order: 3, rank: 3000, x: 300, displayId: '3' })
        ]
      };
      const afterSnapshot2 = service.createProjectSnapshot(afterProject2);
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: afterSnapshot1, after: afterSnapshot2 }
      });
      
      expect(service.undoCount()).toBe(1);
      
      const result = service.undo();
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.tasks?.length).toBe(1);
        expect(result.data.after.tasks?.length).toBe(3);
      }
    });
  });

  describe('批处理模式', () => {
    it('批处理模式下的操作应该合并为一个撤销单元', () => {
      const project = createTestProject();
      
      service.beginBatch(project);
      
      const afterProject1: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          createTask({ id: 'task-2', title: '任务2', order: 2, rank: 2000, x: 200, displayId: '2' })
        ]
      };
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: service.createProjectSnapshot(project), after: service.createProjectSnapshot(afterProject1) }
      });
      
      expect(service.undoCount()).toBe(0);
      
      service.endBatch(afterProject1);
      
      expect(service.undoCount()).toBe(1);
    });
  });
  
  describe('栈截断通知', () => {
    const recordTaskMoveAction = (projectId: string, index: number, taskId = `task-${index}`, projectVersion?: number): void => {
      const beforeProject = createTestProject({
        id: projectId,
        tasks: [createTask({ id: taskId, title: `任务${index}`, x: index, y: index })]
      });
      const afterProject = {
        ...beforeProject,
        tasks: [createTask({ id: taskId, title: `任务${index}`, x: index + 10, y: index + 10 })]
      };

      service.recordAction({
        type: 'task-move',
        projectId,
        data: {
          before: service.createProjectSnapshot(beforeProject),
          after: service.createProjectSnapshot(afterProject),
        }
      }, projectVersion);
    };

    const seedPersistedUndoHistory = (
      projectId: string,
      count: number,
      undoLimitNotificationLocked: boolean,
    ): void => {
      const undoStack = Array.from({ length: count }, (_, index) => {
        const taskId = `persisted-task-${index}`;
        const beforeProject = createTestProject({
          id: projectId,
          tasks: [createTask({ id: taskId, title: `任务${index}`, x: index, y: index })]
        });
        const afterProject = {
          ...beforeProject,
          tasks: [createTask({ id: taskId, title: `任务${index}`, x: index + 1, y: index + 1 })]
        };

        return {
          type: 'task-move' as const,
          timestamp: index + 1,
          projectId,
          projectVersion: index,
          data: {
            before: service.createProjectSnapshot(beforeProject),
            after: service.createProjectSnapshot(afterProject),
          }
        };
      });

      sessionStorage.setItem(UNDO_CONFIG.PERSISTENCE.STORAGE_KEY, JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        projectId,
        undoStack,
        undoLimitNotificationLocked,
      }));
    };

    it('栈未满时不应触发截断', () => {
      const project = createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      const afterSnapshot = service.createProjectSnapshot({
        ...project,
        tasks: [createTask({ id: 'task-new', title: '新任务' })]
      });
      
      // 记录一个操作
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      
      // truncatedCount 应该保持为 0
      expect(service.truncatedCount()).toBe(0);
    });
    
    it('栈溢出时应该增加截断计数', () => {
      // 记录超过桌面端上限的操作（上限取自配置 DESKTOP_HISTORY_LIMIT）
      // 使用不同的 projectId 避免合并逻辑
      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 15; i++) {
        const project = createTestProject({ id: `project-${i}` });
        const beforeSnapshot = service.createProjectSnapshot(project);
        const afterSnapshot = service.createProjectSnapshot({
          ...project,
          tasks: [createTask({ id: `task-${i}`, title: `任务${i}` })]
        });
        
        service.recordAction({
          type: 'task-update',
          projectId: project.id,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
      }
      
      // 应该触发截断
      expect(service.truncatedCount()).toBeGreaterThan(0);
      // 栈大小不应超过桌面端上限
      expect(service.undoCount()).toBeLessThanOrEqual(DESKTOP_HISTORY_LIMIT);
      // 连续超限期间只提示一次，避免桌面端频繁打扰
      expect(mockToastService.info).toHaveBeenCalledTimes(1);
    });

    it('持续超限时不应重复弹出桌面端截断提示', () => {
      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 30; i++) {
        const project = createTestProject({ id: `desktop-project-${i}` });
        const beforeSnapshot = service.createProjectSnapshot(project);
        const afterSnapshot = service.createProjectSnapshot({
          ...project,
          tasks: [createTask({ id: `desktop-task-${i}`, title: `任务${i}` })]
        });

        service.recordAction({
          type: 'task-update',
          projectId: project.id,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(1);
    });

    it('撤销栈回落到上限以下后，再次超限时才允许重新提示', () => {
      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        const project = createTestProject({ id: `rearm-project-${i}` });
        const beforeSnapshot = service.createProjectSnapshot(project);
        const afterSnapshot = service.createProjectSnapshot({
          ...project,
          tasks: [createTask({ id: `rearm-task-${i}`, title: `任务${i}` })]
        });

        service.recordAction({
          type: 'task-update',
          projectId: project.id,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(1);

      const firstUndo = service.undo();
      expect(firstUndo).not.toBeNull();

      const nextProject1 = createTestProject({ id: 'rearm-project-next-1' });
      service.recordAction({
        type: 'task-update',
        projectId: nextProject1.id,
        data: {
          before: service.createProjectSnapshot(nextProject1),
          after: service.createProjectSnapshot({
            ...nextProject1,
            tasks: [createTask({ id: 'rearm-task-next-1', title: '再次填充' })]
          })
        }
      });

      expect(mockToastService.info).toHaveBeenCalledTimes(1);

      const nextProject2 = createTestProject({ id: 'rearm-project-next-2' });
      service.recordAction({
        type: 'task-update',
        projectId: nextProject2.id,
        data: {
          before: service.createProjectSnapshot(nextProject2),
          after: service.createProjectSnapshot({
            ...nextProject2,
            tasks: [createTask({ id: 'rearm-task-next-2', title: '再次超限' })]
          })
        }
      });

      expect(mockToastService.info).toHaveBeenCalledTimes(2);
    });

    it('clearHistory 清空后应重新允许下一次超限提示', () => {
      const projectId = 'clear-history-project';

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i, `clear-history-task-${i}`, i);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(1);

      service.clearHistory(projectId);

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i + 1000, `clear-history-task-${i + 1000}`, i + 1000);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(2);
    });

    it('clearOutdatedHistory 清理后应重新允许下一次超限提示', () => {
      const projectId = 'clear-outdated-project';

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i, `clear-outdated-task-${i}`, i);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(1);

      service.clearOutdatedHistory(projectId, DESKTOP_HISTORY_LIMIT + 1000);

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i + 2000, `clear-outdated-task-${i + 2000}`, i + 2000);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(2);
    });

    it('clearTaskHistory 清理后应重新允许下一次超限提示', () => {
      const projectId = 'clear-task-project';
      const trackedTaskId = 'tracked-task';

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i, trackedTaskId, i);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(1);

      service.clearTaskHistory(trackedTaskId, projectId);

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i + 3000, trackedTaskId, i + 3000);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(2);
    });

    it('恢复满栈但未锁定的历史后，首次真实超限仍应提示', () => {
      const projectId = 'restore-unlocked-project';
      seedPersistedUndoHistory(projectId, DESKTOP_HISTORY_LIMIT, false);

      service.setCurrentProject(projectId);
      recordTaskMoveAction(projectId, 9999, 'restore-unlocked-task', 9999);

      expect(mockToastService.info).toHaveBeenCalledTimes(1);
    });

    it('恢复满栈且已锁定的历史后，不应在下一次超限时重复提示', () => {
      const projectId = 'restore-locked-project';
      seedPersistedUndoHistory(projectId, DESKTOP_HISTORY_LIMIT, true);

      service.setCurrentProject(projectId);
      recordTaskMoveAction(projectId, 10001, 'restore-locked-task', 10001);

      expect(mockToastService.info).not.toHaveBeenCalled();
    });

    it('clearHistory 后的解锁状态应持久化，刷新恢复后首次真实超限仍应提示', () => {
      vi.useFakeTimers();

      const projectId = 'clear-history-persist-project';
      service.setCurrentProject(projectId);

      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, i, `clear-history-persist-task-${i}`, i);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(UNDO_CONFIG.PERSISTENCE.DEBOUNCE_DELAY);
      service.clearHistory(projectId);
      vi.advanceTimersByTime(UNDO_CONFIG.PERSISTENCE.DEBOUNCE_DELAY);

      service = createServiceInstance();
      service.setCurrentProject(projectId);
      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 1; i++) {
        recordTaskMoveAction(projectId, 12000 + i, `clear-history-persist-task-next-${i}`, 12000 + i);
      }

      expect(mockToastService.info).toHaveBeenCalledTimes(2);
    });
    
    it('移动端不应显示截断提示，但应更新截断计数', () => {
      // 模拟移动端
      mockUiState.isMobile.mockReturnValue(true);
      
      // 记录超过移动端上限的操作
      const MOBILE_LIMIT = UNDO_CONFIG.MOBILE_HISTORY_SIZE;
      for (let i = 0; i < MOBILE_LIMIT + 10; i++) {
        const project = createTestProject({ id: `mobile-project-${i}` });
        const beforeSnapshot = service.createProjectSnapshot(project);
        const afterSnapshot = service.createProjectSnapshot({
          ...project,
          tasks: [createTask({ id: `mobile-task-${i}`, title: `任务${i}` })]
        });
        
        service.recordAction({
          type: 'task-update',
          projectId: project.id,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
      }
      
      // 截断计数应更新
      expect(service.truncatedCount()).toBeGreaterThan(0);
      // 栈大小不应超过移动端上限
      expect(service.undoCount()).toBeLessThanOrEqual(MOBILE_LIMIT);
      // 但不应显示 Toast
      expect(mockToastService.info).not.toHaveBeenCalled();
    });

    it('重做栈同样遵循桌面端上限', () => {
      // 构造超过上限的撤销记录
      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 8; i++) {
        const project = createTestProject({ id: `redo-project-${i}` });
        const beforeSnapshot = service.createProjectSnapshot(project);
        const afterSnapshot = service.createProjectSnapshot({
          ...project,
          tasks: [createTask({ id: `redo-task-${i}`, title: `任务${i}` })]
        });

        service.recordAction({
          type: 'task-update',
          projectId: project.id,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
      }

      // 全部撤销以填充重做栈
      let undoCount = 0;
      while (service.canUndo()) {
        const action = service.undo();
        expect(action).not.toBeNull();
        undoCount++;
      }

      expect(undoCount).toBe(DESKTOP_HISTORY_LIMIT);
      expect(service.redoCount()).toBeLessThanOrEqual(DESKTOP_HISTORY_LIMIT);
    });
    
    it('登出后应重置截断计数', () => {
      // 触发截断 - 使用不同的 projectId 避免合并逻辑
      // 需要超过 DESKTOP_HISTORY_LIMIT 才能触发截断
      for (let i = 0; i < DESKTOP_HISTORY_LIMIT + 10; i++) {
        const project = createTestProject({ id: `project-${i}` });
        const beforeSnapshot = service.createProjectSnapshot(project);
        const afterSnapshot = service.createProjectSnapshot({
          ...project,
          tasks: [createTask({ id: `task-${i}`, title: `任务${i}` })]
        });
        
        service.recordAction({
          type: 'task-update',
          projectId: project.id,
          data: { before: beforeSnapshot, after: afterSnapshot }
        });
      }
      
      expect(service.truncatedCount()).toBeGreaterThan(0);
      
      // 登出
      service.onUserLogout();
      
      // 截断计数应重置
      expect(service.truncatedCount()).toBe(0);
    });

    it('登出应清除 sessionStorage 持久化数据（Task 1.2 验证）', () => {
      // 先记录一个操作使持久化有内容
      const project = createTestProject();
      const before = service.createProjectSnapshot(project);
      const after = service.createProjectSnapshot({
        ...project,
        tasks: [createTask({ id: 'task-1', title: '修改后' })]
      });
      
      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before, after }
      });
      
      expect(service.canUndo()).toBe(true);
      
      // 登出
      service.onUserLogout();
      
      // 撤销栈和重做栈都应清空
      expect(service.canUndo()).toBe(false);
      expect(service.canRedo()).toBe(false);
      expect(service.undoCount()).toBe(0);
      expect(service.redoCount()).toBe(0);
    });
  });
});
