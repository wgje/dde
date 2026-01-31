/**
 * 标准 Mock 工厂函数库
 * 
 * 为项目中高频使用的服务创建标准化 Mock
 * 用于去 TestBed 化的隔离测试
 * 
 * @see docs/test-architecture-modernization-plan.md Section 4.3
 */
import { vi } from 'vitest';
import { signal, DestroyRef, Injector, Provider, runInInjectionContext } from '@angular/core';
import type { Project, Task, Connection, Attachment, TaskStatus } from '../../models';

// ============================================
// 数据创建辅助函数
// ============================================

/**
 * 创建 Mock 项目
 */
export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Test Project',
    description: 'Test Description',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

/**
 * 创建 Mock 任务
 */
export function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 10000,
    status: 'active' as TaskStatus,
    x: 100,
    y: 100,
    displayId: '1',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasIncompleteTask: false,
    ...overrides,
  };
}

/**
 * 创建包含 N 个任务的项目
 */
export function createMockProjectWithTasks(taskCount: number, overrides: Partial<Project> = {}): Project {
  const tasks: Task[] = [];
  for (let i = 0; i < taskCount; i++) {
    tasks.push(createMockTask({ title: `Task ${i + 1}`, displayId: `${i + 1}` }));
  }
  return createMockProject({ tasks, ...overrides });
}

/**
 * 创建 Mock 连接
 */
export function createMockConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: crypto.randomUUID(),
    source: crypto.randomUUID(),
    target: crypto.randomUUID(),
    title: '',
    description: '',
    deletedAt: null,
    ...overrides,
  };
}

/**
 * 创建 Mock 附件
 */
export function createMockAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: crypto.randomUUID(),
    type: 'file',
    name: 'test-file.txt',
    url: 'https://mock-storage.supabase.co/test-file.txt',
    mimeType: 'text/plain',
    size: 1024,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * 创建深层嵌套的任务树（用于树遍历测试）
 */
export function createDeepNestedTasks(depth: number): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < depth; i++) {
    tasks.push(createMockTask({
      id: `task-${i}`,
      parentId: i === 0 ? null : `task-${i - 1}`,
      title: `Task Level ${i}`,
    }));
  }
  return tasks;
}

/**
 * 创建宽树结构（用于树遍历测试）
 */
export function createWideTree(childCount: number): Task[] {
  const rootTask = createMockTask({ id: 'root', parentId: null, title: 'Root Task' });
  const children = Array.from({ length: childCount }, (_, i) =>
    createMockTask({
      id: `child-${i}`,
      parentId: 'root',
      title: `Child ${i}`,
    })
  );
  return [rootTask, ...children];
}

// ============================================
// 服务 Mock 工厂函数
// ============================================

/**
 * LoggerService Mock（几乎所有服务都依赖）
 */
export const createMockLogger = () => {
  const categoryLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  
  return {
    category: vi.fn(() => categoryLogger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    _categoryLogger: categoryLogger, // 供测试断言访问
  };
};

/**
 * ToastService Mock
 */
export const createMockToast = () => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
});

/**
 * ProjectStateService Mock
 * 包含完整的 Signal 状态管理
 */
export const createMockProjectState = (initialProjects: Project[] = []) => {
  const projectsSignal = signal<Project[]>(initialProjects);
  const activeProjectIdSignal = signal<string | null>(
    initialProjects[0]?.id ?? null
  );
  
  const mock = {
    // Signals
    projects: () => projectsSignal(),
    activeProject: () => {
      const id = activeProjectIdSignal();
      return projectsSignal().find(p => p.id === id) ?? null;
    },
    activeProjectId: () => activeProjectIdSignal(),
    
    // 状态更新方法
    setProjects: vi.fn((projects: Project[]) => projectsSignal.set(projects)),
    setActiveProjectId: vi.fn((id: string | null) => activeProjectIdSignal.set(id)),
    updateProjects: vi.fn((mutator: (p: Project[]) => Project[]) => 
      projectsSignal.update(mutator)
    ),
    
    // 任务查询辅助方法
    getTask: (taskId: string): Task | undefined => {
      for (const project of projectsSignal()) {
        const task = project.tasks.find(t => t.id === taskId);
        if (task) return task;
      }
      return undefined;
    },
    
    // 更新单个任务
    updateTask: vi.fn((updatedTask: Task) => {
      projectsSignal.update(projects => 
        projects.map(p => ({
          ...p,
          tasks: p.tasks.map(t => t.id === updatedTask.id ? updatedTask : t),
        }))
      );
    }),
    
    // 内部 signal 访问（用于测试断言）
    _projectsSignal: projectsSignal,
    _activeProjectIdSignal: activeProjectIdSignal,
  };
  
  return mock;
};

