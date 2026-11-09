import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppAuthCoordinatorSpecSetup } from './app-auth-coordinator.service.spec';
import { waitForPromiseOrTimeout } from './app-auth-coordinator.helpers';

interface AppAuthCoordinatorBootstrapSpecContext {
  setup: AppAuthCoordinatorSpecSetup;
}

type BootstrapSessionHarness = {
  bootstrapSession: () => Promise<void>;
};

export function registerAppAuthCoordinatorBootstrapSpecs(
  context: AppAuthCoordinatorBootstrapSpecContext,
): void {
  const { setup } = context;

  describe('bootstrapSession forceLoad', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('冷启动 bootstrapSession 应传 forceLoad 和旧 owner hint 给 setCurrentUser', async () => {
      const { service, authMock, userSessionMock, userId } = setup();
      // 补充 bootstrapSession 内部使用的 signal 属性
      authMock.checkSession.mockImplementation(async () => {
        userId.set('cold-start-user');
        return { userId: 'cold-start-user', email: 'test@x.com' };
      });
      userSessionMock.setCurrentUser.mockResolvedValue(undefined);

      // 触发 bootstrap
      await (service as unknown as BootstrapSessionHarness).bootstrapSession();

      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('cold-start-user', {
        forceLoad: true,
        previousUserIdHint: null,
      });
    });

    it('auth fast path 已提前写入新 userId 时仍应把旧 local owner 作为 previousUserIdHint', async () => {
      const { service, authMock, userSessionMock, userId } = setup();
      userId.set('local-user');
      authMock.checkSession.mockImplementation(async () => {
        userId.set('cloud-user');
        return { userId: 'cloud-user', email: 'cloud@example.com' };
      });
      userSessionMock.setCurrentUser.mockResolvedValue(undefined);

      await (service as unknown as BootstrapSessionHarness).bootstrapSession();

      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('cloud-user', {
        forceLoad: true,
        previousUserIdHint: 'local-user',
      });
    });

    it('bootstrapSession 数据加载超时时应立即结束检测并保留后台加载', async () => {
      const { service, authMock, userSessionMock, userId, logger } = setup();
      authMock.checkSession.mockResolvedValue({ userId: 'slow-user', email: 'slow@example.com' });
      userSessionMock.setCurrentUser.mockImplementationOnce(() => {
        userId.set('slow-user');
        return new Promise<void>(() => {});
      });
      vi.mocked(waitForPromiseOrTimeout).mockResolvedValueOnce('timeout');

      await (service as unknown as BootstrapSessionHarness).bootstrapSession();

      expect(service.isCheckingSession()).toBe(false);
      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('slow-user', {
        forceLoad: true,
        previousUserIdHint: null,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('数据加载超过'),
        expect.objectContaining({ elapsed: expect.any(Number) }),
      );
    });

    it('bootstrap 超时转后台后若用户已登出，旧后台失败不应再次触发普通匿名重载', async () => {
      const { service, authMock, userSessionMock, userId } = setup();
      authMock.checkSession.mockResolvedValue({ userId: 'cold-start-user', email: 'test@x.com' });

      let rejectBackgroundLoad: ((reason?: unknown) => void) | null = null;
      const defaultSetCurrentUser = userSessionMock.setCurrentUser.getMockImplementation();
      userSessionMock.setCurrentUser
        .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
          userId.set('cold-start-user');
          rejectBackgroundLoad = reject;
        }))
        .mockImplementation(defaultSetCurrentUser ?? (async (nextUserId: string | null) => {
          userId.set(nextUserId);
        }));

      vi.mocked(waitForPromiseOrTimeout).mockResolvedValueOnce('timeout');

      await (service as unknown as BootstrapSessionHarness).bootstrapSession();
      await expect(service.signOut()).resolves.toBe(true);

      // @ts-expect-error TS2349 - closure reassignment defeats CFA
      rejectBackgroundLoad?.(new Error('background load failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(userSessionMock.setCurrentUser).toHaveBeenCalledTimes(2);
      expect(userSessionMock.setCurrentUser).toHaveBeenNthCalledWith(1, 'cold-start-user', {
        forceLoad: true,
        previousUserIdHint: null,
      });
      expect(userSessionMock.setCurrentUser).toHaveBeenNthCalledWith(2, null, { skipPersistentReload: true });
    });
  });
}
