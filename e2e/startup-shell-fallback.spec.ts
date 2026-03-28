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
});
