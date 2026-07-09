import { Injectable, inject } from '@angular/core';

import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { saveAuthCache } from './guards/auth.guard';
import {
  resolvePersistedSessionIdentityFromAuthData,
  resolvePersistedSessionRecord,
  type PersistedSessionIdentity,
} from './auth-session-identity';

type SessionPrewarmState = {
  status: string;
  session?: {
    access_token: string;
    expires_at: number;
    user?: {
      id: string;
      email?: string | null;
    } | null;
  };
};

@Injectable({ providedIn: 'root' })
export class AuthSessionCacheService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('AuthSessionCache');

  peekPersistedSessionIdentity(): PersistedSessionIdentity | null {
    return this.readPersistedSessionIdentity(false);
  }

  readPersistedSessionIdentity(shouldLog: boolean): PersistedSessionIdentity | null {
    try {
      return this.readPrewarmedSessionIdentity(shouldLog)
        ?? this.readLocalStorageSessionIdentity(shouldLog);
    } catch (error) {
      if (shouldLog) {
        this.logger.debug('[FastPath] 本地会话读取失败，回退到网络检查', error);
      }
      // eslint-disable-next-line no-restricted-syntax -- 本地会话读取失败降级为网络检查，null 是正确语义
      return null;
    }
  }

  peekPersistedOwnerHint(): string | null {
    const persistedIdentity = this.peekPersistedSessionIdentity();
    if (persistedIdentity?.userId) return persistedIdentity.userId;

    return this.readPersistedOwnerHintFromStorage();
  }

  readPersistedOwnerHintFromStorage(): string | null {
    try {
      const storageKey = this.supabase.getStorageKey();
      if (!storageKey) return null;

      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;

      const authData: unknown = JSON.parse(raw);
      const sessionRecord = resolvePersistedSessionRecord(authData);
      if (!sessionRecord || !this.hasAnySessionToken(sessionRecord)) return null;

      const user = sessionRecord['user'];
      if (!user || typeof user !== 'object') return null;

      const userId = (user as Record<string, unknown>)['id'];
      return typeof userId === 'string' && userId.length > 0 ? userId : null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 读取/JSON 解析失败时"无会话"语义正确，null 触发调用方降级
      return null;
    }
  }

  resolvePersistedSessionIdentityFromAuthData(authData: unknown): PersistedSessionIdentity | null {
    return resolvePersistedSessionIdentityFromAuthData(authData);
  }

  clearCachedSessionArtifacts(): void {
    try {
      const storageKey = this.supabase.getStorageKey();
      if (storageKey) {
        localStorage.removeItem(storageKey);
      }
      saveAuthCache(null);
    } catch {
      // localStorage 不可用时静默降级
    }

    if (typeof window === 'undefined') return;

    try {
      delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    } catch {
      // window 只读异常时静默降级
    }
  }

  private readPrewarmedSessionIdentity(shouldLog: boolean): PersistedSessionIdentity | null {
    if (typeof window === 'undefined') return null;

    const prewarm = (window as Window & {
      __NANOFLOW_SESSION_PREWARM__?: SessionPrewarmState;
    }).__NANOFLOW_SESSION_PREWARM__;

    if (prewarm?.status !== 'refreshed' || !prewarm.session?.user?.id) return null;

    if (shouldLog) {
      this.logger.debug('[FastPath] 使用 index.html 预热 session', {
        userId: `${prewarm.session.user.id.substring(0, 8)}...`,
        expiresAt: prewarm.session.expires_at,
      });
    }

    return {
      userId: prewarm.session.user.id,
      email: prewarm.session.user.email ?? null,
    };
  }

  private readLocalStorageSessionIdentity(shouldLog: boolean): PersistedSessionIdentity | null {
    const storageKey = this.supabase.getStorageKey();
    if (!storageKey) return null;

    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    const authData: unknown = JSON.parse(raw);
    const record = resolvePersistedSessionRecord(authData);
    if (!record || !this.hasValidLocalAccessToken(record, shouldLog)) return null;

    const identity = resolvePersistedSessionIdentityFromAuthData(authData);
    if (!identity) return null;

    if (shouldLog) {
      this.logger.debug('[FastPath] 使用 localStorage 缓存 session', {
        userId: `${identity.userId.substring(0, 8)}...`,
        expiresAt: record['expires_at'],
      });
    }

    return identity;
  }

  private hasAnySessionToken(record: Record<string, unknown>): boolean {
    const refreshToken = record['refresh_token'];
    const accessToken = record['access_token'];
    return (typeof refreshToken === 'string' && refreshToken.length > 0)
      || (typeof accessToken === 'string' && accessToken.length > 0);
  }

  private hasValidLocalAccessToken(record: Record<string, unknown>, shouldLog: boolean): boolean {
    const accessToken = record['access_token'];
    if (typeof accessToken !== 'string' || !accessToken) return false;

    const rawExpiresAt = record['expires_at'];
    if (typeof rawExpiresAt !== 'number') return true;

    const expiresAt = rawExpiresAt > 1e12 ? Math.floor(rawExpiresAt / 1000) : rawExpiresAt;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt > nowSec + 60) return true;

    if (shouldLog) {
      this.logger.debug('[FastPath] 本地 token 即将过期，回退到网络检查');
    }
    return false;
  }
}
