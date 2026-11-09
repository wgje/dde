import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from '../auth.service';
import { LoggerService } from '../logger.service';
import { ModalService } from '../modal.service';
import { AUTH_CONFIG, GUARD_CONFIG } from '../../config';
import { FEATURE_FLAGS } from '../../config/feature-flags.config';
import { guardLogger } from '../../utils/standalone-logger';

/** 本地认证缓存 key */
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';
/** 本地模式变更事件 */
export const LOCAL_MODE_CHANGED_EVENT = 'nanoflow:local-mode-changed';

function dispatchLocalModeChanged(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(LOCAL_MODE_CHANGED_EVENT));
}

/**
 * 检查是否处于本地模式
 * 本地模式允许用户在不登录的情况下使用应用（数据仅保存在本地）
 */
export function isLocalModeEnabled(): boolean {
  try {
    return localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY) === 'true';
  } catch (e) {
    // 降级处理：localStorage 不可用时返回 false
    guardLogger.warn('AuthGuard localStorage 访问失败', e);
    return false;
  }
}

/**
 * 启用本地模式
 * 允许用户跳过登录，使用本地存储进行数据隔离
 */
export function enableLocalMode(): void {
  try {
    localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
    dispatchLocalModeChanged();
  } catch (e) {
    guardLogger.warn('启用本地模式失败', e);
  }
}

/**
 * 禁用本地模式
 * 用户登录成功后应调用此方法
 */
export function disableLocalMode(): void {
  try {
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    dispatchLocalModeChanged();
  } catch (e) {
    guardLogger.warn('禁用本地模式失败', e);
  }
}

/**
 * 检查本地缓存的认证状态
 * 用于离线模式下验证用户身份
 */
function checkLocalAuthCache(): { userId: string | null; expiredAt: number | null } {
  try {
    const cached = localStorage.getItem(AUTH_CACHE_KEY);
    if (cached) {
      const { userId, expiredAt } = JSON.parse(cached);
      // 【P1-06 修复】验证 userId 格式为合法 UUID，防止 XSS 注入伪造
      if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
        guardLogger.warn('认证缓存 userId 格式不合法，清除缓存');
        localStorage.removeItem(AUTH_CACHE_KEY);
        return { userId: null, expiredAt: null };
      }
      // 检查缓存是否过期（默认 7 天）
      if (expiredAt && typeof expiredAt === 'number' && Date.now() < expiredAt) {
        return { userId, expiredAt };
      }
    }
  } catch (e) {
    // 解析失败时记录日志，方便调试
    guardLogger.warn('解析认证缓存失败', e);
  }
  return { userId: null, expiredAt: null };
}

/**
 * 保存认证状态到本地缓存
 */
export function saveAuthCache(userId: string | null): void {
  try {
    if (userId) {
      const expiredAt = Date.now() + AUTH_CONFIG.REMEMBER_ME_EXPIRY;
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ userId, expiredAt }));
    } else {
      localStorage.removeItem(AUTH_CACHE_KEY);
    }
  } catch (e) {
    // 存储失败时记录日志
    guardLogger.warn('保存认证缓存失败', e);
  }
}

/**
 * 等待会话初始化完成（首次 checkSession 执行完毕）
 * 
 * 解决核心竞态：isCheckingSession 初始值为 false，Guard 可能在
 * bootstrap 启动之前就运行，误判为"会话检查已完成、用户未登录"。
 * 改为轮询 sessionInitialized 信号，确保 Guard 等到真正的检查结果。
 */
