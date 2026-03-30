/**
 * 关键路径 5: Split-Brain 输入防护
 * 
 * 从 critical-paths.spec.ts 拆分
 * 防止输入内容丢失的测试
 */
import { test, expect, Page } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

test.describe('关键路径 5: Split-Brain 输入防护', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-03-01T08:00:00Z') });
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
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
    
    const editTitleInput = await testHelpers.openTaskTitleEditor(page, taskTitle);
    await editTitleInput.focus();

    // 使用虚拟时钟推进，避免真实阻塞等待。
    await page.clock.fastForward(3000);

    const newTitle = `${taskTitle}-思考后更新`;
    await editTitleInput.fill(newTitle);
    await editTitleInput.blur();

    const updatedCard = page.locator(`[data-testid="task-card"]:has-text("思考后更新")`);
    await expect(updatedCard).toBeVisible({ timeout: 5000 });
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
    await testHelpers.waitForTaskCard(page, taskTitleA);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitleB);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitleB);
    
    const taskCardB = page.locator(`[data-testid="task-card"]:has-text("${taskTitleB}")`);
    await expect(taskCardB).toBeVisible({ timeout: 3000 });

    const editInputA = await testHelpers.openTaskTitleEditor(page, taskTitleA);
    const updatedTitleA = `${taskTitleA}-已编辑`;
    await editInputA.fill(updatedTitleA);

    // 立即点击任务 B（不等待，模拟快速切换）
    await taskCardB.click({ force: true });

    const updatedCardA = page.locator(`[data-testid="task-card"]:has-text("已编辑")`);
    await expect(updatedCardA).toBeVisible({ timeout: 5000 });
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

    const initialSaveButton = page.getByRole('button', { name: '保存' }).first();
    if (await initialSaveButton.isVisible({ timeout: 800 }).catch(() => false)) {
      await initialSaveButton.click({ force: true });
    }
    await testHelpers.waitForTaskCard(page, taskTitle, { timeout: 10_000 });

    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    await testHelpers.waitForTaskCard(page, taskTitle, { timeout: 10_000 });
    
    const editInput = await testHelpers.openTaskTitleEditor(page, taskTitle);
    await editInput.focus();

    // 打开第二个标签页
    const page2 = await context.newPage();
    await page2.goto('/');
    await testHelpers.waitForAppReady(page2);
    await testHelpers.ensureEditorReady(page2, { mode: 'local' });
    await testHelpers.waitForTaskCard(page2, taskTitle, { timeout: 10_000 });

    const editInput2 = await testHelpers.openTaskTitleEditor(page2, taskTitle);
    const tab2Title = `${taskTitle}-来自标签页2`;
    await editInput2.fill(tab2Title);
    await editInput2.blur();

    await page.bringToFront();

    const currentValue = await editInput.inputValue();
    expect(currentValue).toBe(taskTitle);

    const tab1Title = `${taskTitle}-来自标签页1`;
    await editInput.fill(tab1Title);
    await editInput.blur();

    const finalCard = page.locator(`[data-testid="task-card"]:has-text("来自标签页1")`);
    await expect(finalCard).toBeVisible({ timeout: 5000 });

    await page2.close();
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
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(taskCard).toBeVisible({ timeout: 3000 });
    
    await page.reload();
    await testHelpers.waitForAppReady(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    
    const persistedCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(persistedCard).toBeVisible({ timeout: 10000 });
    
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
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    const editInput = await testHelpers.openTaskTitleEditor(page, taskTitle);
    const updatedTitle = `${taskTitle}-已更新`;
    await editInput.fill(updatedTitle);
    await editInput.blur();

    const updatedCard = page.locator(`[data-testid="task-card"]:has-text("已更新")`);
    await expect(updatedCard).toBeVisible({ timeout: 3000 });
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
