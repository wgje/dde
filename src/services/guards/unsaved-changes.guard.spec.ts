/**
 * UnsavedChangesGuard 单元测试
 * 
 * 覆盖场景：
 * - 无未保存更改时允许离开
 * - 有未保存更改时显示确认
 * - 自动保存成功后允许离开
 * - 自动保存失败后提示
 * - 非保护路由直接允许离开
 * - BeforeUnload 保护
 * - 项目切换保护
 * 
 * 性能优化：
 * - 使用 fake timers 避免 5s 超时等待
 * - 测试执行时间从 20s+ 降至 <1s
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { 
  UnsavedChangesGuard, 
  BeforeUnloadGuardService,
  ProjectSwitchGuardService,
  ROUTE_LEAVE_PROTECTION_CONFIG,
  CanLeave
} from './unsaved-changes.guard';
import { SyncStateService } from '../../core-bridge';
import { LoggerService } from '../logger.service';
import { BeforeUnloadManagerService } from '../before-unload-manager.service';
import { SyncCoordinatorService } from '../sync-coordinator.service';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

describe('UnsavedChangesGuard', () => {
  let guard: UnsavedChangesGuard;
  let mockSyncService: {
    syncState: ReturnType<typeof vi.fn>;
  };
  let mockSyncCoordinator: {
    flushPendingPersist: ReturnType<typeof vi.fn>;
    flushPendingPersistToCloud: ReturnType<typeof vi.fn>;
    hasPendingLocalChanges: ReturnType<typeof vi.fn>;
  };
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSyncService = {
      syncState: vi.fn().mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
        isOnline: true,
      }),
    };
    mockSyncCoordinator = {
      flushPendingPersist: vi.fn(),
      flushPendingPersistToCloud: vi.fn().mockResolvedValue(false),
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
    };
    
    const injector = Injector.create({
      providers: [
        UnsavedChangesGuard,
        { provide: SyncStateService, useValue: mockSyncService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    runInInjectionContext(injector, () => {
      guard = injector.get(UnsavedChangesGuard);
    });
  });
  
  afterEach(() => {
    if (typeof vi.clearAllTimers === 'function') {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
  });
  
  function createRouteSnapshot(url: string): RouterStateSnapshot {
    return { url } as RouterStateSnapshot;
  }
  
  function createActivatedRouteSnapshot(): ActivatedRouteSnapshot {
    return {} as ActivatedRouteSnapshot;
  }
  
  /**
   * 辅助函数：执行 canDeactivate 并快进超时
   * 用于测试有 pendingChanges 的场景，避免等待真实的 5s 超时
   */
  async function canDeactivateWithFakeTimers(
    component: unknown,
    currentUrl: string,
    nextUrl: string
  ): Promise<boolean> {
    vi.useFakeTimers();

    const resultPromise = guard.canDeactivate(
      component,
      createActivatedRouteSnapshot(),
      createRouteSnapshot(currentUrl),
      createRouteSnapshot(nextUrl)
    );
    
    await vi.advanceTimersByTimeAsync(
      ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_TIMEOUT + 1
    );
    
    return resultPromise;
  }
  
  describe('canDeactivate', () => {
    it('无未保存更改时应允许离开', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/123'),
        createRouteSnapshot('/home')
      );
      
      expect(result).toBe(true);
    });
    
    it('非保护路由应直接允许离开', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 5,
        isSyncing: false,
      });
      
      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/settings'),
        createRouteSnapshot('/home')
      );
      
      expect(result).toBe(true);
    });
    
    it('有未保存更改时应显示确认对话框', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      
      const result = await canDeactivateWithFakeTimers(
        null,
        '/projects/123',
        '/home'
      );
      
      expect(confirmSpy).toHaveBeenCalled();
      expect(result).toBe(true);
      
      confirmSpy.mockRestore();
    });
    
    it('用户取消离开时应返回 false', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      
      const result = await canDeactivateWithFakeTimers(
        null,
        '/projects/123',
        '/home'
      );
      
      expect(result).toBe(false);
      
      confirmSpy.mockRestore();
    });
    
    it('组件实现 CanLeave 时应使用组件逻辑', async () => {
      const mockComponent: CanLeave = {
        canLeave: vi.fn().mockResolvedValue(true),
      };
      
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 5,
        isSyncing: false,
      });
      
      const result = await guard.canDeactivate(
        mockComponent,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/123'),
        createRouteSnapshot('/home')
      );
      
      expect(mockComponent.canLeave).toHaveBeenCalled();
      expect(result).toBe(true);
    });
    
    it('正在同步时应视为有未保存更改', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: true,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      
      await canDeactivateWithFakeTimers(
        null,
        '/projects/123',
        '/home'
      );
      
      expect(confirmSpy).toHaveBeenCalled();
      
      confirmSpy.mockRestore();
    });

    it('本地待持久化标记存在时应进入离开保护', async () => {
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/project-1/text'),
        createRouteSnapshot('/projects'),
      );

      expect(result).toBe(false);
      expect(mockSyncCoordinator.flushPendingPersistToCloud).toHaveBeenCalledWith(
        'route-leave',
        { force: true },
      );
      expect(confirmSpy).toHaveBeenCalledWith(ROUTE_LEAVE_PROTECTION_CONFIG.SAVE_FAILED_MESSAGE);
      confirmSpy.mockRestore();
    });

    it('云端 flush 返回 false 时，即使同步计数清空也必须征求确认', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      mockSyncCoordinator.flushPendingPersistToCloud.mockImplementation(async () => {
        mockSyncService.syncState.mockReturnValue({
          pendingCount: 0,
          isSyncing: false,
        });
        return false;
      });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/project-1/text'),
        createRouteSnapshot('/projects'),
      );

      expect(result).toBe(false);
      expect(confirmSpy).toHaveBeenCalledWith(ROUTE_LEAVE_PROTECTION_CONFIG.SAVE_FAILED_MESSAGE);
      confirmSpy.mockRestore();
    });

    it('云端 flush 超时后应征求确认', async () => {
      vi.useFakeTimers();
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      mockSyncCoordinator.flushPendingPersistToCloud.mockReturnValue(
        new Promise<boolean>(() => undefined),
      );
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const resultPromise = guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/project-1/text'),
        createRouteSnapshot('/projects'),
      );
      await vi.advanceTimersByTimeAsync(ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_TIMEOUT + 1);
      const result = await resultPromise;

      expect(result).toBe(false);
      expect(confirmSpy).toHaveBeenCalledWith(ROUTE_LEAVE_PROTECTION_CONFIG.SAVE_FAILED_MESSAGE);
      confirmSpy.mockRestore();
    });

    it('云端 flush 成功但本地 dirty 标记未清除时仍应征求确认', async () => {
      vi.useFakeTimers();
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      mockSyncCoordinator.flushPendingPersistToCloud.mockImplementation(async () => {
        mockSyncService.syncState.mockReturnValue({
          pendingCount: 0,
          isSyncing: false,
        });
        return true;
      });
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const resultPromise = guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/project-1/text'),
        createRouteSnapshot('/projects'),
      );
      await vi.advanceTimersByTimeAsync(ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_TIMEOUT + 1);
      const result = await resultPromise;

      expect(result).toBe(false);
      expect(confirmSpy).toHaveBeenCalledWith(ROUTE_LEAVE_PROTECTION_CONFIG.SAVE_FAILED_MESSAGE);
      confirmSpy.mockRestore();
    });

    it('真实项目子路由离开前应触发本地与云端 flush，并清理成功路径超时 timer', async () => {
      vi.useFakeTimers();
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 2,
        isSyncing: false,
      });
      mockSyncCoordinator.flushPendingPersistToCloud.mockImplementation(async () => {
        mockSyncService.syncState.mockReturnValue({
          pendingCount: 0,
          isSyncing: false,
        });
        return true;
      });
      const confirmSpy = vi.spyOn(window, 'confirm');

      const result = await guard.canDeactivate(
        null,
        createActivatedRouteSnapshot(),
        createRouteSnapshot('/projects/project-1/text'),
        createRouteSnapshot('/projects'),
      );

      expect(result).toBe(true);
      expect(mockSyncCoordinator.flushPendingPersist).toHaveBeenCalledTimes(1);
      expect(mockSyncCoordinator.flushPendingPersistToCloud).toHaveBeenCalledWith(
        'route-leave',
        { force: true },
      );
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      confirmSpy.mockRestore();
    });
  });
  
  describe('hasPendingChanges', () => {
    it('pendingCount > 0 时应返回 true', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      
      expect(guard.hasPendingChanges()).toBe(true);
    });
    
    it('isSyncing 为 true 时应返回 true', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: true,
      });
      
      expect(guard.hasPendingChanges()).toBe(true);
    });
    
    it('无待处理更改时应返回 false', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      expect(guard.hasPendingChanges()).toBe(false);
    });

    it('本地 dirty 标记应算作待处理更改', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);

      expect(guard.hasPendingChanges()).toBe(true);
    });
  });
});

