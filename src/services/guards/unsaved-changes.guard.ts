/**
 * UnsavedChangesGuard - 路由离开保护
 * 
 * 【Week 8-9 数据保护 - 路由离开保护】
 * 职责：
 * - 检测用户离开页面时是否有未同步的更改
 * - 提示用户保存或放弃更改
 * - 支持自动保存后离开
 * 
 * 设计理念：
 * - 防止用户意外丢失数据
 * - 提供清晰的选择：保存、放弃、取消
 * - 不阻塞紧急情况下的离开
 */
import { Injectable, inject } from '@angular/core';
import { 
  CanDeactivate, 
  ActivatedRouteSnapshot, 
  RouterStateSnapshot 
} from '@angular/router';
import { SyncStateService } from '../../core-bridge';
import { LoggerService } from '../logger.service';
import { BeforeUnloadManagerService } from '../before-unload-manager.service';
import { SyncCoordinatorService } from '../sync-coordinator.service';

// ============================================
// 配置
// ============================================

export const ROUTE_LEAVE_PROTECTION_CONFIG = {
  /** 是否启用路由离开保护 */
  ENABLED: true,
  
  /** 离开前尝试自动保存 */
  AUTO_SAVE_BEFORE_LEAVE: true,
  
  /** 自动保存超时（毫秒） */
  AUTO_SAVE_TIMEOUT: 5000,
  
  /** 提示消息 */
  PROMPT_MESSAGE: '您有未保存的更改，确定要离开吗？',
  
  /** 保存失败后的提示 */
  SAVE_FAILED_MESSAGE: '自动保存失败，您仍有未同步的更改。确定要离开吗？',
  
  /** 需要保护的路由模式 */
  PROTECTED_ROUTES: [
    '/projects/',
  ] as readonly string[],
} as const;

interface PendingChangesFlushDependencies {
  syncState: Pick<SyncStateService, 'syncState'>;
  syncCoordinator: Pick<
    SyncCoordinatorService,
    'flushPendingPersist'
      | 'flushPendingPersistToCloud'
      | 'hasPendingLocalChanges'
  >;
}

async function flushPendingChangesAndWait(
  dependencies: PendingChangesFlushDependencies,
  reason: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  dependencies.syncCoordinator.flushPendingPersist();
  const cloudFlushCompleted = await waitForPromiseUntilDeadline(
    Promise.resolve().then(() => dependencies.syncCoordinator.flushPendingPersistToCloud(
      reason,
      { force: true },
    )),
    deadline,
  );
  if (!cloudFlushCompleted) {
    return false;
  }

  return waitForSyncStateUntil(dependencies, deadline);
}

async function waitForPromiseUntilDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('自动保存超时');
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('自动保存超时')), remaining);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function waitForSyncStateUntil(
  dependencies: PendingChangesFlushDependencies,
  deadline: number,
): Promise<boolean> {
  const checkInterval = 100;
  while (Date.now() < deadline) {
    const state = dependencies.syncState.syncState();
    if (
      state.pendingCount === 0
      && !state.isSyncing
      && !dependencies.syncCoordinator.hasPendingLocalChanges()
    ) {
      return true;
    }

    const remaining = deadline - Date.now();
    await new Promise(resolve => setTimeout(resolve, Math.min(checkInterval, remaining)));
  }
  return false;
}

// ============================================
// 可离开检查接口
// ============================================

/**
 * 组件可实现此接口以自定义离开检查逻辑
 */
export interface CanLeave {
  canLeave(): boolean | Promise<boolean>;
}

/**
 * 类型守卫：检查组件是否实现了 CanLeave 接口
 */
function hasCanLeave(component: unknown): component is CanLeave {
  return !!component && typeof (component as CanLeave).canLeave === 'function';
}

// ============================================
// 守卫实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class UnsavedChangesGuard implements CanDeactivate<unknown> {
  private readonly syncService = inject(SyncStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly logger = inject(LoggerService).category('UnsavedChangesGuard');
  
  /**
   * 检查是否可以离开当前路由
   */
  async canDeactivate(
    component: unknown,
    currentRoute: ActivatedRouteSnapshot,
    currentState: RouterStateSnapshot,
    nextState: RouterStateSnapshot
  ): Promise<boolean> {
    // 检查是否启用保护
    if (!ROUTE_LEAVE_PROTECTION_CONFIG.ENABLED) {
      return true;
    }
    
    // 检查当前路由是否需要保护
    if (!this.isProtectedRoute(currentState.url)) {
      return true;
    }
    
    // 如果组件实现了 CanLeave 接口，优先使用组件的逻辑
    if (hasCanLeave(component)) {
      return component.canLeave();
    }
    
    // 检查是否有未同步的变更
    const hasPendingChanges = this.hasPendingChanges();
    
    if (!hasPendingChanges) {
      return true;
    }
    
    this.logger.info('检测到未保存的更改', {
      from: currentState.url,
      to: nextState.url,
      pendingCount: this.syncService.syncState().pendingCount,
    });
    
    // 尝试自动保存
    if (ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_BEFORE_LEAVE) {
      const saveResult = await this.tryAutoSave();
      if (saveResult) {
        this.logger.info('自动保存成功，允许离开');
        return true;
      }
    }
    
    // 显示确认对话框
    const message = ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_BEFORE_LEAVE
      ? ROUTE_LEAVE_PROTECTION_CONFIG.SAVE_FAILED_MESSAGE
      : ROUTE_LEAVE_PROTECTION_CONFIG.PROMPT_MESSAGE;
    
    const confirmed = window.confirm(message);
    
    if (confirmed) {
      this.logger.info('用户确认离开，放弃未保存的更改');
    } else {
      this.logger.info('用户取消离开');
    }
    
    return confirmed;
  }
  
  /**
   * 检查是否有未同步的变更
   */
  hasPendingChanges(): boolean {
    const state = this.syncService.syncState();
    return state.pendingCount > 0
      || state.isSyncing
      || this.syncCoordinator.hasPendingLocalChanges();
  }
  
  /**
   * 检查路由是否需要保护
   */
  private isProtectedRoute(url: string): boolean {
    return ROUTE_LEAVE_PROTECTION_CONFIG.PROTECTED_ROUTES.some(
      pattern => url.includes(pattern)
    );
  }
  
  /**
   * 尝试自动保存
   */
  private async tryAutoSave(): Promise<boolean> {
    try {
      return await flushPendingChangesAndWait(
        { syncState: this.syncService, syncCoordinator: this.syncCoordinator },
        'route-leave',
        ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_TIMEOUT,
      );
    } catch (error) {
      this.logger.warn('自动保存失败', error);
      return false;
    }
  }
}

