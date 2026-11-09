import { inject } from '@angular/core';
import { CanActivateFn, Router, ActivatedRouteSnapshot } from '@angular/router';
import { ProjectStateService } from '../project-state.service';
import { SyncCoordinatorService } from '../sync-coordinator.service';
import { UserSessionService } from '../user-session.service';
import { ToastService } from '../toast.service';
import { GUARD_CONFIG } from '../../config';
import { guardLogger } from '../../utils/standalone-logger';

/** 等待种子数据稳定（毫秒）- 让 loadProjects 内部初始化完成 */
const SEED_DATA_STABILIZE_MS = 100;

interface ProjectGuardSessionContext {
  sessionGeneration: number;
  userId: string | null;
}

function captureProjectGuardSession(userSession: UserSessionService): ProjectGuardSessionContext {
  return {
    sessionGeneration: userSession.getCurrentSessionGeneration(),
    userId: userSession.currentUserId(),
  };
}

function isProjectGuardSessionCurrent(
  userSession: UserSessionService,
  context: ProjectGuardSessionContext,
): boolean {
  return userSession.isSessionContextCurrent(context.sessionGeneration, context.userId);
}

/**
 * 【重构】本地优先的数据初始化检查
 * 
 * 新策略（来自高级顾问建议）：
 * - Guard 的职责仅是"检查是否有足够数据来绘制 UI"
 * - 不再等待云端同步完成
 * - 如果有本地缓存，立即放行
 * - 如果是首次安装（无缓存），也放行但标记 isFirstLoad
 * - 后台同步由组件 ngOnInit 触发，不阻塞 UI
 * 
 * @returns { loaded: true } 总是返回 true（不再阻塞）
 *          { isFirstLoad: boolean } 是否首次加载（无本地缓存）
 */
