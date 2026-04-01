/**
 * Focus Mode E2E Smoke Tests
 *
 * 仅覆盖当前产品中仍然存在、且具备稳定 UI 契约的关键路径。
 */

import { expect, Page, test } from '@playwright/test';
import { testHelpers } from './critical-paths/helpers';

async function bootstrapLocalWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await testHelpers.waitForAppReady(page);

  const localModeBtn = page.locator('[data-testid="local-mode-btn"]').first();
  if (await testHelpers.isElementVisible(localModeBtn, 2000)) {
    await localModeBtn.click();
  }

  await expect(page.locator('[data-testid="project-selector"]').first()).toBeVisible({ timeout: 15000 });
}

async function enterProjectWorkspace(page: Page): Promise<void> {
  const enterButton = page.getByRole('button', { name: /enter/i }).first();
  if (await testHelpers.isElementVisible(enterButton, 1500)) {
    await enterButton.click({ force: true });
  }

  await expect(page.locator('[data-testid="project-shell-main-content"]').first()).toBeVisible({ timeout: 10000 });
}

async function createAndOpenProject(page: Page, projectName: string): Promise<void> {
  await page.click('[data-testid="create-project-btn"]', { force: true });
  await expect(page.locator('[data-testid="new-project-modal"]').first()).toBeVisible({ timeout: 8000 });

  await page.fill('[data-testid="project-name-input"]', projectName);
  await page.click('[data-testid="create-project-confirm"]', { force: true });
  await expect(page.locator('[data-testid="new-project-modal"]').first()).toBeHidden({ timeout: 8000 });

  const projectItem = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`).first();
  await expect(projectItem).toBeVisible({ timeout: 10000 });
  await projectItem.click({ force: true });
  await enterProjectWorkspace(page);
}

async function openSettings(page: Page): Promise<void> {
  const settingsButton = page.locator('[data-testid="workspace-settings-button"], button[aria-label="打开设置"]').first();
  await expect(settingsButton).toBeVisible({ timeout: 10000 });
  await settingsButton.click({ force: true });
  await expect(page.locator('[data-testid="settings-modal"]').first()).toBeVisible({ timeout: 15000 });
}

async function triggerDevGate(page: Page): Promise<void> {
  await openSettings(page);
  await page.locator('[data-testid="settings-dev-gate"]').first().click({ force: true });
  await expect(page.locator('[data-testid="settings-modal"]').first()).toBeHidden({ timeout: 8000 });
  await expect(page.locator('[data-testid="gate-overlay"]').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-testid="gate-card"]').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-testid="gate-read-button"]').first()).toBeEnabled({ timeout: 5000 });
}

async function ensureFlowReady(page: Page): Promise<void> {
  await testHelpers.clickIfVisible(page.locator('[data-testid="flow-view-tab"]').first(), {
    timeout: 3000,
    force: true,
  });

  await testHelpers.clickIfVisible(page.getByRole('button', { name: /流程图|加载/i }).first(), {
    timeout: 1500,
    force: true,
  });

  await expect(page.locator('[data-testid="flow-diagram"]').first()).toBeVisible({ timeout: 15000 });
}

test.describe('Focus Mode Current UI Smoke', () => {
  test('设置面板应暴露当前专注功能开关', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await openSettings(page);

    await expect(page.locator('[data-testid="settings-gate-toggle"]').first()).toHaveAttribute('role', 'switch');
    await expect(page.locator('[data-testid="settings-blackbox-toggle"]').first()).toHaveAttribute('role', 'switch');
    await expect(page.locator('[data-testid="settings-strata-toggle"]').first()).toHaveAttribute('role', 'switch');
    await expect(page.locator('[data-testid="settings-dev-gate"]').first()).toBeVisible();
  });

  test('开发测试入口应能触发 Gate 并推进进度', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await triggerDevGate(page);

    const progress = page.locator('[data-testid="gate-progress"]').first();
    const before = (await progress.textContent())?.trim();

    await expect(page.locator('[data-testid="gate-card"]').first()).toBeVisible();
    await page.locator('[data-testid="gate-read-button"]').first().click({ force: true });

    await expect
      .poll(async () => (await progress.textContent())?.trim(), {
        timeout: 5000,
        intervals: [200, 300, 500],
      })
      .not.toBe(before ?? null);
  });

  test('Gate 快速录入面板应能补录内容', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await triggerDevGate(page);

    await page.locator('[data-testid="gate-quick-capture-toggle"]').first().click({ force: true });
    const panel = page.locator('[data-testid="gate-quick-capture-panel"]').first();
    await expect(panel).toBeVisible({ timeout: 5000 });

    const input = panel.getByPlaceholder('记录一个待处理想法...').first();
    await input.fill('Gate quick capture smoke');
    await panel.getByRole('button', { name: '保存' }).click({ force: true });

    await expect(input).toHaveValue('');
  });

  test('Flow 黑匣子面板应能创建条目', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndOpenProject(page, `focus-blackbox-${testHelpers.uniqueId()}`);
    await ensureFlowReady(page);

    await page.locator('[data-testid="flow-palette-tab-blackbox"]').first().click({ force: true });
    await expect(page.locator('[data-testid="black-box-panel"]').first()).toBeVisible({ timeout: 10000 });

    const entryText = `BlackBox Smoke ${testHelpers.uniqueId()}`;
    await page.locator('[data-testid="black-box-text-input"]').first().fill(entryText);
    await page.locator('[data-testid="black-box-submit"]').first().click({ force: true });

    await expect(page.locator('[data-testid="black-box-entry"]').filter({ hasText: entryText }).first()).toBeVisible({ timeout: 10000 });
  });
});
