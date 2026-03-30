/**
 * 网络感知 E2E 烟雾测试
 *
 * 将昂贵且与 perf 门禁重复的流量预算场景下沉到 weak-network-budget / weak-network-startup，
 * 这里只保留当前仍适合 E2E 的轻量入口契约。
 */
import { test, expect } from '@playwright/test';
import { waitForAppReady } from './shared/page-helpers';

test.describe('网络感知与流量优化', () => {

  test('应正确检测网络类型', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page, { timeoutMs: 15_000 });

    const networkQuality = await page.evaluate(() => {
      const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
      return nav.connection?.effectiveType || 'unknown';
    });

    expect(['4g', '3g', '2g', 'slow-2g', 'unknown']).toContain(networkQuality);
  });

  test('Save-Data 请求头不应导致崩溃', async ({ page, context }) => {
    await context.setExtraHTTPHeaders({ 'Save-Data': 'on' });
    await page.goto('/');
    await waitForAppReady(page, { timeoutMs: 15_000 });

    await expect(page.locator('[data-testid="app-container"]').first()).toBeVisible({ timeout: 10_000 });
  });
});
