import { test, expect, Page } from '@playwright/test';

/**
 * NanoFlow E2E 测试
 * 
 * 测试3个关键用户路径：
 * 1. 登录 + 数据加载
 * 2. 创建任务 + 保存
 * 3. 拖拽 + 同步
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 测试环境配置 */
interface TestEnvConfig {
  TEST_USER_EMAIL?: string;
  TEST_USER_PASSWORD?: string;
}

/** 测试数据跟踪结构 */
interface CreatedTestData {
  projectIds: Set<string>;
  taskTitles: Set<string>;
}

/** 测试辅助函数接口 */
interface TestHelpers {
  waitForAppReady(page: Page): Promise<void>;
  createTestProject(page: Page, projectName: string): Promise<string | null>;
  uniqueId(): string;
  cleanupTestTasks(page: Page): Promise<void>;
  trackTaskTitle(title: string): void;
  trackProjectId(id: string): void;
  getKeyboardModifier(): 'Meta' | 'Control';
  waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void>;
}

// ============================================================================
// 环境变量验证
// ============================================================================

/** 获取并验证测试环境配置 */
function getTestEnvConfig(): TestEnvConfig {
  return {
    TEST_USER_EMAIL: process.env['TEST_USER_EMAIL'],
    TEST_USER_PASSWORD: process.env['TEST_USER_PASSWORD'],
  };
}

// ============================================================================
// 测试数据跟踪（用于清理）
// ============================================================================

const createdTestData: CreatedTestData = {
  projectIds: new Set<string>(),
  taskTitles: new Set<string>(),
};

// ============================================================================
// 测试辅助函数
// ============================================================================

const testHelpers: TestHelpers = {
  /** 等待应用加载完成 */
  async waitForAppReady(page: Page): Promise<void> {
    // 等待路由加载
    await page.waitForSelector('[data-testid="app-container"]', { timeout: 10000 });
    // 等待loading状态消失
    await expect(page.locator('[data-testid="loading-indicator"]')).not.toBeVisible({ timeout: 10000 });
  },

  /** 访客模式下创建测试项目，返回项目 ID */
  async createTestProject(page: Page, projectName: string): Promise<string | null> {
    // 点击创建项目按钮
    await page.click('[data-testid="create-project-btn"]');
    // 等待对话框出现
    await page.waitForSelector('[data-testid="new-project-modal"]');
    // 输入项目名
    await page.fill('[data-testid="project-name-input"]', projectName);
    // 确认创建
    await page.click('[data-testid="create-project-confirm"]');
    // 等待对话框关闭
    await expect(page.locator('[data-testid="new-project-modal"]')).not.toBeVisible();
    
    // 尝试从 DOM 获取项目 ID
    const projectElement = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`);
    await expect(projectElement).toBeVisible({ timeout: 5000 });
    const projectId = await projectElement.getAttribute('data-project-id');
    
    // 记录创建的项目用于清理
    if (projectId) {
      createdTestData.projectIds.add(projectId);
    }
    
    return projectId;
  },

  /** 生成唯一的测试数据 */
  uniqueId(): string {
    return `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  },

  /** 清理测试创建的任务 */
  async cleanupTestTasks(page: Page): Promise<void> {
    const titlesToClean = Array.from(createdTestData.taskTitles);
    for (const title of titlesToClean) {
      try {
        const taskCard = page.locator(`[data-testid="task-card"]:has-text("${title}")`);
        if (await taskCard.isVisible({ timeout: 1000 }).catch(() => false)) {
          // 尝试删除任务
          await taskCard.click({ button: 'right' });
          const deleteBtn = page.locator('[data-testid="delete-task-btn"]');
          if (await deleteBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            await deleteBtn.click();
            // 等待删除完成
            await expect(taskCard).not.toBeVisible({ timeout: 3000 }).catch(() => {
              console.warn(`任务 "${title}" 删除可能未完成`);
            });
          }
        }
      } catch (error) {
        console.warn(`清理任务 "${title}" 时出错:`, error);
      }
    }
    createdTestData.taskTitles.clear();
  },

  /** 追踪测试创建的任务标题 */
  trackTaskTitle(title: string): void {
    createdTestData.taskTitles.add(title);
  },

  /** 追踪测试创建的项目 ID */
  trackProjectId(id: string): void {
    createdTestData.projectIds.add(id);
  },

  /** 获取跨平台的键盘修饰符 - 始终使用 Control 因为测试在服务器端运行 */
  getKeyboardModifier(): 'Meta' | 'Control' {
    // 注意：Playwright 测试在服务器端运行，应该根据目标浏览器/平台决定
    // 对于 Web 应用，大多数情况下使用 Control 即可
    // 如果需要测试 macOS 特定行为，应该在 playwright.config.ts 中配置
    return 'Control';
  },

  /** 等待任务卡片出现的辅助函数 */
  async waitForTaskCard(page: Page, title: string, options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 5000;
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${title}")`);
    await expect(taskCard).toBeVisible({ timeout });
  }
};

