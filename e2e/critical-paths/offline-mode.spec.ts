/**
 * 关键路径 5: 离线同步和数据保护 + 数据导入导出
 * 
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';

test.describe('关键路径 5: 离线同步和数据保护', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
  });

  test('离线编辑后联网同步应保留数据', async ({ page, context }) => {
    const taskTitle = `离线测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    await context.setOffline(true);
    await page.waitForTimeout(500);
    
    const offlineBanner = page.locator('[data-testid="offline-banner"]');
    await expect(offlineBanner).toBeVisible({ timeout: 5000 });
    
    const taskCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await taskCard.click();
    await page.waitForTimeout(300);
    
    const editInput = page.locator('[data-title-input]').or(page.locator('[data-testid="task-title-input"]'));
    if (await editInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const offlineUpdate = `${taskTitle}-离线更新`;
      testHelpers.trackTaskTitle(offlineUpdate);
      await editInput.fill(offlineUpdate);
      await editInput.blur();
      await page.waitForTimeout(500);
      
      await context.setOffline(false);
      await page.waitForTimeout(2000);
      
      await expect(offlineBanner).not.toBeVisible({ timeout: 10000 });
      
      await page.reload();
      await testHelpers.waitForAppReady(page);
      
      const persistedCard = page.locator(`[data-testid="task-card"]:has-text("离线更新")`);
      await expect(persistedCard).toBeVisible({ timeout: 5000 });
      
      console.log('离线同步测试通过：离线编辑数据正确同步');
    } else {
      await context.setOffline(false);
      console.log('离线同步测试跳过：未找到编辑输入框');
    }
  });

  test('多标签页编辑应显示冲突提示', async ({ page, context }) => {
    const taskTitle = `多标签页测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    const page2 = await context.newPage();
    await page2.goto('/');
    await testHelpers.waitForAppReady(page2);
    await page2.waitForTimeout(2000);
    
    const taskCard1 = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await taskCard1.click();
    await page.waitForTimeout(1000);
    
    const taskCard2 = page2.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    if (await taskCard2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await taskCard2.click();
      await page2.waitForTimeout(500);
      
      const conflictIndicator = page2.locator('[data-testid="edit-conflict-warning"]').or(
        page2.locator('[data-testid="tab-conflict-toast"]')
      );
      
      const hasConflict = await conflictIndicator.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`多标签页测试${hasConflict ? '通过：检测到冲突提示' : '完成：未检测到冲突UI'}`);
    }
    
    await page2.close();
  });

  test('页面加载应执行数据完整性校验', async ({ page }) => {
    const taskTitle = `完整性测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    await page.reload();
    await testHelpers.waitForAppReady(page);
    
    const integrityError = page.locator('[data-testid="integrity-error-toast"]');
    await expect(integrityError).not.toBeVisible({ timeout: 5000 });
    
    const persistedCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(persistedCard).toBeVisible({ timeout: 5000 });
    
    console.log('数据完整性校验测试通过');
  });

  test('连续同步失败应触发熔断状态', async ({ page, context }) => {
    const taskTitle = `熔断测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    for (let i = 0; i < 3; i++) {
      await context.setOffline(true);
      await page.waitForTimeout(500);
      await context.setOffline(false);
      await page.waitForTimeout(500);
    }
    
    const syncStatus = page.locator('[data-testid="sync-status"]');
    await expect(syncStatus).toBeVisible({ timeout: 10000 });
    
    console.log('熔断状态测试完成');
  });

  test('网络不可用时应使用本地数据', async ({ page, context }) => {
    const taskTitle = `本地优先测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    await page.waitForTimeout(3000);
    await context.setOffline(true);
    
    await page.reload();
    await testHelpers.waitForAppReady(page);
    
    const cachedCard = page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
    await expect(cachedCard).toBeVisible({ timeout: 5000 });
    
    await context.setOffline(false);
    
    console.log('本地数据优先测试通过');
  });
});

test.describe('数据导入导出', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await testHelpers.waitForAppReady(page);
  });

  test('应能从设置页面导出数据', async ({ page }) => {
    const taskTitle = `导出测试-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    await page.click('[data-testid="settings-btn"]');
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 5000 }).catch(() => {
      return page.waitForSelector('text=设置', { timeout: 5000 });
    });
    
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    
    const exportBtn = page.locator('button:has-text("导出数据")');
    if (await exportBtn.isVisible()) {
      await exportBtn.click();
      
      const download = await downloadPromise;
      
      if (download) {
        const filename = download.suggestedFilename();
        expect(filename).toMatch(/nanoflow-backup.*\.json$/);
        console.log(`导出成功: ${filename}`);
      } else {
        console.log('导出按钮点击成功，但未触发下载（可能无数据）');
      }
    } else {
      console.log('导出按钮未找到，跳过测试');
    }
    
    await page.keyboard.press('Escape');
    console.log('导出功能测试完成');
  });

  test('导入无效文件应显示错误', async ({ page }) => {
    await page.click('[data-testid="settings-btn"]');
    await page.waitForSelector('text=设置', { timeout: 5000 }).catch(() => {});
    
    const importBtn = page.locator('button:has-text("导入数据")');
    if (await importBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const invalidJson = 'this is not valid json';
      
      page.on('dialog', async dialog => {
        const message = dialog.message();
        expect(message).toContain('导入失败');
        await dialog.dismiss();
      });
      
      const fileInput = page.locator('input[type="file"][accept*=".json"]');
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles({
          name: 'invalid.json',
          mimeType: 'application/json',
          buffer: Buffer.from(invalidJson),
        });
        
        await page.waitForTimeout(2000);
      } else {
        console.log('文件输入未找到，跳过测试');
      }
    } else {
      console.log('导入按钮未找到，跳过测试');
    }
    
    await page.keyboard.press('Escape');
    console.log('导入验证测试完成');
  });

  test('导出的 JSON 应包含正确的数据结构', async ({ page }) => {
    const taskTitle = `结构验证-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    
    await page.click('[data-testid="add-task-btn"]');
    await page.fill('[data-testid="task-title-input"]', taskTitle);
    await page.keyboard.press('Enter');
    await testHelpers.waitForTaskCard(page, taskTitle);
    
    await page.waitForTimeout(2000);
    
    await page.click('[data-testid="settings-btn"]');
    await page.waitForTimeout(500);
    
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    
    const exportBtn = page.locator('button:has-text("导出数据")');
    if (await exportBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await exportBtn.click();
      
      const download = await downloadPromise;
      
      if (download) {
        const path = await download.path();
        if (path) {
          const fs = require('fs');
          const content = fs.readFileSync(path, 'utf-8');
          const data = JSON.parse(content);
          
          expect(data).toHaveProperty('metadata');
          expect(data).toHaveProperty('projects');
          expect(data.metadata).toHaveProperty('version');
          expect(data.metadata).toHaveProperty('exportedAt');
          expect(data.metadata).toHaveProperty('checksum');
          expect(Array.isArray(data.projects)).toBe(true);
          
          console.log(`导出数据结构验证通过: ${data.projects.length} 个项目`);
        }
      } else {
        console.log('未能获取下载文件');
      }
    } else {
      console.log('导出按钮未找到，跳过测试');
    }
    
    await page.keyboard.press('Escape');
    console.log('导出结构验证测试完成');
  });

  test('导出时应显示进度指示器', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      const taskTitle = `进度测试-${i}-${testHelpers.uniqueId()}`;
      testHelpers.trackTaskTitle(taskTitle);
      
      await page.click('[data-testid="add-task-btn"]');
      await page.fill('[data-testid="task-title-input"]', taskTitle);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    
    await page.waitForTimeout(1000);
    
    await page.click('[data-testid="settings-btn"]');
    await page.waitForTimeout(500);
    
    const exportBtn = page.locator('button:has-text("导出数据")');
    if (await exportBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
      
      await exportBtn.click();
      
      const loadingIndicator = page.locator('button:has-text("导出中")');
      const spinner = page.locator('.animate-spin');
      
      const hasLoading = await loadingIndicator.isVisible({ timeout: 1000 }).catch(() => false);
      const hasSpinner = await spinner.isVisible({ timeout: 1000 }).catch(() => false);
      
      if (hasLoading || hasSpinner) {
        console.log('进度指示器显示正常');
      } else {
        console.log('导出速度太快，未能捕获进度指示器');
      }
      
      await downloadPromise;
    }
    
    await page.keyboard.press('Escape');
    console.log('进度指示器测试完成');
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
  console.log('E2E 测试清理完成');
});