/**
 * UiStateService Mock
 */
export const createMockUiState = () => {
  const selectedTaskIdSignal = signal<string | null>(null);
  const isEditingSignal = signal(false);
  
  return {
    isEditing: () => isEditingSignal(),
    isMobile: vi.fn(() => false),
    isTablet: vi.fn(() => false),
    isDesktop: vi.fn(() => true),
    markEditing: vi.fn(() => isEditingSignal.set(true)),
    clearEditing: vi.fn(() => isEditingSignal.set(false)),
    selectedTaskId: () => selectedTaskIdSignal(),
    setSelectedTaskId: vi.fn((id: string | null) => selectedTaskIdSignal.set(id)),
    _selectedTaskIdSignal: selectedTaskIdSignal,
    _isEditingSignal: isEditingSignal,
  };
};

/**
 * SyncCoordinatorService Mock
 */
export const createMockSyncCoordinator = () => ({
  markLocalChanges: vi.fn(),
  schedulePersist: vi.fn().mockResolvedValue(undefined),
  hasPendingLocalChanges: vi.fn(() => false),
  softDeleteTasksBatch: vi.fn().mockResolvedValue(0),
  pullRemoteChanges: vi.fn().mockResolvedValue(undefined),
  startBackgroundSync: vi.fn(),
  stopBackgroundSync: vi.fn(),
  forceSync: vi.fn().mockResolvedValue(undefined),
});

/**
 * OptimisticStateService Mock
 */
export const createMockOptimisticState = () => {
  const snapshots = new Map<string, unknown>();
  
  return {
    createSnapshot: vi.fn((type: string, description: string) => {
      const id = crypto.randomUUID();
      snapshots.set(id, { type, description, timestamp: Date.now() });
      return { id };
    }),
    createTaskSnapshot: vi.fn((taskId: string, description: string) => {
      const id = crypto.randomUUID();
      snapshots.set(id, { taskId, description, timestamp: Date.now() });
      return { id };
    }),
    commitSnapshot: vi.fn((snapshotId: string) => {
      snapshots.delete(snapshotId);
    }),
    rollbackSnapshot: vi.fn((snapshotId: string) => {
      snapshots.delete(snapshotId);
    }),
    hasPendingSnapshots: vi.fn(() => snapshots.size > 0),
    _snapshots: snapshots,
  };
};

/**
 * NetworkAwarenessService Mock
 */
export const createMockNetworkAwareness = () => {
  const isOnlineSignal = signal(true);
  
  return {
    isOnline: () => isOnlineSignal(),
    effectiveType: vi.fn(() => '4g'),
    downlink: vi.fn(() => 10),
    rtt: vi.fn(() => 50),
    onlineChange$: { subscribe: vi.fn() },
    setOnline: (value: boolean) => isOnlineSignal.set(value),
    _isOnlineSignal: isOnlineSignal,
  };
};

/**
 * ActionQueueService Mock
 */
export const createMockActionQueue = () => {
  const pendingQueueSignal = signal<unknown[]>([]);
  
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    pendingQueue: () => pendingQueueSignal(),
    processQueue: vi.fn().mockResolvedValue(undefined),
    clearQueue: vi.fn(() => pendingQueueSignal.set([])),
    _pendingQueueSignal: pendingQueueSignal,
  };
};

/**
 * ConflictResolutionService Mock
 */
export const createMockConflictResolution = () => ({
  resolveConflict: vi.fn((local: Task, remote: Task) => {
    // 默认 LWW 策略
    const localTime = new Date(local.updatedAt || 0).getTime();
    const remoteTime = new Date(remote.updatedAt || 0).getTime();
    return remoteTime > localTime ? remote : local;
  }),
  detectConflict: vi.fn(() => false),
  getConflictType: vi.fn(() => 'none'),
});