describe('BeforeUnloadGuardService', () => {
  let service: BeforeUnloadGuardService;
  let mockSyncService: {
    syncState: ReturnType<typeof vi.fn>;
  };
  let mockSyncCoordinator: {
    hasPendingLocalChanges: ReturnType<typeof vi.fn>;
  };
  let mockBeforeUnloadManager: {
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
  };
  let registeredCallback: (() => boolean) | null = null;
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCallback = null;
    
    mockSyncService = {
      syncState: vi.fn().mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      }),
    };
    mockSyncCoordinator = {
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
    };
    mockBeforeUnloadManager = {
      register: vi.fn((_id: string, callback: () => boolean) => {
        registeredCallback = callback;
      }),
      unregister: vi.fn(),
    };
    
    const injector = Injector.create({
      providers: [
        BeforeUnloadGuardService,
        { provide: SyncStateService, useValue: mockSyncService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: LoggerService, useValue: mockLogger },
        { provide: BeforeUnloadManagerService, useValue: mockBeforeUnloadManager },
      ],
    });
    
    runInInjectionContext(injector, () => {
      service = injector.get(BeforeUnloadGuardService);
    });
  });
  
  afterEach(() => {
    service.disable();
  });
  
  describe('enable/disable', () => {
    it('应能启用监听', () => {
      service.enable();
      
      expect(mockBeforeUnloadManager.register).toHaveBeenCalledWith(
        'unsaved-changes-guard',
        expect.any(Function),
        5
      );
    });
    
    it('应能禁用监听', () => {
      service.enable();
      service.disable();
      
      expect(mockBeforeUnloadManager.unregister).toHaveBeenCalledWith('unsaved-changes-guard');
    });
    
    it('重复启用不应重复注册', () => {
      service.enable();
      service.enable();
      service.enable();
      
      expect(mockBeforeUnloadManager.register).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('beforeunload 事件处理', () => {
    it('有未保存更改时应阻止关闭', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      service.enable();
      
      // 回调应返回 true（需要显示确认）
      expect(registeredCallback).toBeDefined();
      expect(registeredCallback!()).toBe(true);
    });
    
    it('无未保存更改时应允许关闭', () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      service.enable();
      
      // 回调应返回 false（允许关闭）
      expect(registeredCallback).toBeDefined();
      expect(registeredCallback!()).toBe(false);
    });

    it('本地 dirty 标记存在时应阻止关闭', () => {
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);

      service.enable();

      expect(registeredCallback).toBeDefined();
      expect(registeredCallback!()).toBe(true);
    });
  });
});

