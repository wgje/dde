/**
 * 本地模式入口烟雾测试 (E2E)
 *
 * 性能预算和守卫耗时已在更低层测试覆盖，E2E 仅保留用户可感知的关键契约：
 * 1. 可以从登录模态框进入本地模式
 * 2. 进入本地模式时不会误触发云端同步
 * 3. 不会出现“登录已过期”这类错误提示
 */
import { test, expect, Page } from '@playwright/test';
import { ensureLoginModalVisible } from './shared/auth-helpers';
import { waitForAppReady, waitForCountToStabilize } from './shared/page-helpers';

const LOCAL_MODE_KEY = 'nanoflow.local-mode';
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';
const NO_CLOUD_SYNC_OBSERVATION_MS = 3_200;

interface SeedLocalModeOptions {
  localModeEnabled: boolean;
  authCacheValue?: { userId: string; expiredAt: number };
}

async function seedLocalModeState(page: Page, options: SeedLocalModeOptions): Promise<void> {
  await page.context().clearCookies();
  await page.addInitScript(({ localModeKey, authCacheKey, localModeEnabled, authCacheValue }) => {
    if (localModeEnabled) {
      localStorage.setItem(localModeKey, 'true');
    } else {
      localStorage.removeItem(localModeKey);
    }

    if (authCacheValue) {
      localStorage.setItem(authCacheKey, JSON.stringify(authCacheValue));
    } else {
      localStorage.removeItem(authCacheKey);
    }

    sessionStorage.clear();
  }, {
    localModeKey: LOCAL_MODE_KEY,
    authCacheKey: AUTH_CACHE_KEY,
    localModeEnabled: options.localModeEnabled,
    authCacheValue: options.authCacheValue,
  });
}

async function openLocalModeEntry(page: Page): Promise<void> {
  await seedLocalModeState(page, { localModeEnabled: false });

  await page.goto('/');
  await waitForAppReady(page, { timeoutMs: 15_000 });

  const localModeButton = page.locator('[data-testid="local-mode-btn"]').first();
  if (await localModeButton.isVisible({ timeout: 800 }).catch(() => false)) {
    return;
  }

  await ensureLoginModalVisible(page, 10_000);
  await expect(localModeButton).toBeVisible({ timeout: 10_000 });
}

async function enterLocalMode(page: Page): Promise<number> {
  await openLocalModeEntry(page);
  const startedAt = Date.now();
  await page.locator('[data-testid="local-mode-btn"]').first().click({ force: true });
  await expect
    .poll(async () => page.evaluate((key) => localStorage.getItem(key), LOCAL_MODE_KEY), { timeout: 10_000 })
    .toBe('true');
  await expect(page.locator('[data-testid="project-selector"]').first()).toBeVisible({ timeout: 15_000 });
  return Date.now() - startedAt;
}

async function bootstrapPersistedLocalMode(page: Page): Promise<number> {
  await seedLocalModeState(page, {
    localModeEnabled: true,
    authCacheValue: {
      userId: '00000000-0000-0000-0000-000000000000',
      expiredAt: Date.now() - 60_000,
    },
  });

  const startedAt = Date.now();
  await page.goto('/');
  await waitForAppReady(page, { timeoutMs: 15_000 });
  await expect(page.locator('[data-testid="project-selector"]').first()).toBeVisible({ timeout: 15_000 });
  return Date.now() - startedAt;
}

test.describe('本地模式入口烟雾', () => {
  test('应能通过登录模态框进入本地模式且不触发云端同步', async ({ page }) => {
    const networkRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('supabase.co')) {
        networkRequests.push(url);
      }
    });

    const readyMs = await enterLocalMode(page);
    expect(readyMs).toBeLessThan(5_000);

    const remainingObservationMs = Math.max(0, NO_CLOUD_SYNC_OBSERVATION_MS - readyMs);
    if (remainingObservationMs > 0) {
      await waitForCountToStabilize(() => networkRequests.length, {
        idleMs: remainingObservationMs,
        timeoutMs: remainingObservationMs + 1_000,
        pollMs: 100,
      });
    }

    const syncRequests = networkRequests.filter((url) =>
      url.includes('/rest/v1/projects') ||
      url.includes('/rest/v1/tasks') ||
      url.includes('/auth/v1/token')
    );

    expect(syncRequests.length).toBe(0);
    await expect(page.locator('[data-testid="toast-container"]')).not.toContainText('登录已过期', {
      timeout: 1_000,
    });
  });

  test('进入本地模式后不应显示登录过期提示', async ({ page }) => {
    const authRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('supabase.co') && url.includes('/auth/v1/token')) {
        authRequests.push(url);
      }
    });

    const readyMs = await bootstrapPersistedLocalMode(page);

    const remainingObservationMs = Math.max(0, NO_CLOUD_SYNC_OBSERVATION_MS - readyMs);
    if (remainingObservationMs > 0) {
      await waitForCountToStabilize(() => authRequests.length, {
        idleMs: remainingObservationMs,
        timeoutMs: remainingObservationMs + 1_000,
        pollMs: 100,
      });
    }

    expect(authRequests).toHaveLength(0);

    await expect(page.locator('[data-testid="toast-container"]')).not.toContainText('登录已过期', {
      timeout: 1_000,
    });
  });
});
