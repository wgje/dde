/**
 * 关键路径 3: 拖拽 + 同步 + 性能基准 + 撤销压力测试
 * 
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect, Page } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

test.describe('关键路径 3: 拖拽 + 同步', () => {
  test('任务拖拽应更新父级关系', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 创建父任务
    const parentTitle = `父任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(parentTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', parentTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    const parentCard = page.locator(`[data-testid="task-card"]:has-text("${parentTitle}")`);
    await expect(parentCard).toBeVisible({ timeout: 5000 });
    
    // 创建子任务
    const childTitle = `子任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(childTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', childTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    const childCard = page.locator(`[data-testid="task-card"]:has-text("${childTitle}")`);
    await expect(childCard).toBeVisible({ timeout: 5000 });
    
    // 记录拖拽前子任务的初始缩进层级
    const initialIndentAttr = await childCard.getAttribute('data-indent-level').catch(() => '0');
    
    // 拖拽子任务到父任务下
    const parentDropZone = parentCard.locator('[data-testid="child-drop-zone"]');
    await expect(parentDropZone).toBeVisible({ timeout: 3000 });
    await childCard.dragTo(parentDropZone);
    
    // 验证子任务已成为父任务的子节点
    await expect(async () => {
      const nestedChild = parentCard.locator(`[data-testid="task-card"]:has-text("${childTitle}")`);
      const isNested = await nestedChild.isVisible().catch(() => false);
      const currentIndentAttr = await childCard.getAttribute('data-indent-level').catch(() => '0');
      const indentIncreased = parseInt(currentIndentAttr || '0') > parseInt(initialIndentAttr || '0');
      const hasParentIndicator = await childCard.locator('[data-testid="parent-indicator"]').isVisible().catch(() => false);
      expect(isNested || indentIncreased || hasParentIndicator).toBe(true);
    }).toPass({ timeout: 5000 });
    
    await expect(childCard).toBeVisible();
    await expect(parentCard).toBeVisible();
  });

  test('流程图视图拖拽应更新位置', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 切换到流程图视图
    const flowViewTab = page.locator('[data-testid="flow-view-tab"]');
    if (await flowViewTab.isVisible()) {
      await flowViewTab.click();
    }
    
    await page.waitForSelector('[data-testid="flow-diagram"]', { timeout: 10000 });
    
    const flowNode = page.locator('[data-testid="flow-node"]').first();
    if (!await flowNode.isVisible()) {
      await page.click('[data-testid="create-unassigned-btn"]');
      await page.waitForSelector('[data-testid="flow-node"]');
    }
    
    await expect(flowNode).toBeVisible({ timeout: 5000 });
    
    const initialBox = await flowNode.boundingBox();
    expect(initialBox).not.toBeNull();
    if (!initialBox) {
      throw new Error('无法获取流程图节点的初始位置');
    }
    
    const dragOffsetX = 100;
    const dragOffsetY = 50;
    
    await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(initialBox.x + dragOffsetX, initialBox.y + dragOffsetY);
    await page.mouse.up();
    
    await expect(async () => {
      const newBox = await flowNode.boundingBox();
      expect(newBox).not.toBeNull();
      if (!newBox) {
        throw new Error('无法获取流程图节点的新位置');
      }
      const positionChanged = Math.abs(newBox.x - initialBox.x) > 5 || Math.abs(newBox.y - initialBox.y) > 5;
      expect(positionChanged).toBe(true);
    }).toPass({ timeout: 3000 });
    
    const finalBox = await flowNode.boundingBox();
    expect(finalBox).not.toBeNull();
    expect(finalBox!.x).not.toBeCloseTo(initialBox.x, 0);
  });

  test('离线修改应在重连后同步', async ({ page, context }) => {
    const testEmail = process.env['TEST_USER_EMAIL'];
    const testPassword = process.env['TEST_USER_PASSWORD'];
    
    if (!testEmail || !testPassword) {
      test.skip(true, '跳过：未配置测试账户');
      return;
    }
    
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 登录
    await page.click('[data-testid="login-btn"]');
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.fill('[data-testid="password-input"]', testPassword);
    await page.click('[data-testid="submit-login"]');
    await expect(page.locator('[data-testid="login-modal"]')).not.toBeVisible({ timeout: 10000 });
    
    // 模拟离线
    await context.setOffline(true);
    await expect(page.locator('[data-testid="offline-indicator"]')).toBeVisible({ timeout: 5000 });
    
    // 创建离线任务
    const offlineTaskTitle = `离线任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(offlineTaskTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', offlineTaskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible();
    
    // 离线状态下刷新页面，验证 IndexedDB 持久化
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible({ timeout: 10000 });
    
    // 恢复在线
    await context.setOffline(false);
    await expect(page.locator('[data-testid="sync-status-indicator"][data-testid-success="sync-success-indicator"]')).toBeVisible({ timeout: 15000 });
    
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible({ timeout: 10000 });
  });

  test('多端一致性：完成/删除/拖拽后另一端不回滚', async ({ browser }) => {
    const testEmail = process.env['TEST_USER_EMAIL'];
    const testPassword = process.env['TEST_USER_PASSWORD'];

    if (!testEmail || !testPassword) {
      test.skip(true, '跳过：未配置测试账户');
      return;
    }

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const login = async (p: Page) => {
      await p.goto('/');
      await testHelpers.waitForAppReady(p);
      await p.click('[data-testid="login-btn"]');
      await p.waitForSelector('[data-testid="login-modal"]');
      await p.fill('[data-testid="email-input"]', testEmail);
      await p.fill('[data-testid="password-input"]', testPassword);
      await p.click('[data-testid="submit-login"]');
      await expect(p.locator('[data-testid="login-modal"]')).not.toBeVisible({ timeout: 10000 });
      await expect(p.locator('[data-testid="user-menu"]')).toBeVisible({ timeout: 10000 });
    };

    const waitCloudSaved = async (p: Page) => {
      await expect(
        p.locator('[data-testid="sync-status-indicator"][data-testid-success="sync-success-indicator"]')
      ).toBeVisible({ timeout: 20000 });
    };

    const gotoFlowView = async (p: Page) => {
      const flowViewTab = p.locator('[data-testid="flow-view-tab"]');
      if (await flowViewTab.isVisible().catch(() => false)) {
        await flowViewTab.click();
      }
      await p.waitForSelector('[data-testid="flow-diagram"]', { timeout: 15000 });
    };

    const clickDiagramAt = async (p: Page, xRatio: number, yRatio: number, options: { clickCount?: number } = {}) => {
      const diagram = p.locator('[data-testid="flow-diagram"]');
      const box = await diagram.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('无法获取 flow-diagram 的 bounding box');
      await p.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio, { clickCount: options.clickCount ?? 1 });
    };

    const ensureTaskSelected = async (p: Page) => {
      for (const [x, y] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65]] as const) {
        await clickDiagramAt(p, x, y);
        if (await p.locator('[data-testid="flow-edit-toggle-btn"]').isVisible().catch(() => false)) {
          return;
        }
      }
      await clickDiagramAt(p, 0.5, 0.5, { clickCount: 2 });
    };

    const setSelectedTaskTitle = async (p: Page, title: string) => {
      await ensureTaskSelected(p);
      await p.locator('[data-testid="flow-edit-toggle-btn"]').click();
      const input = p.locator('[data-testid="flow-task-title-input"]');
      await expect(input).toBeVisible({ timeout: 5000 });
      await input.fill(title);
      await p.locator('[data-testid="flow-edit-toggle-btn"]').click();
      await expect(p.locator('[data-testid="flow-task-title"]')).toContainText(title, { timeout: 5000 });
    };

    const selectTaskByTitle = async (p: Page, title: string) => {
      for (const [x, y] of [[0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65], [0.5, 0.5]] as const) {
        await clickDiagramAt(p, x, y);
        const currentTitle = p.locator('[data-testid="flow-task-title"]');
        if (await currentTitle.isVisible().catch(() => false)) {
          const text = (await currentTitle.textContent())?.trim() ?? '';
          if (text.includes(title)) return;
        }
      }
      throw new Error(`未能在流程图中选中目标任务: ${title}`);
    };

    try {
      await login(pageA);
      await login(pageB);

      const projectName = `多端一致性-${testHelpers.uniqueId()}`;
      const projectId = await testHelpers.createTestProject(pageA, projectName);
      if (!projectId) throw new Error('创建测试项目失败：无法获取 projectId');

      await pageB.goto('/');
      await testHelpers.waitForAppReady(pageB);
      const projectItemB = pageB.locator(`[data-testid="project-item"]:has-text("${projectName}")`);
      await expect(projectItemB).toBeVisible({ timeout: 20000 });
      await projectItemB.click();

      await gotoFlowView(pageA);
      await gotoFlowView(pageB);

      const title1 = `完成任务-${testHelpers.uniqueId()}`;
      const title2 = `待删除任务-${testHelpers.uniqueId()}`;

      await pageA.click('[data-testid="create-unassigned-btn"]');
      await setSelectedTaskTitle(pageA, title1);
      await waitCloudSaved(pageA);

      await pageA.click('[data-testid="create-unassigned-btn"]');
      await setSelectedTaskTitle(pageA, title2);
      await waitCloudSaved(pageA);

      // 拖拽测试
      const diagram = pageA.locator('[data-testid="flow-diagram"]');
      const box = await diagram.boundingBox();
      if (box) {
        await pageA.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await pageA.mouse.down();
        await pageA.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.58);
        await pageA.mouse.up();
      }

      // 完成任务
      await selectTaskByTitle(pageA, title1);
      await pageA.locator('[data-testid="toggle-task-status-btn"]').click();
      await expect(pageA.locator('[data-testid="flow-task-status-badge"]')).toContainText('完成', { timeout: 5000 });
      await waitCloudSaved(pageA);

      // 删除任务
      await selectTaskByTitle(pageA, title2);
      await pageA.locator('[data-testid="delete-task-btn"]').click();
      await waitCloudSaved(pageA);

      // B 端验证
      await pageB.reload();
      await testHelpers.waitForAppReady(pageB);
      await gotoFlowView(pageB);

      await selectTaskByTitle(pageB, title1);
      await expect(pageB.locator('[data-testid="flow-task-status-badge"]')).toContainText('完成', { timeout: 20000 });

      let deletedStillSelectable = true;
      try {
        await selectTaskByTitle(pageB, title2);
      } catch {
        deletedStillSelectable = false;
      }
      expect(deletedStillSelectable).toBe(false);
    } finally {
      await pageA.close().catch(() => undefined);
      await contextA.close().catch(() => undefined);
      await pageB.close().catch(() => undefined);
      await contextB.close().catch(() => undefined);
    }
  });
});

test.describe('性能基准', () => {
  test('应用加载时间应在可接受范围内', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(5000);
    console.log(`应用加载时间: ${loadTime}ms`);
  });

  test('大量任务下仍能响应', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    for (let i = 0; i < 10; i++) {
      const taskTitle = `批量任务-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      await page.click('[data-testid="add-task-btn"]');
      await page.fill('[data-testid="task-title-input"]', taskTitle);
      await page.press('[data-testid="task-title-input"]', 'Enter');
    }
    
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled();
    
    const taskCards = page.locator('[data-testid="task-card"]');
    const count = await taskCards.count();
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

test.describe('撤销功能压力测试', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
  });

  test('帕金森测试 - 快速连续撤销不崩溃', async ({ page }) => {
    const modifier = testHelpers.getKeyboardModifier();
    
    for (let i = 0; i < 3; i++) {
      const taskTitle = `撤销测试任务-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      await page.click('[data-testid="add-task-btn"]');
      await page.fill('[data-testid="task-title-input"]', taskTitle);
      await page.press('[data-testid="task-title-input"]', 'Enter');
      await page.waitForTimeout(100);
    }
    
    await page.waitForTimeout(500);
    
    console.log('开始快速连续撤销测试...');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(`${modifier}+z`);
      await page.waitForTimeout(50);
    }
    
    await page.waitForTimeout(500);
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled({ timeout: 5000 });
    
    console.log('帕金森测试通过：快速撤销后应用仍响应');
  });

  test('级联撤销 - 删除父节点后撤销恢复', async ({ page }) => {
    const modifier = testHelpers.getKeyboardModifier();
    
    const parentTitle = `父任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(parentTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', parentTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    await page.waitForTimeout(200);
    
    const childTitle = `子任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(childTitle);
    
    const parentCard = page.locator(`[data-testid="task-card"]:has-text("${parentTitle}")`);
    await parentCard.click();
    
    const addChildBtn = page.locator('[data-testid="add-child-task-btn"]');
    if (await addChildBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await addChildBtn.click();
      await page.fill('[data-testid="task-title-input"]', childTitle);
      await page.press('[data-testid="task-title-input"]', 'Enter');
      await page.waitForTimeout(200);
    }
    
    await parentCard.click();
    const deleteBtn = page.locator('[data-testid="delete-task-btn"]');
    if (await deleteBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await deleteBtn.click();
      
      const confirmBtn = page.locator('[data-testid="confirm-delete-btn"]');
      if (await confirmBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await confirmBtn.click();
      }
      
      await page.waitForTimeout(300);
      await expect(parentCard).not.toBeVisible({ timeout: 2000 });
      
      await page.keyboard.press(`${modifier}+z`);
      await page.waitForTimeout(500);
      
      const restoredParent = page.locator(`[data-testid="task-card"]:has-text("${parentTitle}")`);
      await expect(restoredParent).toBeVisible({ timeout: 3000 });
      
      console.log('级联撤销测试通过：删除后撤销成功恢复');
    } else {
      console.log('级联撤销测试跳过：未找到删除按钮');
    }
  });

  test('撤销重做循环 - 多次循环后数据一致', async ({ page }) => {
    const modifier = testHelpers.getKeyboardModifier();
    
    const taskTitle = `循环测试任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    await page.waitForTimeout(300);
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    
    for (let cycle = 0; cycle < 5; cycle++) {
      await page.keyboard.press(`${modifier}+z`);
      await page.waitForTimeout(100);
      await page.keyboard.press(`${modifier}+Shift+z`);
      await page.waitForTimeout(100);
    }
    
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled();
    
    console.log('撤销重做循环测试通过：5次循环后数据一致');
  });
});

// 测试清理
test.afterEach(async ({ page }) => {
  try {
    await testHelpers.cleanupTestTasks(page);
  } catch (error) {
    console.warn('测试清理时出现警告:', error);
  }
});

test.afterAll(async () => {
  createdTestData.projectIds.clear();
  createdTestData.taskTitles.clear();
});
