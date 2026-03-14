import { expect, Page, test } from '@playwright/test';
import { testHelpers } from './helpers';

const REMINDER_TRIGGER_MS = 5 * 60 * 1000 + 1_000;
const EVICTION_TRIGGER_MS = 72 * 60 * 60 * 1000 + 70_000;

async function bootstrapLocalWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await testHelpers.waitForAppReady(page);

  const localModeBtn = page.locator('[data-testid="local-mode-btn"]').first();
  if (await localModeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await localModeBtn.click();
  }

  await expect(page.locator('[data-testid="project-selector"]')).toBeVisible({ timeout: 15000 });
}

async function enterProjectWorkspace(page: Page): Promise<void> {
  const enterButton = page.getByRole('button', { name: /enter/i }).first();
  if (await enterButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await enterButton.click({ force: true });
  }

  await expect(page.locator('[data-testid="project-shell-main-content"]').first()).toBeVisible({ timeout: 10000 });
}

async function createAndActivateProject(page: Page, projectName: string): Promise<void> {
  await page.click('[data-testid="create-project-btn"]', { force: true });
  await expect(page.locator('[data-testid="new-project-modal"]')).toBeVisible({ timeout: 8000 });

  const nameInput = page.locator('[data-testid="project-name-input"]').first();
  await nameInput.fill(projectName);
  await nameInput.press('Enter');
  await expect(page.locator('[data-testid="new-project-modal"]')).toBeHidden({ timeout: 8000 });

  const projectItem = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`).first();
  await expect(projectItem).toBeVisible({ timeout: 10000 });
  await projectItem.click({ force: true });
  await enterProjectWorkspace(page);
}

async function ensureFlowReady(page: Page): Promise<void> {
  const flowTab = page.locator('[data-testid="flow-view-tab"]').first();
  if (await flowTab.isVisible({ timeout: 1200 }).catch(() => false)) {
    await flowTab.click({ force: true });
  }

  const loadFlowButton = page.getByRole('button', { name: /流程图|加载/i }).first();
  if (await loadFlowButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loadFlowButton.click({ force: true });
  }

  const rightPanelToggle = page.locator('[data-testid="flow-open-right-panel"]').first();
  if (!(await page.locator('[data-testid="flow-palette-tab-unassigned"]').first().isVisible({ timeout: 800 }).catch(() => false))) {
    if (await rightPanelToggle.isVisible({ timeout: 1200 }).catch(() => false)) {
      await rightPanelToggle.click({ force: true });
    }
  }
  await expect(page.locator('[data-testid="flow-palette-tab-unassigned"]').first()).toBeVisible({ timeout: 15000 });
}

async function createTextTask(page: Page, taskTitle: string): Promise<void> {
  const textTab = page.locator('[data-testid="text-view-tab"]').first();
  if (await textTab.isVisible({ timeout: 1200 }).catch(() => false)) {
    await textTab.click({ force: true });
  }

  const createButton = page.locator('app-text-unassigned button').filter({ hasText: '新建' }).first();
  await expect(createButton).toBeVisible({ timeout: 10000 });
  await createButton.click({ force: true });

  const titleInput = page.locator('[data-unassigned-task] [data-title-input]').first();
  await expect(titleInput).toBeVisible({ timeout: 10000 });
  await titleInput.fill(taskTitle);
  await titleInput.press('Enter');

  await expect(page.locator(`[data-unassigned-task]:has-text("${taskTitle}")`).first()).toBeVisible({ timeout: 10000 });
}

async function createAndParkFlowTask(page: Page, taskTitle: string): Promise<void> {
  await createTextTask(page, taskTitle);
  await ensureFlowReady(page);

  const unassignedTab = page.locator('[data-testid="flow-palette-tab-unassigned"]').first();
  await expect(unassignedTab).toBeVisible({ timeout: 10000 });
  await unassignedTab.click({ force: true });

  const paletteItem = page.locator(`.draggable-item:has-text("${taskTitle}")`).first();
  await expect(paletteItem).toBeVisible({ timeout: 10000 });
  await paletteItem.click({ force: true });

  const detail = page.locator('app-flow-task-detail').first();
  await expect(detail).toBeVisible({ timeout: 5000 });
  const editToggle = detail.locator('[data-testid="flow-edit-toggle-btn"]').first();
  if (await editToggle.isVisible({ timeout: 1200 }).catch(() => false)) {
    await editToggle.click({ force: true });
  }

  const titleInput = detail.locator('[data-testid="flow-task-title-input"]').first();
  await expect(titleInput).toBeVisible({ timeout: 10000 });
  await titleInput.fill(taskTitle);
  await titleInput.blur();

  const parkButton = detail.locator('[data-testid="flow-task-park-button"]').first();
  await expect(parkButton).toBeVisible({ timeout: 10000 });
  await parkButton.click({ force: true });

  const reminderTrigger = detail.locator('[data-testid="flow-task-reminder-trigger"]').first();
  await expect(reminderTrigger).toBeEnabled({ timeout: 10000 });
}

async function setReminderPreset(page: Page, minutes: 5 | 30 | 120): Promise<void> {
  const detail = page.locator('app-flow-task-detail').first();
  await detail.locator('[data-testid="flow-task-reminder-trigger"]').first().click({ force: true });
  await expect(detail.locator('[data-testid="flow-task-reminder-menu"]').first()).toBeVisible({ timeout: 5000 });
  await detail.locator(`[data-testid="flow-task-reminder-preset-${minutes}"]`).first().click({ force: true });
}

async function openSettings(page: Page): Promise<void> {
  const button = page.locator('[data-testid="workspace-settings-button"]').first();
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click({ force: true });
}

test.describe('ParkingNotice critical paths', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-02-23T08:00:00Z') });
  });

  test('P-05: reminder should stay visible during immune window and dismiss after interactive click', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    const taskTitle = `parking-reminder-task-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, `parking-reminder-${testHelpers.uniqueId()}`);
    await createAndParkFlowTask(page, taskTitle);
    await setReminderPreset(page, 5);

    const notice = page.locator('[data-testid="parking-notice"]');
    await page.clock.fastForward(REMINDER_TRIGGER_MS);
    await expect(notice).toBeVisible({ timeout: 10000 });
    await expect(notice).toContainText(taskTitle);

    await page.mouse.click(8, 8);
    await expect(notice).toBeVisible({ timeout: 2000 });

    await page.clock.fastForward(5_000);
    await page.mouse.click(8, 8);
    await expect(notice).toBeHidden({ timeout: 5000 });
  });

  test('P-05b/P-09/P-10: eviction notice should stay visible and undo should restore parked state', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    const taskTitle = `parking-eviction-task-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, `parking-eviction-${testHelpers.uniqueId()}`);
    await createAndParkFlowTask(page, taskTitle);

    const notice = page.locator('[data-testid="parking-notice"]');
    await page.clock.fastForward(EVICTION_TRIGGER_MS);
    await expect(notice).toBeVisible({ timeout: 10000 });

    await page.mouse.click(8, 8);
    await expect(notice).toBeVisible({ timeout: 2000 });

    await page.getByText('撤回').first().click({ force: true });
    await expect(notice).toBeHidden({ timeout: 5000 });
  });

  test('P-16: eviction should not trigger offline and should recalculate after reconnect', async ({ page, context }) => {
    await bootstrapLocalWorkspace(page);

    await createAndActivateProject(page, `parking-offline-${testHelpers.uniqueId()}`);
    await createAndParkFlowTask(page, `parking-offline-task-${testHelpers.uniqueId()}`);

    await context.setOffline(true);
    await page.clock.fastForward(EVICTION_TRIGGER_MS);
    await expect(page.locator('[data-testid="parking-notice"]')).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.locator('[data-testid="parking-notice"]')).toBeVisible({ timeout: 10000 });
  });

  test('P-26: eviction notice should queue while gate is active and show after gate closes', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    await createAndActivateProject(page, `parking-gate-${testHelpers.uniqueId()}`);
    await createAndParkFlowTask(page, `parking-gate-task-${testHelpers.uniqueId()}`);

    await openSettings(page);
    const devGateButton = page.locator('[data-testid="settings-dev-gate"]').first();
    await expect(devGateButton).toBeVisible({ timeout: 10000 });
    await devGateButton.click({ force: true });

    const gateOverlay = page.locator('[data-testid="gate-overlay"]').first();
    await expect(gateOverlay).toBeVisible({ timeout: 10000 });

    await page.clock.fastForward(EVICTION_TRIGGER_MS);
    await expect(page.locator('[data-testid="parking-notice"]')).toHaveCount(0);

    const completeButton = page.locator('[data-testid="gate-complete-button"]').first();
    for (let i = 0; i < 3; i += 1) {
      await expect(completeButton).toBeVisible({ timeout: 5000 });
      await completeButton.click({ force: true });
      await page.clock.fastForward(1_500);
    }

    await expect(gateOverlay).toBeHidden({ timeout: 10000 });
    await expect(page.locator('[data-testid="parking-notice"]')).toBeVisible({ timeout: 10000 });
  });
});
