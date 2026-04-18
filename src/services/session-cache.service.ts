/**
 * 会话持久化与缓存服务
 *
 * 单一职责：管理会话在浏览器中的生命周期
 * - 缓存会话 identity（userId、email）
 * - 检测缓存过期
 * - 与 IndexedDB 交互以恢复会话
 *
 * 【分离关注】不处理认证操作（signIn/signUp）或 Token 刷新
 * 这些由 AuthService 保留
 */

import { Injectable, inject, signal } from '@angular/core';
import { StorePersistenceService } from '../app/core/state/store-persistence.service';
import { LoggerService } from './logger.service';

export interface PersistedSessionIdentity {
  userId: string;
  email: string | null;
}

@Injectable({
  providedIn: 'root',
})
export class SessionCacheService {
  private persistence = inject(StorePersistenceService);
  private logger = inject(LoggerService).category('SessionCache');

  /** 当前缓存的会话 Identity */
  readonly cachedIdentity = signal<PersistedSessionIdentity | null>(null);

  /** 会话缓存是否已初始化 */
  readonly cacheInitialized = signal(false);

  constructor() {
    this.initializeCache();
  }

  /**
   * 初始化会话缓存
   * 从 IndexedDB 恢复上次登录的用户信息
   */
  private async initializeCache(): Promise<void> {
    try {
      const metadata = await this.persistence.getMetadata();
      if (metadata?.lastAuthenticatedUser) {
        this.cachedIdentity.set(metadata.lastAuthenticatedUser);
        this.logger.debug('会话缓存已恢复', {
          userId: metadata.lastAuthenticatedUser.userId,
          email: metadata.lastAuthenticatedUser.email,
        });
      }
    } catch (error) {
      this.logger.warn('会话缓存恢复失败', error);
    } finally {
      this.cacheInitialized.set(true);
    }
  }

  /**
   * 保存会话 Identity 到缓存
   * 在登录成功后调用
   */
  async saveSessionIdentity(identity: PersistedSessionIdentity): Promise<void> {
    try {
      this.cachedIdentity.set(identity);
      const metadata = await this.persistence.getMetadata();
      await this.persistence.setMetadata({
        ...metadata,
        lastAuthenticatedUser: identity,
      });
      this.logger.debug('会话 Identity 已保存', { userId: identity.userId });
    } catch (error) {
      this.logger.error('保存会话 Identity 失败', error);
      throw error;
    }
  }

  /**
   * 清除会话缓存
   * 在登出时调用
   */
  async clearSessionCache(): Promise<void> {
    try {
      this.cachedIdentity.set(null);
      const metadata = await this.persistence.getMetadata();
      await this.persistence.setMetadata({
        ...metadata,
        lastAuthenticatedUser: null,
      });
      this.logger.debug('会话缓存已清除');
    } catch (error) {
      this.logger.error('清除会话缓存失败', error);
      throw error;
    }
  }

  /**
   * 检查缓存中是否存在有效的会话
   * 不确保 Token 仍有效，仅检查本地缓存
   */
  hasValidCachedSession(): boolean {
    return this.cachedIdentity() !== null;
  }

  /**
   * 获取缓存中的用户 ID
   */
  getCachedUserId(): string | null {
    return this.cachedIdentity()?.userId ?? null;
  }

  /**
   * 获取缓存中的用户邮箱
   */
  getCachedEmail(): string | null {
    return this.cachedIdentity()?.email ?? null;
  }
}