/**
 * UndoService Mock
 */
export const createMockUndo = () => ({
  pushState: vi.fn(),
  undo: vi.fn().mockReturnValue(true),
  redo: vi.fn().mockReturnValue(true),
  canUndo: vi.fn(() => false),
  canRedo: vi.fn(() => false),
  clear: vi.fn(),
});

/**
 * TabSyncService Mock
 */
export const createMockTabSync = () => {
  const tabId = crypto.randomUUID();
  const isLeaderSignal = signal(true);
  
  return {
    getTabId: vi.fn(() => tabId),
    isLeader: () => isLeaderSignal(),
    broadcastTaskUpdate: vi.fn(),
    broadcastProjectUpdate: vi.fn(),
    onRemoteUpdate: vi.fn(),
    setLeader: (value: boolean) => isLeaderSignal.set(value),
    _tabId: tabId,
    _isLeaderSignal: isLeaderSignal,
  };
};

/**
 * ClockSyncService Mock
 */
export const createMockClockSync = () => ({
  getServerTime: vi.fn(() => new Date()),
  getClockOffset: vi.fn(() => 0),
  syncClock: vi.fn().mockResolvedValue(undefined),
});

/**
 * EventBusService Mock
 * 用于解耦循环依赖测试
 */
export const createMockEventBus = () => {
  const mockPipe = { subscribe: vi.fn() };
  
  return {
    // Observable 流（返回可 pipe 的对象）
    onUndoRequest$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    onRedoRequest$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    onProjectSwitch$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    onSyncStatus$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    onForceSyncRequest$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    onTaskUpdate$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    onSessionRestored$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    allEvents$: { pipe: vi.fn().mockReturnValue(mockPipe) },
    lastEvent: vi.fn().mockReturnValue(null),
    
    // 发布方法
    requestUndo: vi.fn(),
    requestRedo: vi.fn(),
    publishProjectSwitch: vi.fn(),
    publishSyncStatus: vi.fn(),
    requestForceSync: vi.fn(),
    publishTaskUpdate: vi.fn(),
    publishSessionRestored: vi.fn(),
  };
};

/**
 * StorageAdapterService Mock
 */
export const createMockStorageAdapter = () => ({
  saveTask: vi.fn().mockResolvedValue(undefined),
  getTask: vi.fn().mockResolvedValue(null),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  saveProject: vi.fn().mockResolvedValue(undefined),
  getProject: vi.fn().mockResolvedValue(null),
  getAllProjects: vi.fn().mockResolvedValue([]),
  getPendingSyncQueue: vi.fn().mockResolvedValue([]),
  saveAttachmentLocally: vi.fn().mockResolvedValue(undefined),
  getLocalAttachment: vi.fn().mockResolvedValue(null),
});

/**
 * AttachmentService Mock
 */
export const createMockAttachment = () => {
  const pendingUploadsSignal = signal<unknown[]>([]);
  
  return {
    uploadAttachment: vi.fn().mockResolvedValue({ id: crypto.randomUUID(), status: 'uploaded' }),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob()),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    pendingUploads: () => pendingUploadsSignal(),
    processPendingUploads: vi.fn().mockResolvedValue(undefined),
    _pendingUploadsSignal: pendingUploadsSignal,
  };
};

// ============================================
// DestroyRef Mock（关键边界）
// ============================================

/**
 * 创建 DestroyRef Mock
 * 用于测试使用 DestroyRef 的服务/组件
 * 
 * @example
 * const { destroyRef, triggerDestroy } = createMockDestroyRef();
 * // ... 在注入器中使用 destroyRef
 * // 测试完成后调用 triggerDestroy() 模拟销毁
 */
export function createMockDestroyRef(): {
  destroyRef: Pick<DestroyRef, 'onDestroy'>;
  triggerDestroy: () => void;
  getCallbacks: () => Array<() => void>;
} {
  const callbacks: Array<() => void> = [];
  
  return {
    destroyRef: {
      onDestroy: (cb: () => void) => { 
        callbacks.push(cb); 
      }
    },
    triggerDestroy: () => { 
      callbacks.forEach(cb => cb()); 
    },
    getCallbacks: () => callbacks,
  };
}

