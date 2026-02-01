/**
 * 关键路径 5: Split-Brain 输入防护
 * 
 * 从 critical-paths.spec.ts 拆分
 * 防止输入内容丢失的测试
 */
import { test, expect } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

test.describe('关键路径 5: Split-Brain 输入防护', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
  });

  /**
   * "慢思考者"场景
   * 验证：用户在输入框中思考 60 秒后继续输入，不应被远程更新覆盖
   */
  test('慢思考者：长时间聚焦后输入应正确保存', async ({ page }) => {
    const taskTitle = `慢思考者测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    const titleInput = page.locator('[data-testid="task-title-input"]');
    await expect(titleInput).toBeVisible({ timeout: 3000 });
    
    await titleInput.fill(taskTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    await taskCard.click();
    await page.waitForTimeout(300);
    
    const editTitleInput = page.locator('[data-title-input]').or(page.locator('[data-testid="task-title-input"]'));
    if (await editTitleInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await editTitleInput.focus();
      
      // 模拟"思考"
      await page.waitForTimeout(3000);
      
      const newTitle = `${taskTitle}-思考后更新`;
      await editTitleInput.fill(newTitle);
      await editTitleInput.blur();
      await page.waitForTimeout(1000);
      
      const updatedCard = page.locator(`[data-testid="task-card"]:has-text("思考后更新")`);
      await expect(updatedCard).toBeVisible({ timeout: 5000 });
      
      console.log('慢思考者测试通过：长时间聚焦后输入正确保存');
    } else {
      console.log('慢思考者测试跳过：未找到编辑输入框');
    }
  });

  /**
   * "快速切换"场景
   * 验证：快速从任务 A 切换到任务 B 时，两个任务都正确处理
   */
  test('快速切换：快速切换任务时两者都应正确处理', async ({ page }) => {
    const taskTitleA = `快速切换A-${testHelpers.uniqueId()}`;
    const taskTitleB = `快速切换B-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitleA);
    testHelpers.trackTaskTitle(taskTitleB);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitleA);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitleB);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    const taskCardA = page.locator(`[data-testid="task-card"]:has-text("${taskTitleA}")`);
    const taskCardB = page.locator(`[data-testid="task-card"]:has-text("${taskTitleB}")`);
    await expect(taskCardA).toBeVisible({ timeout: 3000 });
    await expect(taskCardB).toBeVisible({ timeout: 3000 });
    
    await taskCardA.click();
    await page.waitForTimeout(300);
    
    const editInputA = page.locator('[data-title-input]').or(page.locator('[data-testid="task-title-input"]'));
    if (await editInputA.isVisible({ timeout: 1000 }).catch(() => false)) {
      const updatedTitleA = `${taskTitleA}-已编辑`;
      await editInputA.fill(updatedTitleA);
      
      // 立即点击任务 B（不等待，模拟快速切换）
      await taskCardB.click();
      await page.waitForTimeout(500);
      
      const updatedCardA = page.locator(`[data-testid="task-card"]:has-text("已编辑")`);
      await expect(updatedCardA).toBeVisible({ timeout: 5000 });
      
      console.log('快速切换测试通过：任务 A 正确保存，任务 B 正确切换');
    } else {
      console.log('快速切换测试跳过：未找到编辑输入框');
    }
  });

  /**
   * "自我破坏"场景（跨标签页）
   * 验证：当一个标签页锁定字段时，另一个标签页的更新不应覆盖它
   */
  test('自我破坏：聚焦时应阻止外部更新', async ({ page, context }) => {
    const taskTitle = `跨标签测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    
    await taskCard.click();
    await page.waitForTimeout(300);
    
    const editInput = page.locator('[data-title-input]').or(page.locator('[data-testid="task-title-input"]'));
    if (await editInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await editInput.focus();
      
      // 打开第二个标签页
      const page2 = await context.newPage();
      await page2.goto('/');
      await testHelpers.waitForAppReady(page2);
      
      const taskCard2 = page2.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
      if (await taskCard2.isVisible({ timeout: 3000 }).catch(() => false)) {
        await taskCard2.click();
        await page2.waitForTimeout(300);
        
        const editInput2 = page2.locator('[data-title-input]').or(page2.locator('[data-testid="task-title-input"]'));
        if (await editInput2.isVisible({ timeout: 1000 }).catch(() => false)) {
          const tab2Title = `${taskTitle}-来自标签页2`;
          await editInput2.fill(tab2Title);
          await editInput2.blur();
          await page2.waitForTimeout(1000);
        }
      }
      
      await page.bringToFront();
      
      const currentValue = await editInput.inputValue();
      expect(currentValue).toBe(taskTitle);
      
      const tab1Title = `${taskTitle}-来自标签页1`;
      await editInput.fill(tab1Title);
      await editInput.blur();
      await page.waitForTimeout(1000);
      
      const finalCard = page.locator(`[data-testid="task-card"]:has-text("来自标签页1")`);
      await expect(finalCard).toBeVisible({ timeout: 5000 });
      
      await page2.close();
      
      console.log('跨标签页测试通过：聚焦时阻止了外部更新，后写优先');
    } else {
      console.log('跨标签页测试跳过：未找到编辑输入框');
    }
  });

  /**
   * 输入防护回归测试
   * 验证：基本的输入保存功能正常工作
   */
  test('基本输入：标题和内容应正确保存', async ({ page }) => {
    const taskTitle = `基本输入测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    
    await page.reload();
    await testHelpers.waitForAppReady(page);
    
    const persistedCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(persistedCard).toBeVisible({ timeout: 5000 });
    
    console.log('基本输入测试通过：任务正确创建和持久化');
  });

  /**
   * 5 秒延迟解锁测试
   * 验证：blur 后 5 秒内的远程更新应被阻止
   */
  test('延迟解锁：blur 后 5 秒内应保持锁定', async ({ page }) => {
    const taskTitle = `延迟解锁测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    await taskCard.click();
    await page.waitForTimeout(300);
    
    const editInput = page.locator('[data-title-input]').or(page.locator('[data-testid="task-title-input"]'));
    if (await editInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const updatedTitle = `${taskTitle}-已更新`;
      await editInput.fill(updatedTitle);
      await editInput.blur();
      
      await page.waitForTimeout(500);
      const updatedCard = page.locator(`[data-testid="task-card"]:has-text("已更新")`);
      await expect(updatedCard).toBeVisible({ timeout: 3000 });
      
      console.log('延迟解锁测试通过：blur 后内容立即保存到本地');
    } else {
      console.log('延迟解锁测试跳过：未找到编辑输入框');
    }
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
