import { test, expect } from '@playwright/test';

test.describe('Startup Shell Visibility', () => {
  test('should keep initial loader visible during delayed main entry discovery', async ({ page }) => {
    await page.route('**/main-*.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });

    await page.goto('/projects', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#initial-loader')).toBeVisible();
  });
});