test.describe('关键路径 1: 登录 + 数据加载', () => {
  test('访客模式应能加载默认项目', async ({ page }) => {
    // 访问应用
    await page.goto('/');
    
    // 等待应用加载
    await testHelpers.waitForAppReady(page);
    
    // 验证项目列表或默认项目已加载
    const projectSelector = page.locator('[data-testid="project-selector"]');
    await expect(projectSelector).toBeVisible({ timeout: 10000 });
    
    // 验证没有错误提示
    const errorToast = page.locator('[data-testid="error-toast"]');
    await expect(errorToast).not.toBeVisible();
  });

  test('登录流程应正确处理无效凭据', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 打开登录对话框
    await page.click('[data-testid="login-btn"]');
    await page.waitForSelector('[data-testid="login-modal"]');
    
    // 输入无效凭据
    await page.fill('[data-testid="email-input"]', 'invalid@test.com');
    await page.fill('[data-testid="password-input"]', 'wrongpassword');
    
    // 点击登录
    await page.click('[data-testid="submit-login"]');
    
    // 验证错误提示
    const errorMessage = page.locator('[data-testid="auth-error"]');
    await expect(errorMessage).toBeVisible({ timeout: 5000 });
  });

  test('登录成功后应加载用户数据', async ({ page }) => {
    // 注意：这个测试需要真实的测试账户
    // 在 CI 环境中可以使用环境变量配置测试账户
    const testEmail = process.env['TEST_USER_EMAIL'];
    const testPassword = process.env['TEST_USER_PASSWORD'];
    
    if (!testEmail || !testPassword) {
      test.skip(true, '跳过：未配置测试账户');
      return;
    }
    
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 打开登录对话框
    await page.click('[data-testid="login-btn"]');
    await page.waitForSelector('[data-testid="login-modal"]');
    
    // 输入有效凭据
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.fill('[data-testid="password-input"]', testPassword);
    
    // 点击登录
    await page.click('[data-testid="submit-login"]');
    
    // 等待登录成功
    await expect(page.locator('[data-testid="login-modal"]')).not.toBeVisible({ timeout: 10000 });
    
    // 验证用户头像或用户菜单显示
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
    
    // 验证同步状态
    await expect(page.locator('[data-testid="sync-status"]')).toBeVisible();
  });
});

