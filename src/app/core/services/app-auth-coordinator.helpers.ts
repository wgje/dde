import { resolveRouteIntent } from '../../../utils/route-intent';
import type { LoginData } from '../../../services/modal.service';
import {
  getErrorMessage,
  humanizeErrorMessage,
  type OperationError,
} from '../../../utils/result';

export interface AppAuthLazyServiceSlot<TService> {
  ref: TService | null;
  promise: Promise<TService | null> | null;
}

export interface ResolveAppAuthLazyServiceOptions<TService, TToken> {
  loadToken: () => Promise<TToken>;
  resolve: (token: TToken) => TService;
  warn: (error: unknown) => void;
}

export interface PostAuthNavigationTargetInput {
  returnUrl?: string | null;
  activeProjectId: string | null;
  startupProjectCatalogStage: string;
  canAuthoritativelyRejectProjectRoute: boolean;
  isProjectAuthoritativelyAccessible: (projectId: string) => boolean;
  hasMatchingProject: (projectId: string) => boolean;
}

export type PostAuthNavigationTarget =
  | { url: string | null; rejected?: undefined }
  | {
      url: '/projects';
      rejected: {
        candidateUrl: string;
        projectId: string;
        startupProjectCatalogStage: string;
        canAuthoritativelyRejectProjectRoute: true;
        hasMatchingProject: boolean;
      };
    };

export interface LoginRequiredState {
  isConfigured: boolean;
  runtimeState: string;
  sessionInitialized: boolean;
  currentUserId: string | null;
  isLoginModalOpen: boolean;
  isCheckingSession: boolean;
  bootstrapFailed: boolean;
}

export type AuthFormModeTransition = 'signup' | 'login' | 'reset-password' | 'signed-out';

export interface AuthFormStatePatch {
  sessionEmail?: string | null;
  authEmail?: string;
  authPassword?: string;
  authConfirmPassword?: string;
  authError?: string | null;
  isReloginMode?: boolean;
  isSignupMode?: boolean;
  isResetPasswordMode?: boolean;
  resetPasswordSent?: boolean;
}

export type AuthCredentialPreflightMode = 'login' | 'signup' | 'reset-password';

export interface AuthCredentialPreflightInput {
  isConfigured: boolean;
  email: string;
  password?: string;
  confirmPassword?: string;
}

export interface SignOutWidgetRevocationInput {
  currentUserId: string | null;
  localModeUserId: string;
  isConfigured: boolean;
}

export interface SignOutFailureNotice {
  logMessage: string;
  toastTitle: string;
  toastMessage: string;
}

export interface SuccessfulLoginCompletionPlanInput {
  rawLoginData: unknown;
  options?: { closeSettings?: boolean; skipPostAuthNavigation?: boolean };
  resolveNavigationUrl: (returnUrl?: string | null) => string | null;
}

export interface SuccessfulLoginCompletionPlan {
  closeLogin: true;
  closeSettings: boolean;
  navigationUrl: string | null;
}

export function createAppAuthLazyServiceSlot<TService>(): AppAuthLazyServiceSlot<TService> {
  return { ref: null, promise: null };
}

export function resolveAppAuthLazyService<TService, TToken>(
  slot: AppAuthLazyServiceSlot<TService>,
  options: ResolveAppAuthLazyServiceOptions<TService, TToken>,
): Promise<TService | null> {
  if (slot.ref) {
    return Promise.resolve(slot.ref);
  }

  if (slot.promise) {
    return slot.promise;
  }

  slot.promise = options.loadToken()
    .then(token => {
      const service = options.resolve(token);
      slot.ref = service;
      return service;
    })
    .catch((error: unknown) => {
      options.warn(error);
      return null;
    })
    .finally(() => {
      slot.promise = null;
    });

  return slot.promise;
}

