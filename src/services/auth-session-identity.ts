/**
 * AuthService 的「持久化会话身份解析 / 认证错误分类」纯函数模块。
 *
 * 从 AuthService「下切」出的无状态解析与分类工具：从 Supabase 持久化的 authData
 * 里解析出会话记录与用户身份，并识别认证失效类错误。全部纯函数（无 `this`、无副作用）。
 *
 * - resolvePersistedSessionRecord：从 authData 根对象里取出 currentSession / session / 根记录
 * - resolvePersistedSessionIdentityFromAuthData：进一步校验 token + user.id 并提取 userId/email
 * - isAuthenticationError：按 HTTP 401/403 / Supabase 错误码 / 消息关键词识别认证失效错误
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；AuthService 长期越界，
 * 这些纯解析/分类工具自洽且零依赖服务态，适合先行下切。
 */
import type { PersistedSessionIdentity } from './auth.service';

export function resolvePersistedSessionRecord(authData: unknown): Record<string, unknown> | null {
  if (!authData || typeof authData !== 'object') {
    return null;
  }

  const rootRecord = authData as Record<string, unknown>;
  const currentSession = rootRecord['currentSession'];
  if (currentSession && typeof currentSession === 'object') {
    return currentSession as Record<string, unknown>;
  }

  const session = rootRecord['session'];
  if (session && typeof session === 'object') {
    return session as Record<string, unknown>;
  }

  return rootRecord;
}

export function resolvePersistedSessionIdentityFromAuthData(authData: unknown): PersistedSessionIdentity | null {
  const sessionRecord = resolvePersistedSessionRecord(authData);
  if (!sessionRecord) {
    return null;
  }

  const refreshToken = sessionRecord['refresh_token'];
  const accessToken = sessionRecord['access_token'];
  if ((typeof refreshToken !== 'string' || !refreshToken)
    && (typeof accessToken !== 'string' || !accessToken)) {
    return null;
  }

  const user = sessionRecord['user'];
  if (!user || typeof user !== 'object') {
    return null;
  }

  const userRecord = user as Record<string, unknown>;
  const userId = userRecord['id'];
  if (typeof userId !== 'string' || !userId) {
    return null;
  }

  return {
    userId,
    email: typeof userRecord['email'] === 'string' ? userRecord['email'] : null,
  };
}

export function isAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { status?: number; message?: string; code?: string; name?: string };
  // HTTP 401/403 明确表示认证失效
  if (err.status === 401 || err.status === 403) return true;
  // Supabase SDK 的特定错误码
  if (err.code === 'session_not_found' || err.code === 'refresh_token_not_found') return true;
  // 错误消息中包含认证相关关键词
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('refresh token') || msg.includes('invalid token') ||
      msg.includes('invalid refresh token') || msg.includes('token expired') ||
      msg.includes('session expired') || msg.includes('session missing') ||
      msg.includes('invalid claim') || msg.includes('jwt expired')) {
    return true;
  }
  return false;
}