async function ensureDataAvailable(
  projectState: ProjectStateService,
  syncCoordinator: SyncCoordinatorService,
  userSession: UserSessionService,
  _toast: ToastService,
  isSessionCurrent: () => boolean,
  _maxWaitMs: number = GUARD_CONFIG.DATA_INIT_TIMEOUT
): Promise<{ loaded: boolean; isFirstLoad: boolean }> {
  const startTime = Date.now();
  const checkInterval = 50; // 快速检查间隔
  const maxQuickWait = 200; // 最多等待 200ms 让本地数据加载完成

  if (!isSessionCurrent()) return { loaded: false, isFirstLoad: false };
  userSession.prehydrateFromSnapshot();
  
  // 1. 快速检查：Store 中是否已有数据
  if (projectState.projects().length > 0) {
    return { loaded: true, isFirstLoad: false };
  }
  
  // 2. 如果 Store 为空，等待本地缓存加载（最多 200ms）
  // 这是为了等待 loadOfflineSnapshot() 完成
  while (Date.now() - startTime < maxQuickWait) {
    if (projectState.projects().length > 0) {
      return { loaded: true, isFirstLoad: false };
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    if (!isSessionCurrent()) return { loaded: false, isFirstLoad: false };
  }
  
  // 3. 如果仍无数据，触发 loadProjects（会创建种子项目）
  // 但不等待云端同步完成
  if (projectState.projects().length === 0) {
    const isLoadingRemote = syncCoordinator.isLoadingRemote();
    
    // 如果没有在加载，触发加载
    if (!isLoadingRemote) {
      if (!isSessionCurrent()) return { loaded: false, isFirstLoad: false };
      // 不阻塞等待 - loadProjects 内部会先加载本地缓存/种子数据
      userSession.loadProjects().catch(() => {
        // 静默处理，loadProjects 内部已有兜底
      });
      
      // 再等待一小段时间让种子数据生成
        await new Promise(resolve => setTimeout(resolve, SEED_DATA_STABILIZE_MS));
        if (!isSessionCurrent()) return { loaded: false, isFirstLoad: false };
    }
    
    // 如果还是没有数据，说明是首次加载或加载失败
    // 但仍然放行，让用户看到 UI（可能是骨架屏或空状态）
    if (projectState.projects().length === 0) {
      return { loaded: true, isFirstLoad: true };
    }
  }
  
  return { loaded: true, isFirstLoad: false };
}

/**
 * 【保留】传统等待函数（仅在特殊场景使用）
 * 用于需要确保数据加载完成的场景（如深链接直接访问项目）
 */
async function waitForDataInit(
  projectState: ProjectStateService,
  syncCoordinator: SyncCoordinatorService,
  userSession: UserSessionService,
  toast: ToastService,
  isSessionCurrent: () => boolean,
  maxWaitMs: number = GUARD_CONFIG.DATA_INIT_TIMEOUT
): Promise<{ loaded: boolean; reason?: string }> {
  const startTime = Date.now();
  const checkInterval = GUARD_CONFIG.CHECK_INTERVAL;
  let lastCheckReason = '';
  let slowNetworkWarningShown = false;
  let loadTriggered = false;
  
  while (Date.now() - startTime < maxWaitMs) {
    if (!isSessionCurrent()) return { loaded: false, reason: '会话已切换' };
    const projectCount = projectState.projects().length;
    const isLoadingRemote = syncCoordinator.isLoadingRemote();

    // 如果已有项目数据，初始化完成
    if (projectCount > 0) {
      return { loaded: true };
    }

    // 有时导航触发得比数据加载更早：此时 isLoadingRemote 仍为 false。
    // 为避免误判"项目不存在"，主动触发一次加载（只触发一次）。
    if (!loadTriggered && !isLoadingRemote) {
      loadTriggered = true;
      try {
        await userSession.loadProjects();
        if (!isSessionCurrent()) return { loaded: false, reason: '会话已切换' };
      } catch (e) {
        if (!isSessionCurrent()) return { loaded: false, reason: '会话已切换' };
        // 降级处理：loadProjects 内部已有兜底
        guardLogger.warn('ProjectGuard loadProjects 调用失败', e);
      }
      continue;
    }

    // 已触发过加载且当前不在加载中，说明初始化流程已经走完（即使项目列表为空）
    if (loadTriggered && !isLoadingRemote) {
      return { loaded: true };
    }

    lastCheckReason = '数据正在加载中';
    
    // 超过慢网络阈值时显示提示（只显示一次）
    const elapsed = Date.now() - startTime;
    if (!slowNetworkWarningShown && elapsed >= GUARD_CONFIG.SLOW_NETWORK_THRESHOLD) {
      slowNetworkWarningShown = true;
      toast.info('正在加载', '网络较慢，请稍候...');
    }
    
    // 等待一小段时间再检查
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  if (!isSessionCurrent()) return { loaded: false, reason: '会话已切换' };
  
  // 超时，返回失败原因
  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  return { 
    loaded: false, 
    reason: `数据加载超时 (${elapsedSeconds}秒)，${lastCheckReason || '请检查网络连接'}` 
  };
}

interface ProjectGuardDependencies {
  projectState: ProjectStateService;
  syncCoordinator: SyncCoordinatorService;
  userSession: UserSessionService;
  router: Router;
  toast: ToastService;
}

interface ProjectRouteEvaluationContext extends ProjectGuardDependencies {
  projectId: string;
  isSessionCurrent: () => boolean;
}

function injectProjectGuardDependencies(): ProjectGuardDependencies {
  return {
    projectState: inject(ProjectStateService),
    syncCoordinator: inject(SyncCoordinatorService),
    userSession: inject(UserSessionService),
    router: inject(Router),
    toast: inject(ToastService),
  };
}

function readProjectRouteAccess(context: ProjectRouteEvaluationContext): {
  existsAndAccessible: boolean;
  canReject: boolean;
} {
  const project = context.projectState.getProject(context.projectId);
  const canReject = context.userSession.canAuthoritativelyRejectProjectRoute();
  const isAccessible = !canReject
    || context.userSession.isProjectAuthoritativelyAccessible(context.projectId);
  return { existsAndAccessible: !!project && isAccessible, canReject };
}

async function waitForProjectRouteAccess(context: ProjectRouteEvaluationContext): Promise<boolean> {
  if (!context.syncCoordinator.isLoadingRemote()) return false;
  const waitResult = await waitForDataInit(
    context.projectState,
    context.syncCoordinator,
    context.userSession,
    context.toast,
    context.isSessionCurrent,
    5000,
  );
  if (!context.isSessionCurrent() || !waitResult.loaded) return false;
  return readProjectRouteAccess(context).existsAndAccessible;
}

function rejectProjectRoute(context: ProjectRouteEvaluationContext): false {
  context.toast.error('项目不存在', '请求的项目可能已被删除或您没有访问权限');
  void context.router.navigate(['/projects']);
  return false;
}

/**
 * 项目存在性守卫
 * 
 * 【重构】本地优先策略：
 * - 优先使用本地缓存数据放行
 * - 项目不存在时，等待云端同步（给深链接一个机会）
 * - 超时后才认定项目不存在
 * 
 * 单用户场景：直接注入子服务获取项目数据
 */
export const projectExistsGuard: CanActivateFn = async (route: ActivatedRouteSnapshot, _state) => {
  const dependencies = injectProjectGuardDependencies();
  const projectId = route.params['projectId'];
  if (!projectId) return true;

  const sessionContext = captureProjectGuardSession(dependencies.userSession);
  const isSessionCurrent = () => isProjectGuardSessionCurrent(
    dependencies.userSession,
    sessionContext,
  );
  const context = { ...dependencies, projectId, isSessionCurrent };
  const dataResult = await ensureDataAvailable(
    dependencies.projectState,
    dependencies.syncCoordinator,
    dependencies.userSession,
    dependencies.toast,
    isSessionCurrent,
  );
  if (!isSessionCurrent()) return false;

  const access = readProjectRouteAccess(context);
  if (access.existsAndAccessible || !access.canReject) return true;
  if (dataResult.isFirstLoad) {
    void dependencies.router.navigate(['/projects']);
    return false;
  }
  if (await waitForProjectRouteAccess(context)) return true;
  if (!isSessionCurrent()) return false;
  return rejectProjectRoute(context);
};

// projectAccessGuard 别名已移除
// 单用户场景下统一使用 projectExistsGuard