// ============================================
// BeforeUnload 保护
// ============================================

/**
 * BeforeUnloadGuardService - 浏览器关闭/刷新保护
 * 
 * 在页面关闭或刷新时提示用户保存更改。
 * 利用现有的 BeforeUnloadManagerService 进行事件管理。
 */
@Injectable({
  providedIn: 'root'
})
export class BeforeUnloadGuardService {
  private readonly syncService = inject(SyncStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly logger = inject(LoggerService).category('BeforeUnloadGuard');
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);
  
  private isEnabled = false;
  
  private readonly CALLBACK_ID = 'unsaved-changes-guard';
  
  /**
   * 启用 beforeunload 监听
   * 使用 BeforeUnloadManagerService 统一管理，避免多个监听器冲突
   */
  enable(): void {
    if (this.isEnabled) return;
    
    // 注册到统一的 BeforeUnloadManager
    // 优先级 5：高于脏数据逃生舱（优先级 15），因为用户确认最重要
    this.beforeUnloadManager.register(
      this.CALLBACK_ID,
      () => this.shouldBlockUnload(),
      5
    );
    
    this.isEnabled = true;
    this.logger.debug('BeforeUnload 监听已启用');
  }
  
  /**
   * 禁用 beforeunload 监听
   */
  disable(): void {
    if (!this.isEnabled) return;
    
    this.beforeUnloadManager.unregister(this.CALLBACK_ID);
    this.isEnabled = false;
    
    this.logger.debug('BeforeUnload 监听已禁用');
  }
  
  /**
   * 检查是否应该阻止页面卸载
   * 返回 true 表示需要显示确认对话框
   */
  private shouldBlockUnload(): boolean {
    const state = this.syncService.syncState();
    return state.pendingCount > 0
      || state.isSyncing
      || this.syncCoordinator.hasPendingLocalChanges();
  }
}

// ============================================
// 项目切换保护服务
// ============================================

/**
 * ProjectSwitchGuardService - 项目切换保护
 * 
 * 在切换项目前检查未保存的更改
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectSwitchGuardService {
  private readonly syncService = inject(SyncStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly logger = inject(LoggerService).category('ProjectSwitchGuard');
  
  /**
   * 检查是否可以切换项目
   * @returns proceed 表示可继续切换，cancel 表示留在当前项目
   */
  async canSwitchProject(): Promise<'proceed' | 'cancel'> {
    const state = this.syncService.syncState();
    const hasPendingLocalChanges = this.syncCoordinator.hasPendingLocalChanges();
    
    if (state.pendingCount === 0 && !state.isSyncing && !hasPendingLocalChanges) {
      return 'proceed';
    }
    
    this.logger.info('检测到未保存的更改，询问用户', {
      pendingCount: state.pendingCount,
      isSyncing: state.isSyncing,
      hasPendingLocalChanges,
    });
    
    // 先尝试等待同步完成
    if (state.isSyncing) {
      const completed = await this.waitForSync(3000);
      if (completed) {
        return 'proceed';
      }
    }
    
    // 显示确认对话框
    const confirmed = window.confirm(
      '当前项目有未同步的更改。\n\n' +
      '点击"确定"将尝试保存更改后切换。\n' +
      '点击"取消"将留在当前项目。'
    );
    
    if (confirmed) {
      let completed = false;
      try {
        completed = await flushPendingChangesAndWait(
          { syncState: this.syncService, syncCoordinator: this.syncCoordinator },
          'project-switch',
          5000,
        );
      } catch (error) {
        this.logger.warn('项目切换前保存失败', error);
      }
      if (!completed) {
        const forceSwitch = window.confirm('保存超时，是否强制切换（可能丢失数据）？');
        return forceSwitch ? 'proceed' : 'cancel';
      }
    }
    
    // 【P1-07 修复】用户点击取消时返回 'cancel'，而非 'proceed'
    return confirmed ? 'proceed' : 'cancel';
  }
  
  /**
   * 等待同步完成
   */
  private async waitForSync(timeout: number): Promise<boolean> {
    const checkInterval = 100;
    let waited = 0;
    
    while (waited < timeout) {
      const state = this.syncService.syncState();
      if (
        state.pendingCount === 0
        && !state.isSyncing
        && !this.syncCoordinator.hasPendingLocalChanges()
      ) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }
    
    return false;
  }
}