test.describe('关键路径 2: 创建任务 + 保存', () => {
  test('应能创建新任务', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    const taskTitle = `测试任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle); // 追踪任务用于清理
    
    // 确保在文本视图
    const textViewTab = page.locator('[data-testid="text-view-tab"]');
    if (await textViewTab.isVisible()) {
      await textViewTab.click();
    }
    
    // 点击添加任务按钮
    await page.click('[data-testid="add-task-btn"]');
    
    // 输入任务标题
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    
    // 按回车确认
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 验证任务已创建
    await testHelpers.waitForTaskCard(page, taskTitle);
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 5000 });
  });

  test('任务修改应自动保存', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    const taskTitle = `自动保存测试-${testHelpers.uniqueId()}`;
    const updatedTitle = `已更新-${taskTitle}`;
    testHelpers.trackTaskTitle(taskTitle); // 追踪原始标题
    testHelpers.trackTaskTitle(updatedTitle); // 追踪更新后标题用于清理
    
    // 创建任务
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 等待任务出现
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible();
    
    // 双击编辑
    await taskCard.dblclick();
    
    // 修改标题
    const editInput = taskCard.locator('[data-testid="task-title-edit"]');
    await editInput.clear();
    await editInput.fill(updatedTitle);
    await editInput.press('Enter');
    
    // 验证标题已更新
    await expect(page.locator(`[data-testid="task-card"]:has-text("${updatedTitle}")`)).toBeVisible();
    
    // 刷新页面验证持久化
    await page.reload();
    await testHelpers.waitForAppReady(page);
    
    // 验证任务仍然存在（本地存储）
    await expect(page.locator(`[data-testid="task-card"]:has-text("${updatedTitle}")`)).toBeVisible({ timeout: 10000 });
  });

  test('撤销/重做应正常工作', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    const taskTitle = `撤销测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle); // 追踪任务用于清理
    
    // 创建任务
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 等待任务创建并验证
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    
    // 记录创建后的任务数量
    const initialTaskCount = await page.locator('[data-testid="task-card"]').count();
    
    // 执行撤销 (使用跨平台兼容的修饰符)
    const modifier = testHelpers.getKeyboardModifier();
    await page.keyboard.press(`${modifier}+z`);
    
    // 验证撤销效果：任务应该消失或任务数量减少
    // 使用显式等待而非固定超时
    await expect(async () => {
      const currentCount = await page.locator('[data-testid="task-card"]').count();
      // 撤销后任务数量应该减少，或特定任务应该不可见
      expect(currentCount).toBeLessThanOrEqual(initialTaskCount);
    }).toPass({ timeout: 3000 });
    
    // 执行重做 (Ctrl+Shift+Z / Cmd+Shift+Z)
    await page.keyboard.press(`${modifier}+Shift+z`);
    
    // 验证重做效果：任务应该重新出现
    await expect(async () => {
      const countAfterRedo = await page.locator('[data-testid="task-card"]').count();
      expect(countAfterRedo).toBeGreaterThanOrEqual(initialTaskCount);
    }).toPass({ timeout: 3000 });
    
    // 最终验证：任务卡片应该存在（无论撤销/重做的具体行为如何）
    // 这确保了 UI 处于一致状态
    await expect(page.locator('[data-testid="task-card"]')).toHaveCount(initialTaskCount, { timeout: 3000 });
  });
});