describe('ProjectSwitchGuardService', () => {
  let service: ProjectSwitchGuardService;
  let mockSyncService: {
    syncState: ReturnType<typeof vi.fn>;
  };
  let mockSyncCoordinator: {
    flushPendingPersist: ReturnType<typeof vi.fn>;
    flushPendingPersistToCloud: ReturnType<typeof vi.fn>;
    hasPendingLocalChanges: ReturnType<typeof vi.fn>;
  };
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSyncService = {
      syncState: vi.fn().mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      }),
    };
    mockSyncCoordinator = {
      flushPendingPersist: vi.fn(),
      flushPendingPersistToCloud: vi.fn().mockResolvedValue(false),
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
    };
    
    const injector = Injector.create({
      providers: [
        ProjectSwitchGuardService,
        { provide: SyncStateService, useValue: mockSyncService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    
    runInInjectionContext(injector, () => {
      service = injector.get(ProjectSwitchGuardService);
    });
  });
  
  afterEach(() => {
    if (typeof vi.clearAllTimers === 'function') {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
  });
  
  describe('canSwitchProject', () => {
    it('无未保存更改时应返回 proceed', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 0,
        isSyncing: false,
      });
      
      const result = await service.canSwitchProject();
      
      expect(result).toBe('proceed');
    });
    
    it('有未保存更改时应显示确认', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.useFakeTimers();
      
      const resultPromise = service.canSwitchProject();
      await vi.advanceTimersByTimeAsync(5001);
      const result = await resultPromise;
      
      expect(confirmSpy).toHaveBeenCalled();
      expect(result).toBe('proceed');
      
      confirmSpy.mockRestore();
    });

    it('用户确认切换时应实际触发 flush，并在保存完成后直接 proceed', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 3,
        isSyncing: false,
      });
      mockSyncCoordinator.flushPendingPersistToCloud.mockImplementation(async () => {
        mockSyncService.syncState.mockReturnValue({
          pendingCount: 0,
          isSyncing: false,
        });
        return true;
      });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const result = await service.canSwitchProject();

      expect(result).toBe('proceed');
      expect(mockSyncCoordinator.flushPendingPersist).toHaveBeenCalledTimes(1);
      expect(mockSyncCoordinator.flushPendingPersistToCloud).toHaveBeenCalledWith(
        'project-switch',
        { force: true },
      );
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      confirmSpy.mockRestore();
    });

    it('取消提示应明确保留当前项目并返回 cancel', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const result = await service.canSwitchProject();

      expect(result).toBe('cancel');
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('留在当前项目'));
      expect(mockSyncCoordinator.flushPendingPersist).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('本地 dirty 标记存在时，即使同步计数为零也应询问用户', async () => {
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const result = await service.canSwitchProject();

      expect(result).toBe('cancel');
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('未同步的更改'));
      expect(mockSyncCoordinator.flushPendingPersist).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('云端 flush 返回 false 时应询问是否强制切换', async () => {
      mockSyncService.syncState.mockReturnValue({
        pendingCount: 1,
        isSyncing: false,
      });
      const confirmSpy = vi.spyOn(window, 'confirm')
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const result = await service.canSwitchProject();

      expect(result).toBe('cancel');
      expect(mockSyncCoordinator.flushPendingPersistToCloud).toHaveBeenCalledWith(
        'project-switch',
        { force: true },
      );
      expect(confirmSpy).toHaveBeenCalledTimes(2);
      expect(confirmSpy).toHaveBeenLastCalledWith(expect.stringContaining('强制切换'));
      confirmSpy.mockRestore();
    });
  });
});

describe('配置', () => {
  it('应有合理的默认配置', () => {
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.ENABLED).toBe(true);
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_BEFORE_LEAVE).toBe(true);
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_TIMEOUT).toBe(5000);
    expect(ROUTE_LEAVE_PROTECTION_CONFIG.PROTECTED_ROUTES).toContain('/projects/');
  });
});