async function waitForSessionCheck(
  authService: AuthService,
  timeoutMs: number
): Promise<void> {
  // 如果会话已初始化完成，直接返回
  if (authService.sessionInitialized()) {
    return;
  }

  // 主动触发一次会话检查，避免 Guard 先于 bootstrap 执行时出现被动等待超时
  const maybeCheckSession = (authService as unknown as {
    checkSession?: () => Promise<unknown>;
  }).checkSession;
  if (typeof maybeCheckSession === 'function') {
    void maybeCheckSession.call(authService).catch((error) => {
      guardLogger.debug('会话引导触发失败（忽略）', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  const start = Date.now();
  let interval: number = GUARD_CONFIG.SESSION_CHECK_POLL_INTERVAL;

  // 等待条件：sessionInitialized 变为 true（覆盖"未开始"和"进行中"两种状态）
  while (!authService.sessionInitialized()) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      guardLogger.debug('等待会话初始化超时', { timeoutMs, elapsed });
      break;
    }

    const waitMs = Math.min(interval, timeoutMs - elapsed);
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    interval = Math.min(interval * 2, GUARD_CONFIG.SESSION_CHECK_POLL_MAX_INTERVAL);
  }
}

/**
 * 获取当前数据隔离 ID
 * 用于确定数据存储的命名空间
 * 
 * 优先级：
 * 1. 已登录用户的 ID
 * 2. 本地缓存的认证状态
 * 3. 本地模式用户 ID（如果启用了本地模式）
 * 4. null（无法确定用户身份）
 */
export function getDataIsolationId(authService: AuthService): string | null {
  const userId = authService.currentUserId();
  if (userId) {
    return userId;
  }
  
  const localAuth = checkLocalAuthCache();
  if (localAuth.userId) {
    return localAuth.userId;
  }
  
  // 如果启用了本地模式，返回本地模式用户 ID
  if (isLocalModeEnabled()) {
    return AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }
  
  // 不再返回匿名会话 ID，返回 null 表示无法确定用户身份
  return null;
}

type GuardLogger = ReturnType<LoggerService['category']>;

interface RequireAuthGuardContext {
  authService: AuthService;
  logger: GuardLogger;
  modalService: ModalService;
  perfStart: number;
  targetUrl: string;
}

interface AuthStateSnapshot {
  isCheckingSession: boolean;
  userId: string | null;
}

function createRequireAuthGuardContext(targetUrl: string): RequireAuthGuardContext {
  const authService = inject(AuthService);
  const loggerService = inject(LoggerService);
  return {
    authService,
    logger: loggerService.category('Guard'),
    modalService: inject(ModalService),
    perfStart: performance.now(),
    targetUrl,
  };
}

function logGuardComplete(context: RequireAuthGuardContext, suffix = ''): void {
  context.logger.debug(`⚡ 守卫检查完成${suffix}`, {
    elapsed: performance.now() - context.perfStart,
  });
}

function allowUnconfiguredOrLocalMode(context: RequireAuthGuardContext): boolean {
  if (!context.authService.isConfigured) {
    // Supabase 未配置时保留完整本地优先体验。
    context.logger.debug('Supabase 未配置，允许离线模式访问');
    logGuardComplete(context);
    return true;
  }

  if (isLocalModeEnabled()) {
    context.logger.debug('本地模式已启用，立即允许访问');
    logGuardComplete(context);
    return true;
  }

  return false;
}

async function handleUninitializedSession(
  context: RequireAuthGuardContext,
  authState: AuthStateSnapshot,
): Promise<boolean> {
  const localAuth = checkLocalAuthCache();
  if (localAuth.userId || authState.userId) {
    context.logger.debug('冷启动快速路径：本地缓存/userId 已存在，立即放行', {
      localAuth: !!localAuth.userId,
      userId: authState.userId,
    });
    triggerBackgroundSessionCheck(context.authService);
    logGuardComplete(context, '（快速路径）');
    return true;
  }

  if (FEATURE_FLAGS.AUTH_RUNTIME_GATE_V1) {
    context.logger.debug('Auth runtime 已延后到 handoff 后，先允许壳层挂载', {
      targetUrl: context.targetUrl,
    });
    return true;
  }

  context.logger.debug('会话初始化未完成，短时等待');
  await waitForSessionCheck(context.authService, Math.min(GUARD_CONFIG.SESSION_CHECK_TIMEOUT, 500));
  logSessionInitializationTimeout(context);
  return false;
}

function triggerBackgroundSessionCheck(authService: AuthService): void {
  void (authService as unknown as { checkSession?: () => Promise<unknown> })
    .checkSession?.()?.catch(() => {});
}

function logSessionInitializationTimeout(context: RequireAuthGuardContext): void {
  if (context.authService.sessionInitialized()) return;

  const stillCheckingSession = context.authService.authState().isCheckingSession;
  const payload = {
    timeout: 500,
    targetUrl: context.targetUrl,
    stillCheckingSession,
  };

  if (stillCheckingSession) {
    context.logger.debug('会话初始化仍在进行，先按未登录流程挂载壳层', payload);
    return;
  }

  context.logger.warn('会话初始化超时，按未登录流程处理', payload);
}

function finishAuthGuard(context: RequireAuthGuardContext): boolean {
  const userId = context.authService.currentUserId();
  context.logger.debug(`检查用户ID`, { userId });

  if (userId) {
    saveAuthCache(userId);
    context.logger.debug('用户已登录，允许访问');
    return true;
  }

  const localAuth = checkLocalAuthCache();
  context.logger.debug(`本地缓存认证`, { localAuth });
  if (localAuth.userId) {
    context.logger.debug('使用本地缓存认证，允许离线访问');
    return true;
  }

  if (FEATURE_FLAGS.AUTH_RUNTIME_GATE_V1 && !context.authService.sessionInitialized()) {
    context.logger.debug('Auth runtime 尚未完成，推迟登录提示到壳层 handoff 之后');
    return true;
  }

  showLoginPrompt(context);
  return true;
}

function showLoginPrompt(context: RequireAuthGuardContext): void {
  context.logger.debug('需要登录，触发登录提示并允许挂载壳层（避免黑屏）');

  try {
    context.modalService.show('login', {
      returnUrl: context.targetUrl,
      message: '请登录以访问此页面',
    });
  } catch (error) {
    context.logger.warn('登录模态框触发失败，降级为壳层登录提示', {
      error,
      targetUrl: context.targetUrl,
    });
  }
}

/**
 * 强制登录守卫
 * 用于保护需要明确用户身份的路由和功能
 * 
 * 【核心策略】所有数据操作都需要 user_id：
 * - 简化 Supabase RLS 策略 - 所有操作都有明确的数据归属
 * - 避免「幽灵数据」问题 - 无需处理匿名数据到正式账户的迁移
 * - 保障数据安全 - 防止未授权访问和垃圾数据注入
 * 
 * 【离线/本地模式策略】守卫数据流，而非 UI：
 * - 离线时允许完全的读写访问，用户体验不受阻断
 * - 本地缓存的认证状态用于确定数据命名空间
 * - 本地模式允许用户跳过登录，数据仅保存在本地
 * - 写操作通过 ActionQueueService 进入离线队列
 * - 网络恢复后，SyncCoordinator 统一处理队列同步
 * - 冲突处理和 ID 生成由 sync 层负责，守卫不介入
 * 
 * 开发环境便利：
 * - 配置 environment.devAutoLogin 后，应用启动时会自动登录
 * - Guard 仍然存在且生效，只是登录过程被自动化
 * - 避免"关掉 Guard"的懒惰做法，保持代码路径一致
 * 
 * 使用场景：
 * - 所有核心业务路由（/projects/*）
 * - 数据导出、分享功能
 * - 用户设置页面
 */
export const requireAuthGuard: CanActivateFn = async (_route, state) => {
  const context = createRequireAuthGuardContext(state.url);
  
  context.logger.debug(`requireAuthGuard 开始执行`, { targetUrl: state.url });
  
  if (allowUnconfiguredOrLocalMode(context)) {
    return true;
  }
  
  const authState = context.authService.authState();
  const initialized = context.authService.sessionInitialized();
  context.logger.debug(`当前认证状态`, {
    isCheckingSession: authState.isCheckingSession,
    sessionInitialized: initialized,
    userId: authState.userId
  });
  
  // 【性能优化 2026-03-23】冷启动非阻塞快速路径
  // Guard 最终总是 return true（壳层负责登录兜底 UI），因此不必阻塞等待。
  // 策略：先检查本地缓存 → 有缓存即放行 → 无缓存时仅触发会话检查（后台执行），立即放行。
  // 节省 PWA 冷启动 ~1-2s（原等待上限 SESSION_CHECK_TIMEOUT = 2000ms）。
  if (!initialized) {
    // 【Bug 修复 2026-03-26】冷启动快速路径不刷新 TTL；
    // TTL 只在 doCheckSession/signIn 确认会话有效后刷新。
    if (await handleUninitializedSession(context, authState)) {
      return true;
    }
  }

  // 关键：允许工作区壳层渲染登录兜底 UI，彻底避免空白/黑屏
  return finishAuthGuard(context);
};
