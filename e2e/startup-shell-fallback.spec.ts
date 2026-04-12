import { test, expect } from '@playwright/test';

test.describe('Startup Shell Fallback', () => {
  test('should show initial loader without blank screen when snapshot payload is corrupted', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v1', '{broken');
      localStorage.removeItem('nanoflow.launch-snapshot.v2');
    });

    await page.goto('/projects', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#initial-loader')).toBeVisible();
  });

  test('should bootstrap from legacy launch alias without leaving the user on launch.html', async ({ page }) => {
    await page.goto('/launch.html', { waitUntil: 'domcontentloaded' });

    await page.waitForURL((url) => !url.pathname.endsWith('/launch.html'));

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{ event?: string }>;
      }).__NANOFLOW_STARTUP_TRACE__ ?? [];

      return !window.location.pathname.endsWith('/launch.html')
        && records.some((entry) => entry.event === 'app.start');
    });

    await expect(page.locator('#initial-loader')).toBeVisible();
    await expect(page).not.toHaveURL(/launch\.html$/);
  });
});
