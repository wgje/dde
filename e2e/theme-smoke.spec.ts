import { test, expect, Page } from '@playwright/test';

async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="app-container"]', { timeout: 15000 });

  // 等待 loading-indicator 消失（若存在）
  const loadingIndicator = page.locator('[data-testid="loading-indicator"]');
  const loadingVisible = await loadingIndicator
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (loadingVisible) {
    await expect(loadingIndicator).not.toBeVisible({ timeout: 15000 });
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}

async function bootWithTheme(
  page: Page,
  theme: 'default' | 'ocean' | 'sunset' | 'forest' | 'lavender',
  mode: 'light' | 'dark' | 'system'
): Promise<void> {
  await page.addInitScript(
    ({ nextTheme, nextMode }) => {
      localStorage.setItem('nanoflow.theme', nextTheme);
      localStorage.setItem('nanoflow.colorMode.local', JSON.stringify(nextMode));
    },
    { nextTheme: theme, nextMode: mode }
  );
  await page.goto('/');
  await waitForAppReady(page);
}

async function getBackgroundColor(page: Page, selector: string): Promise<string> {
  return await page.locator(selector).evaluate((element) => getComputedStyle(element as HTMLElement).backgroundColor);
}

async function openSettings(page: Page): Promise<void> {
  const settingsButton = page.locator('[data-testid="workspace-settings-button"], button[aria-label="打开设置"]').first();
  await expect(settingsButton).toBeVisible({ timeout: 10000 });
  await settingsButton.click({ force: true });
  await expect(page.locator('[data-testid="settings-modal"]').first()).toBeVisible({ timeout: 15000 });
}

test.describe('Theme smoke', () => {
  test('light themes should recolor workspace shell and settings modal', async ({ page }) => {
    await bootWithTheme(page, 'ocean', 'light');
    await openSettings(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'light');

    const oceanShellBg = await getBackgroundColor(page, '[data-testid="app-container"]');
    const oceanModalBg = await getBackgroundColor(page, '[data-testid="settings-modal"]');

    expect(oceanShellBg).not.toBe('rgb(255, 255, 255)');
    expect(oceanModalBg).not.toBe('rgb(255, 255, 255)');
  });

  test('dark mode should propagate to shell, settings modal, and main view switches', async ({ page }) => {
    await bootWithTheme(page, 'sunset', 'dark');

    const textViewTab = page.locator('[data-testid="text-view-tab"]').first();
    if (await textViewTab.isVisible().catch(() => false)) {
      await textViewTab.click();
    }

    const flowViewTab = page.locator('[data-testid="flow-view-tab"]').first();
    if (await flowViewTab.isVisible().catch(() => false)) {
      await flowViewTab.click();
    }

    await openSettings(page);
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sunset');

    const shellBg = await getBackgroundColor(page, '[data-testid="app-container"]');
    const modalBg = await getBackgroundColor(page, '[data-testid="settings-modal"]');

    expect(shellBg).not.toBe('rgb(249, 248, 246)');
    expect(modalBg).not.toBe('rgb(249, 248, 246)');
  });

  test('system mode should follow OS dark preference before app boot', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await bootWithTheme(page, 'default', 'system');

    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
  });
});