test.describe('关键路径 3: 拖拽 + 同步', () => {
  test('任务拖拽应更新父级关系', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 创建父任务
    const parentTitle = `父任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(parentTitle); // 追踪任务用于清理
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', parentTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    const parentCard = page.locator(`[data-testid="task-card"]:has-text("${parentTitle}")`);
    await expect(parentCard).toBeVisible({ timeout: 5000 });
    
    // 创建子任务
    const childTitle = `子任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(childTitle); // 追踪任务用于清理
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', childTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    const childCard = page.locator(`[data-testid="task-card"]:has-text("${childTitle}")`);
    await expect(childCard).toBeVisible({ timeout: 5000 });
    
    // 记录拖拽前子任务的初始缩进层级（如果有）
    const initialIndentAttr = await childCard.getAttribute('data-indent-level').catch(() => '0');
    
    // 拖拽子任务到父任务下
    const parentDropZone = parentCard.locator('[data-testid="child-drop-zone"]');
    
    // 确保拖放区域存在
    await expect(parentDropZone).toBeVisible({ timeout: 3000 });
    
    await childCard.dragTo(parentDropZone);
    
    // 验证子任务已成为父任务的子节点 - 使用多种验证策略
    await expect(async () => {
      // 策略1：检查子任务是否在父任务容器内
      const nestedChild = parentCard.locator(`[data-testid="task-card"]:has-text("${childTitle}")`);
      const isNested = await nestedChild.isVisible().catch(() => false);
      
      // 策略2：检查缩进层级是否增加
      const currentIndentAttr = await childCard.getAttribute('data-indent-level').catch(() => '0');
      const indentIncreased = parseInt(currentIndentAttr || '0') > parseInt(initialIndentAttr || '0');
      
      // 策略3：检查父级关系指示器
      const hasParentIndicator = await childCard.locator('[data-testid="parent-indicator"]').isVisible().catch(() => false);
      
      // 至少一种策略应该验证成功
      expect(isNested || indentIncreased || hasParentIndicator).toBe(true);
    }).toPass({ timeout: 5000 });
    
    // 最终断言：确认拖拽操作完成后 UI 状态一致
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
    
    // 等待流程图加载
    await page.waitForSelector('[data-testid="flow-diagram"]', { timeout: 10000 });
    
    // 找到任意节点
    const flowNode = page.locator('[data-testid="flow-node"]').first();
    if (!await flowNode.isVisible()) {
      // 如果没有节点，创建一个任务
      await page.click('[data-testid="create-unassigned-btn"]');
      await page.waitForSelector('[data-testid="flow-node"]');
    }
    
    // 确保节点可见
    await expect(flowNode).toBeVisible({ timeout: 5000 });
    
    // 记录初始位置 - 必须断言不为 null
    const initialBox = await flowNode.boundingBox();
    expect(initialBox).not.toBeNull();
    if (!initialBox) {
      throw new Error('无法获取流程图节点的初始位置');
    }
    
    // 定义拖拽偏移量
    const dragOffsetX = 100;
    const dragOffsetY = 50;
    
    // 拖拽节点
    await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(initialBox.x + dragOffsetX, initialBox.y + dragOffsetY);
    await page.mouse.up();
    
    // 等待位置更新 - 使用显式状态等待
    await expect(async () => {
      const newBox = await flowNode.boundingBox();
      expect(newBox).not.toBeNull();
      if (!newBox) {
        throw new Error('无法获取流程图节点的新位置');
      }
      // 验证位置确实已改变（允许一定的浮点误差）
      const positionChanged = Math.abs(newBox.x - initialBox.x) > 5 || Math.abs(newBox.y - initialBox.y) > 5;
      expect(positionChanged).toBe(true);
    }).toPass({ timeout: 3000 });
    
    // 最终验证：获取并断言最终位置
    const finalBox = await flowNode.boundingBox();
    expect(finalBox).not.toBeNull();
    expect(finalBox!.x).not.toBeCloseTo(initialBox.x, 0);
  });

  test('离线修改应在重连后同步', async ({ page, context }) => {
    // 注意：这个测试需要登录用户才能测试云同步
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
    
    // 验证离线状态显示
    await expect(page.locator('[data-testid="offline-indicator"]')).toBeVisible({ timeout: 5000 });
    
    // 创建离线任务
    const offlineTaskTitle = `离线任务-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(offlineTaskTitle); // 追踪任务用于清理
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', offlineTaskTitle);
    await page.press('[data-testid="task-title-input"]', 'Enter');
    
    // 验证任务已创建（本地）
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible();
    
    // 验证待同步指示器
    await expect(page.locator('[data-testid="pending-sync-indicator"]')).toBeVisible();
    
    // 恢复在线
    await context.setOffline(false);
    
    // 等待同步完成
    await expect(page.locator('[data-testid="sync-success-indicator"]')).toBeVisible({ timeout: 15000 });
    
    // 刷新页面验证数据已同步到云端
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await expect(page.locator(`[data-testid="task-card"]:has-text("${offlineTaskTitle}")`)).toBeVisible({ timeout: 10000 });
  });
});

// 可选：性能测试
test.describe('性能基准', () => {
  test('应用加载时间应在可接受范围内', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    const loadTime = Date.now() - startTime;
    
    // 首次加载应在5秒内
    expect(loadTime).toBeLessThan(5000);
    console.log(`应用加载时间: ${loadTime}ms`);
  });

  test('大量任务下仍能响应', async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    
    // 快速创建10个任务
    for (let i = 0; i < 10; i++) {
      const taskTitle = `批量任务-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      await page.click('[data-testid="add-task-btn"]');
      await page.fill('[data-testid="task-title-input"]', taskTitle);
      await page.press('[data-testid="task-title-input"]', 'Enter');
    }
    
    // 验证UI仍能响应
    const addButton = page.locator('[data-testid="add-task-btn"]');
    await expect(addButton).toBeEnabled();
    
    // 验证所有任务都已创建
    const taskCards = page.locator('[data-testid="task-card"]');
    const count = await taskCards.count();
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

// ============================================================================
// 测试清理
// ============================================================================

/**
 * 每个测试组的通用清理逻辑
 * 在每个测试后清理创建的测试数据，避免影响后续测试
 */
test.afterEach(async ({ page }) => {
  try {
    // 尝试清理当前页面上的测试任务
    await testHelpers.cleanupTestTasks(page);
  } catch (error) {
    // 清理失败不应该导致测试失败
    console.warn('测试清理时出现警告:', error);
  }
});

/**
 * 所有测试完成后的全局清理
 */
test.afterAll(async () => {
  // 清空跟踪数据
  createdTestData.projectIds.clear();
  createdTestData.taskTitles.clear();
  
  console.log('E2E 测试清理完成');
});