// ============================================
// 测试辅助函数
// ============================================

/**
 * 在隔离注入上下文中创建服务实例
 * 替代 TestBed，性能提升 10x+
 * 
 * @example
 * const service = createIsolatedService(MyService, [
 *   { provide: LoggerService, useValue: createMockLogger() },
 * ]);
 */
export function createIsolatedService<T>(
  ServiceClass: new () => T,
  providers: Provider[] = []
): T {
  const injector = Injector.create({ providers });
  let service: T;
  
  runInInjectionContext(injector, () => {
    service = new ServiceClass();
  });
  
  return service!;
}

/**
 * 创建测试注入器
 */
export function createTestInjector(providers: Provider[]): Injector {
  return Injector.create({ providers });
}

/**
 * 创建受控 Promise 用于测试异步时序
 * 
 * @example
 * const { promise, resolve, reject } = createControlledPromise<void>();
 * mockService.someAsyncMethod.mockReturnValue(promise);
 * // ... 执行测试
 * resolve(); // 或 reject(new Error('fail'));
 * await flushPromises();
 */
export function createControlledPromise<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}

/**
 * 刷新 Promise 队列
 */
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * 刷新微任务队列（用于 effect 测试）
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => queueMicrotask(resolve));
}

// ============================================
// 组合 Mock（常用依赖集合）
// ============================================

/**
 * 创建标准 Mock 集合
 * 包含项目中最常用的服务 Mock
 */
export function createStandardMocks(options: {
  initialProjects?: Project[];
} = {}) {
  const logger = createMockLogger();
  const toast = createMockToast();
  const projectState = createMockProjectState(options.initialProjects);
  const uiState = createMockUiState();
  const syncCoordinator = createMockSyncCoordinator();
  const optimisticState = createMockOptimisticState();
  const networkAwareness = createMockNetworkAwareness();
  const actionQueue = createMockActionQueue();
  const undo = createMockUndo();
  const eventBus = createMockEventBus();
  const { destroyRef, triggerDestroy } = createMockDestroyRef();
  
  return {
    logger,
    toast,
    projectState,
    uiState,
    syncCoordinator,
    optimisticState,
    networkAwareness,
    actionQueue,
    undo,
    eventBus,
    destroyRef,
    triggerDestroy,
    
    /**
     * 获取 Provider 数组，用于 Injector.create
     */
    get providers(): Provider[] {
      // 动态导入避免循环依赖
      return [
        { provide: 'LoggerService', useValue: logger },
        { provide: 'ToastService', useValue: toast },
        { provide: 'ProjectStateService', useValue: projectState },
        { provide: 'UiStateService', useValue: uiState },
        { provide: 'SyncCoordinatorService', useValue: syncCoordinator },
        { provide: 'OptimisticStateService', useValue: optimisticState },
        { provide: 'NetworkAwarenessService', useValue: networkAwareness },
        { provide: 'ActionQueueService', useValue: actionQueue },
        { provide: 'UndoService', useValue: undo },
        { provide: 'EventBusService', useValue: eventBus },
        { provide: DestroyRef, useValue: destroyRef },
      ];
    },
  };
}

// ============================================
// 类型导出
// ============================================

export type MockLogger = ReturnType<typeof createMockLogger>;
export type MockToast = ReturnType<typeof createMockToast>;
export type MockProjectState = ReturnType<typeof createMockProjectState>;
export type MockUiState = ReturnType<typeof createMockUiState>;
export type MockSyncCoordinator = ReturnType<typeof createMockSyncCoordinator>;
export type MockOptimisticState = ReturnType<typeof createMockOptimisticState>;
export type MockNetworkAwareness = ReturnType<typeof createMockNetworkAwareness>;
export type MockActionQueue = ReturnType<typeof createMockActionQueue>;
export type MockUndo = ReturnType<typeof createMockUndo>;
export type MockTabSync = ReturnType<typeof createMockTabSync>;
export type MockEventBus = ReturnType<typeof createMockEventBus>;
export type MockDestroyRef = ReturnType<typeof createMockDestroyRef>;