export async function waitForPromiseOrTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<'completed' | 'timeout'> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => 'completed' as const),
      new Promise<'timeout'>(resolve => {
        timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function getAuthFailureMessage(error: OperationError): string {
  const message = error.message?.trim();
  return message || getErrorMessage(error);
}

export function getAuthFlowErrorMessage(error: unknown): string {
  const err = error as Error | undefined;
  return humanizeErrorMessage(err?.message ?? String(error));
}

export function isLoginData(data: unknown): data is LoginData {
  return data != null && typeof data === 'object' && 'returnUrl' in (data as Record<string, unknown>);
}

export function buildSuccessfulLoginCompletionPlan(
  input: SuccessfulLoginCompletionPlanInput,
): SuccessfulLoginCompletionPlan {
  const loginData = isLoginData(input.rawLoginData) ? input.rawLoginData : undefined;
  const navigationUrl = input.options?.skipPostAuthNavigation
    ? null
    : input.resolveNavigationUrl(loginData?.returnUrl);

  return {
    closeLogin: true,
    closeSettings: input.options?.closeSettings === true,
    navigationUrl,
  };
}

export function shouldShowLoginRequired(state: LoginRequiredState): boolean {
  return state.isConfigured &&
    state.runtimeState !== 'pending' &&
    state.sessionInitialized &&
    !state.currentUserId &&
    !state.isLoginModalOpen &&
    !state.isCheckingSession &&
    !state.bootstrapFailed;
}

export function shouldShowSettingsAuthForm(
  currentUserId: string | null,
  isReloginMode: boolean,
): boolean {
  return !currentUserId || isReloginMode;
}

export function isMigrationCheckCurrent(
  expectedGeneration: number,
  currentGeneration: number,
  expectedUserId: string | null,
  currentUserId: string | null,
  localModeUserId: string,
): boolean {
  return Boolean(
    expectedUserId &&
    expectedUserId !== localModeUserId &&
    currentGeneration === expectedGeneration &&
    currentUserId === expectedUserId
  );
}

export function isAuthLoadCurrent(
  expectedGeneration: number,
  currentGeneration: number,
  expectedUserId: string | null,
  currentUserId: string | null,
): boolean {
  return currentGeneration === expectedGeneration && currentUserId === expectedUserId;
}

export function getAuthFormModePatch(transition: AuthFormModeTransition): AuthFormStatePatch {
  switch (transition) {
    case 'signup':
      return {
        isSignupMode: true,
        isResetPasswordMode: false,
        authError: null,
        authPassword: '',
        authConfirmPassword: '',
      };
    case 'login':
      return {
        isSignupMode: false,
        isResetPasswordMode: false,
        resetPasswordSent: false,
        authError: null,
      };
    case 'reset-password':
      return {
        isResetPasswordMode: true,
        isSignupMode: false,
        resetPasswordSent: false,
        authError: null,
      };
    case 'signed-out':
      return {
        sessionEmail: null,
        authEmail: '',
        authPassword: '',
        authConfirmPassword: '',
        authError: null,
        isReloginMode: false,
        isSignupMode: false,
        isResetPasswordMode: false,
        resetPasswordSent: false,
      };
  }
}

export function getAuthCredentialPreflightError(
  mode: AuthCredentialPreflightMode,
  input: AuthCredentialPreflightInput,
): string | null {
  if (!input.isConfigured) {
    return mode === 'login'
      ? 'Supabase keys missing. Set NG_APP_SUPABASE_URL/NG_APP_SUPABASE_ANON_KEY.'
      : 'Supabase keys missing.';
  }

  if (mode === 'signup') {
    if (input.password !== input.confirmPassword) {
      return '两次输入的密码不一致';
    }

    const minPasswordLength = 8;
    if ((input.password ?? '').length < minPasswordLength) {
      return `密码长度至少${minPasswordLength}位`;
    }
  }

  if (mode === 'reset-password' && !input.email) {
    return '请输入邮箱地址';
  }

  return null;
}

export function shouldRevokeWidgetBindingsOnSignOut(input: SignOutWidgetRevocationInput): boolean {
  return Boolean(
    input.currentUserId &&
    input.currentUserId !== input.localModeUserId &&
    input.isConfigured
  );
}

export function buildWidgetRevocationFailureNotice(error: OperationError): SignOutFailureNotice {
  const message = humanizeErrorMessage(getErrorMessage(error));
  return {
    logMessage: 'Widget 远端吊销失败，中断登出流程',
    toastTitle: '设备吊销失败',
    toastMessage: `${message}；请在网络恢复后重试，当前不会退出登录`,
  };
}

export function getSupabaseSignOutFailureNotice(): SignOutFailureNotice {
  return {
    logMessage: 'Supabase 远端登出失败，中断登出流程',
    toastTitle: '退出登录失败',
    toastMessage: '远端会话吊销失败；请在网络恢复后重试，当前不会退出登录',
  };
}

export function getLocalCleanupFailureNotice(): SignOutFailureNotice {
  return {
    logMessage: '本地数据清理失败，继续完成登出流程',
    toastTitle: '本地清理未完成',
    toastMessage: '已退出登录；若需彻底清理本地缓存，请关闭其他标签页后重试',
  };
}

export function resolveSafePostAuthNavigationTarget(
  input: PostAuthNavigationTargetInput,
): PostAuthNavigationTarget {
  const normalizedReturnUrl = typeof input.returnUrl === 'string'
    ? input.returnUrl.trim()
    : '';
  const explicitReturnUrl = normalizedReturnUrl && normalizedReturnUrl !== '/'
    ? normalizedReturnUrl
    : null;

  if (!explicitReturnUrl) {
    return { url: explicitReturnUrl };
  }

  const routeIntent = resolveRouteIntent(explicitReturnUrl, input.activeProjectId);
  if (routeIntent.kind === 'projects' || !routeIntent.projectId) {
    return { url: explicitReturnUrl };
  }

  if (!input.canAuthoritativelyRejectProjectRoute) {
    return { url: explicitReturnUrl };
  }

  if (input.isProjectAuthoritativelyAccessible(routeIntent.projectId)) {
    return { url: explicitReturnUrl };
  }

  return {
    url: '/projects',
    rejected: {
      candidateUrl: explicitReturnUrl,
      projectId: routeIntent.projectId,
      startupProjectCatalogStage: input.startupProjectCatalogStage,
      canAuthoritativelyRejectProjectRoute: true,
      hasMatchingProject: input.hasMatchingProject(routeIntent.projectId),
    },
  };
}
