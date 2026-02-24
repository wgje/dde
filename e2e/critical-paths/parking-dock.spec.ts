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
  await projectItem.click();
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

test.describe('ParkingDock 关键路径', () => {
  test('P-01/P-02/P-11/P-39: 预览切换、手动移除撤回、展开收起', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `停车坞桌面-${testHelpers.uniqueId()}`;
    const taskTitle = `Dock任务-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    const trigger = page.locator('[data-testid="parking-dock-trigger"]');
    await expect(trigger).toContainText('停泊 (1)');

    // 展开 Dock 并单击卡片进入预览（不切换 focus）
    await openDock(page);
    const dockItem = page.locator('[data-testid="parking-dock-item"]').first();
    await dockItem.click();
    await expect(page.getByText('稍后处理中（未切换到此任务）')).toBeVisible({ timeout: 5000 });

    // 点击“切换到此任务”触发 startWork
    await page.getByRole('button', { name: '切换到此任务' }).first().click();
    await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeHidden({ timeout: 8000 });

    // 再停泊一个任务，验证手动移除 + 撤回
    const secondTaskTitle = `Dock任务2-${testHelpers.uniqueId()}`;
    await createAndParkTask(page, secondTaskTitle);
    await openDock(page);
    const dockItems = page.locator('[data-testid="parking-dock-item"]');
    const beforeRemoveCount = await dockItems.count();
    expect(beforeRemoveCount).toBeGreaterThan(0);
    await dockItems.first().click();

    await page.getByRole('button', { name: '更多操作' }).first().click();
    await page.getByRole('button', { name: '移回任务列表' }).last().click();

    await expect(dockItems).toHaveCount(beforeRemoveCount - 1, { timeout: 5000 });

    const undoBtn = page.getByRole('button', { name: '撤回' }).first();
    await expect(undoBtn).toBeVisible({ timeout: 5000 });
    await undoBtn.click();

    await expect(dockItems).toHaveCount(beforeRemoveCount, { timeout: 5000 });

    // P-39 收起路径：Esc / 触发条 / 面板外
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeHidden({ timeout: 5000 });

    await trigger.click();
    await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeVisible({ timeout: 5000 });

    await trigger.click();
    await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeHidden({ timeout: 5000 });

    await trigger.click();
    await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeVisible({ timeout: 5000 });
    await page.locator('.dock-backdrop').click();
    await expect(page.locator('[data-testid="parking-dock-panel"]')).toBeHidden({ timeout: 5000 });
  });

  test('P-38: 触发条与分隔线定位正确', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectName = `停车坞定位-${testHelpers.uniqueId()}`;
    const taskTitle = `定位任务-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectName);
    await createAndParkTask(page, taskTitle);

    const trigger = page.locator('[data-testid="parking-dock-trigger"]');
    const resizer = page.locator('.cursor-col-resize').last();

    const triggerBox = await trigger.boundingBox();
    const resizerBox = await resizer.boundingBox();

    expect(triggerBox).not.toBeNull();
    expect(resizerBox).not.toBeNull();
    if (!triggerBox || !resizerBox) {
      throw new Error('无法读取 Dock 触发条或 Resizer 几何信息');
    }

    const triggerCenterX = triggerBox.x + triggerBox.width / 2;
    const resizerCenterX = resizerBox.x + resizerBox.width / 2;
    expect(Math.abs(triggerCenterX - resizerCenterX)).toBeLessThanOrEqual(28);

    // 文本栏折叠后应居于 Flow 区中央（≈ 视口中心）
    await page.getByRole('button', { name: '折叠文本栏' }).click();
    await page.waitForTimeout(300);

    const collapsedTriggerBox = await trigger.boundingBox();
    expect(collapsedTriggerBox).not.toBeNull();
    if (!collapsedTriggerBox) {
      throw new Error('文本栏折叠后无法读取 Dock 触发条几何信息');
    }

    const mainAreaBox = await page.locator('main[aria-label="任务管理区域"]').boundingBox();
    expect(mainAreaBox).not.toBeNull();
    if (!mainAreaBox) {
      throw new Error('无法读取任务区域尺寸');
    }

    const collapsedCenterX = collapsedTriggerBox.x + collapsedTriggerBox.width / 2;
    const mainAreaCenterX = mainAreaBox.x + mainAreaBox.width / 2;
    expect(Math.abs(collapsedCenterX - mainAreaCenterX)).toBeLessThanOrEqual(40);
  });
});

test.describe('ParkingDock 移动端一致性', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('P-39/P-40: 移动端 Bottom Sheet 展开收起与跨视图一致', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const taskTitle = `移动任务-${testHelpers.uniqueId()}`;

    await activateFirstProject(page);
    await createAndParkTask(page, taskTitle);

    const textTab = page.locator('[data-testid="text-view-tab"]');
    if (await textTab.isVisible({ timeout: 1000 }).catch(() => false)) {
      await textTab.click({ force: true });
    }

    const trigger = page.locator('[data-testid="parking-dock-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 8000 });

    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    if (!triggerBox) {
      throw new Error('无法读取移动端触发条几何信息');
    }

    const viewport = page.viewportSize();
    if (!viewport) {
      throw new Error('无法读取移动端 viewport 尺寸');
    }

    const centerX = triggerBox.x + triggerBox.width / 2;
    expect(Math.abs(centerX - viewport.width / 2)).toBeLessThanOrEqual(40);
    expect(triggerBox.y + triggerBox.height).toBeGreaterThan(viewport.height - 180);

    await trigger.click();
    await expect(page.locator('[data-testid="parking-dock-sheet"]')).toBeVisible({ timeout: 5000 });

    // 收起后切到 Flow，再次展开，验证同组件行为一致
    await page.locator('.dock-backdrop').click();
    await expect(page.locator('[data-testid="parking-dock-sheet"]')).toBeHidden({ timeout: 5000 });

    await page.locator('[data-testid="flow-view-tab"]').click({ force: true });
    await expect(page.locator('[data-testid="text-view-tab"]')).toBeVisible({ timeout: 10000 });

    await trigger.click({ force: true });
    await expect(page.locator('[data-testid="parking-dock-sheet"]')).toBeVisible({ timeout: 5000 });

    await page.locator('.dock-backdrop').click();
    await expect(page.locator('[data-testid="parking-dock-sheet"]')).toBeHidden({ timeout: 5000 });

    await page.locator('[data-testid="text-view-tab"]').click({ force: true });
    await trigger.click({ force: true });
    await expect(page.locator('[data-testid="parking-dock-sheet"]')).toBeVisible({ timeout: 5000 });
  });
});
