import { test, expect, Page } from '@playwright/test';
import { testHelpers } from './helpers';

const SEVENTY_TWO_HOURS_PLUS_MS = 72 * 60 * 60 * 1000 + 10_000;

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
  await projectItem.click();
  await enterProjectWorkspace(page);
}

async function ensureFlowReady(page: Page): Promise<void> {
  const flowTab = page.locator('[data-testid="flow-view-tab"]');
  if (await flowTab.isVisible({ timeout: 1000 }).catch(() => false)) {
    await flowTab.click({ force: true });
  }

  const loadFlowButton = page.getByRole('button', { name: '加载流程图' });
  if (await loadFlowButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loadFlowButton.click();
  }

  await expect(page.locator('[data-testid="flow-diagram"]').first()).toBeVisible({ timeout: 15000 });
}

async function createAndParkTask(page: Page, taskTitle: string): Promise<string> {
  await ensureFlowReady(page);

  const unassignedTab = page.getByRole('button', { name: '待分配区' });
  if (await unassignedTab.isVisible({ timeout: 1000 }).catch(() => false)) {
    await unassignedTab.click();
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
  if (!(await titleInput.isVisible({ timeout: 1200 }).catch(() => false))) {
    const detailToggle = page.getByRole('button', { name: '详情' }).first();
    if (await detailToggle.isVisible({ timeout: 1200 }).catch(() => false)) {
      await detailToggle.click({ force: true });
    }
  }

  if (!(await titleInput.isVisible({ timeout: 1200 }).catch(() => false))) {
    const editToggle = flowDetail.locator('[data-testid="flow-edit-toggle-btn"]').first();
    if (await editToggle.isVisible({ timeout: 1200 }).catch(() => false)) {
      await editToggle.click({ force: true });
    }
  }

  let effectiveTitle = taskTitle;
  if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await titleInput.fill(taskTitle);
    await titleInput.blur();
  } else {
    const titlePreview = flowDetail.locator('[data-testid="flow-task-title"]').first();
    if (await titlePreview.isVisible({ timeout: 2000 }).catch(() => false)) {
      const previewTitle = (await titlePreview.textContent())?.trim();
      if (previewTitle) {
        effectiveTitle = previewTitle;
      }
    }
  }

  const parkButton = flowDetail.getByRole('button', { name: /^停泊$/ }).first();
  await expect(parkButton).toBeVisible({ timeout: 10000 });
  await parkButton.click({ force: true });

  await expect(page.locator('[data-testid="parking-dock-trigger"]')).toBeVisible({ timeout: 10000 });
  return effectiveTitle;
}

async function openDock(page: Page): Promise<void> {
  await page.locator('[data-testid="parking-dock-trigger"]').click();
  await expect(page.locator('[data-testid="parking-dock-panel"], [data-testid="parking-dock-sheet"]')).toBeVisible({ timeout: 8000 });
}

async function setQuickReminderFromDock(page: Page): Promise<void> {
  await openDock(page);
  await page.locator('[data-testid="parking-dock-item"]').first().click();

  await page.getByRole('button', { name: '更多操作' }).first().click();
  await page.getByRole('button', { name: /设置提醒/ }).first().click();
  await page.getByRole('button', { name: /5\s*分钟后/ }).first().click();

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeHidden({ timeout: 5000 });
}

test.describe('ParkingNotice 关键路径', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-02-23T08:00:00Z') });
  });

  test('P-05: Reminder 三阶段消散（前 5s 免疫，之后可交互消散）', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `提醒通知-${testHelpers.uniqueId()}`;
    const taskTitle = `提醒任务-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    const parkedTitle = await createAndParkTask(page, taskTitle);
    await setQuickReminderFromDock(page);

    await page.clock.fastForward('05:01');

    const notice = page.locator('[data-testid="parking-notice"]');
    await expect(notice).toBeVisible({ timeout: 10000 });
    await expect(notice).toContainText(parkedTitle);

    // 前 5s 外部点击不应消散
    await page.mouse.click(8, 8);
    await expect(notice).toBeVisible({ timeout: 2000 });

    // 超过免疫窗口后，外部点击可消散
    await page.clock.fastForward('00:05');
    await page.mouse.click(8, 8);
    await expect(notice).toBeHidden({ timeout: 5000 });
  });

  test('P-05b/P-09/P-10: 72h 清理通知最短可见 + 撤回恢复', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `清理通知-${testHelpers.uniqueId()}`;
    const taskTitle = `清理任务-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    // 推进到 72h 后，触发衰老清理
    await page.clock.fastForward(SEVENTY_TWO_HOURS_PLUS_MS);

    const notice = page.locator('[data-testid="parking-notice"]');
    await expect(notice).toBeVisible({ timeout: 10000 });
    await expect(notice).toContainText('自动');

    // 最短可见窗口内，外部点击不可消散
    await page.mouse.click(8, 8);
    await expect(notice).toBeVisible({ timeout: 2000 });

    // 清理后任务应暂时离开停泊坞（N=0 且关闭时触发条隐藏）
    await expect(page.locator('[data-testid="parking-dock-trigger"]')).toBeHidden({ timeout: 5000 });

    // 撤回恢复原停泊状态
    await page.getByRole('button', { name: '撤回' }).first().click();
    await expect(notice).toBeHidden({ timeout: 5000 });
    await expect(page.locator('[data-testid="parking-dock-trigger"]')).toBeVisible({ timeout: 5000 });

    await openDock(page);
    await expect(page.locator('[data-testid="parking-dock-item"]')).toHaveCount(1, { timeout: 5000 });
  });

  test('P-16: 离线期间不触发清理，恢复在线后重算', async ({ page, context }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `离线清理-${testHelpers.uniqueId()}`;
    const taskTitle = `离线任务-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    await context.setOffline(true);
    await page.clock.fastForward(SEVENTY_TWO_HOURS_PLUS_MS);

    await expect(page.locator('[data-testid="parking-notice"]')).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.locator('[data-testid="parking-notice"]')).toBeVisible({ timeout: 10000 });
  });

  test('P-26: Gate 激活时清理通知排队，Gate 关闭后展示', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `Gate排队-${testHelpers.uniqueId()}`;
    const taskTitle = `Gate任务-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    // 打开设置并触发 DEV Gate
    await page.getByRole('button', { name: '打开设置' }).click();
    const devGateButton = page.getByRole('button', { name: '测试大门' });
    await expect(devGateButton).toBeVisible({ timeout: 10000 });
    await devGateButton.click();

    await expect(page.locator('[data-testid="gate-overlay"]')).toBeVisible({ timeout: 10000 });

    // 在 Gate 激活期间推进到清理时刻，通知应排队而不显示
    await page.clock.fastForward(SEVENTY_TWO_HOURS_PLUS_MS);
    await expect(page.locator('[data-testid="parking-notice"]')).toHaveCount(0);

    // 连续完成 Gate 条目，关闭 Gate
    const completeButton = page.locator('[data-testid="gate-complete-button"]');
    for (let i = 0; i < 3; i++) {
      await expect(completeButton).toBeEnabled({ timeout: 5000 });
      await completeButton.click();
      await page.clock.fastForward(2_000);
    }

    await page.clock.fastForward(3_000);
    await expect(page.locator('[data-testid="gate-overlay"]')).toBeHidden({ timeout: 10000 });

    // Gate 关闭后，队列中的 eviction notice 应展示
    await expect(page.locator('[data-testid="parking-notice"]')).toBeVisible({ timeout: 10000 });
  });
});
