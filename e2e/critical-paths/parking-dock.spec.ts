import { test, expect, Page } from '@playwright/test';
import { testHelpers } from './helpers';

async function bootstrapLocalWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await testHelpers.waitForAppReady(page);

  const localModeBtn = page.locator('[data-testid="local-mode-btn"]');
  if (await localModeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await localModeBtn.click();
  }

  await expect(page.locator('[data-testid="project-selector"]')).toBeVisible({ timeout: 15000 });
}

async function enterProjectWorkspace(page: Page): Promise<void> {
  const enterButton = page.getByRole('button', { name: '进入项目' }).first();
  if (await enterButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await enterButton.click({ force: true });
  }

  await expect(page.locator('main[aria-label="任务管理区域"]')).toBeVisible({ timeout: 10000 });
}

async function createAndActivateProject(page: Page, projectName: string): Promise<void> {
  await page.click('[data-testid="create-project-btn"]', { force: true });
  await expect(page.locator('[data-testid="new-project-modal"]')).toBeVisible({ timeout: 8000 });

  const nameInput = page.locator('[data-testid="project-name-input"]');
  await nameInput.fill(projectName);
  await nameInput.press('Enter');
  await expect(page.locator('[data-testid="new-project-modal"]')).toBeHidden({ timeout: 8000 });

  const projectItem = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`);
  await expect(projectItem).toBeVisible({ timeout: 10000 });
  await projectItem.click({ force: true });
  await enterProjectWorkspace(page);
}

async function activateFirstProject(page: Page): Promise<void> {
  const projectItem = page.locator('[data-testid="project-item"]').first();
  await expect(projectItem).toBeVisible({ timeout: 10000 });
  await projectItem.click({ force: true });
  await enterProjectWorkspace(page);
}

async function ensureFlowReady(page: Page): Promise<void> {
  const flowTab = page.locator('[data-testid="flow-view-tab"]');
  if (await flowTab.isVisible({ timeout: 1000 }).catch(() => false)) {
    await flowTab.click({ force: true });
  }

  const loadFlowButton = page.getByRole('button', { name: '加载流程图' });
  if (await loadFlowButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loadFlowButton.click({ force: true });
  }

  await expect(page.locator('[data-testid="flow-diagram"]').first()).toBeVisible({ timeout: 15000 });
}

async function createAndParkTask(page: Page, taskTitle: string): Promise<void> {
  await ensureFlowReady(page);

  const unassignedTab = page.getByRole('button', { name: '待分配区' });
  if (await unassignedTab.isVisible({ timeout: 1000 }).catch(() => false)) {
    await unassignedTab.click({ force: true });
  }

  const createBtn = page.locator('[data-testid="create-unassigned-btn"]').first();
  if (!(await createBtn.isVisible({ timeout: 1200 }).catch(() => false))) {
    const topHandle = page.locator('.mobile-drawer-container .drawer-handle').first();
    if (await topHandle.isVisible({ timeout: 1200 }).catch(() => false)) {
      await topHandle.click({ force: true });
    }
  }
  await expect(createBtn).toBeVisible({ timeout: 10000 });
  await createBtn.click({ force: true });

  const desktopUnassignedItem = page.locator('.draggable-item').first();
  const mobileUnassignedItem = page.locator('#unassignedPalette [draggable="true"]').first();
  const unassignedItem = await desktopUnassignedItem.isVisible({ timeout: 1500 }).catch(() => false)
    ? desktopUnassignedItem
    : mobileUnassignedItem;

  await expect(unassignedItem).toBeVisible({ timeout: 10000 });
  await unassignedItem.click({ force: true });

  const flowDetail = page.locator('app-flow-task-detail').first();
  const titleInput = flowDetail.locator('[data-testid="flow-task-title-input"]').first();
  if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await titleInput.fill(taskTitle);
    await titleInput.blur();
  }

  const parkButton = flowDetail.getByRole('button', { name: /^停泊$/ }).first();
  await expect(parkButton).toBeVisible({ timeout: 10000 });
  await parkButton.click({ force: true });
}

test.describe('ParkingDock V3 critical paths', () => {
  test('dock-v3 panel is always visible and focus stage toggles on/off', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `DockV3-${testHelpers.uniqueId()}`;
    const taskTitle = `DockTask-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    const panel = page.locator('[data-testid="dock-v3-panel"]');
    await expect(panel).toBeVisible({ timeout: 10000 });

    const items = page.locator('[data-testid="dock-v3-item"]');
    await expect(items.first()).toBeVisible({ timeout: 10000 });

    const focusToggle = page.locator('[data-testid="dock-v3-focus-toggle"]');
    await focusToggle.click({ force: true });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="dock-v3-status-machine"]')).toBeVisible({ timeout: 8000 });

    await focusToggle.click({ force: true });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeHidden({ timeout: 8000 });
  });

  test('full mode shows advanced entry and keeps dock hints/drop-zone', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `DockStrict-${testHelpers.uniqueId()}`;
    const taskTitle = `DockStrictTask-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    await expect(page.locator('[data-testid="dock-v3-create-toggle"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="dock-v3-drop-zone"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="dock-v3-help-hints"]')).toBeVisible({ timeout: 8000 });
  });
});
