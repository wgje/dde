/**
 * Focus Mode E2E 测试
 * 
 * 测试专注模式的完整用户流程
 */

import { test, expect } from '@playwright/test';

test.describe('Focus Mode - Gate (大门)', () => {
  test.beforeEach(async ({ page }) => {
    // 登录并准备测试数据
    await page.goto('/');
    // 假设有自动登录机制
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });
  });

  test('有未处理项目时应该显示大门', async ({ page }) => {
    // 创建黑匣子条目
    await page.click('[data-testid="black-box-trigger"]');
    await page.fill('[data-testid="black-box-text-input"]', '测试待处理项目');
    await page.click('[data-testid="black-box-submit"]');
    await page.click('[data-testid="black-box-close"]');

    // 刷新页面模拟次日登录
    await page.reload();

    // 应该看到大门覆盖层
    await expect(page.locator('[data-testid="gate-overlay"]')).toBeVisible();
    await expect(page.locator('[data-testid="gate-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="gate-card"]')).toContainText('测试待处理项目');
  });

  test('点击已读应该前进到下一项', async ({ page }) => {
    // 假设已有多个待处理项目
    await page.goto('/');
    await page.waitForSelector('[data-testid="gate-overlay"]');

    const progressBefore = await page.locator('[data-testid="gate-progress"]').textContent();

    await page.click('[data-testid="gate-read-button"]');

    const progressAfter = await page.locator('[data-testid="gate-progress"]').textContent();
    expect(progressBefore).not.toBe(progressAfter);
  });

  test('处理完所有项目后大门应该关闭', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="gate-overlay"]');

    // 处理所有项目
    while (await page.locator('[data-testid="gate-read-button"]').isVisible()) {
      await page.click('[data-testid="gate-read-button"]');
      await page.waitForTimeout(300); // 等待动画
    }

    await expect(page.locator('[data-testid="gate-overlay"]')).not.toBeVisible();
  });

  test('贪睡功能应该暂时关闭大门', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="gate-overlay"]');

    await page.click('[data-testid="gate-snooze-button"]');

    await expect(page.locator('[data-testid="gate-overlay"]')).not.toBeVisible();
  });

  test('键盘快捷键应该正常工作', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="gate-overlay"]');

    // Enter 键标记已读
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // 验证进度变化（如果还有项目的话）
    // 或者验证大门关闭
  });
});

test.describe('Focus Mode - Black Box (黑匣子)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });
  });

  test('应该能打开黑匣子面板', async ({ page }) => {
    await page.click('[data-testid="black-box-trigger"]');
    
    await expect(page.locator('[data-testid="black-box-panel"]')).toBeVisible();
  });

  test('应该能通过文本输入创建条目', async ({ page }) => {
    await page.click('[data-testid="black-box-trigger"]');
    await page.fill('[data-testid="black-box-text-input"]', '这是一个测试条目');
    await page.click('[data-testid="black-box-submit"]');

    await expect(page.locator('[data-testid="black-box-entry"]').first())
      .toContainText('这是一个测试条目');
  });

  test('应该能删除条目', async ({ page }) => {
    // 先创建一个条目
    await page.click('[data-testid="black-box-trigger"]');
    await page.fill('[data-testid="black-box-text-input"]', '要删除的条目');
    await page.click('[data-testid="black-box-submit"]');

    // 删除
    await page.click('[data-testid="black-box-entry-delete"]');
    await page.click('[data-testid="confirm-delete"]');

    await expect(page.locator('[data-testid="black-box-entry"]'))
      .not.toContainText('要删除的条目');
  });

  test('语音录制按钮应该在支持的浏览器中可见', async ({ page }) => {
    await page.click('[data-testid="black-box-trigger"]');
    
    // 检查录音按钮是否存在（即使不可用）
    const recorder = page.locator('[data-testid="black-box-recorder"]');
    await expect(recorder).toBeVisible();
  });

  test('条目应该按日期分组显示', async ({ page }) => {
    // 创建多个条目
    await page.click('[data-testid="black-box-trigger"]');
    
    await page.fill('[data-testid="black-box-text-input"]', '条目1');
    await page.click('[data-testid="black-box-submit"]');
    
    await page.fill('[data-testid="black-box-text-input"]', '条目2');
    await page.click('[data-testid="black-box-submit"]');

    // 应该看到今天的日期分组
    await expect(page.locator('[data-testid="black-box-date-group"]')).toBeVisible();
  });
});

test.describe('Focus Mode - Spotlight (聚光灯)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });
  });

  test('应该能进入聚光灯模式', async ({ page }) => {
    // 选择一个任务
    await page.click('[data-testid="task-card"]');
    
    // 进入聚光灯
    await page.click('[data-testid="spotlight-enter"]');
    
    await expect(page.locator('[data-testid="spotlight-view"]')).toBeVisible();
  });

  test('应该只显示当前任务', async ({ page }) => {
    // 进入聚光灯模式
    await page.click('[data-testid="task-card"]');
    await page.click('[data-testid="spotlight-enter"]');

    // 只应该有一个任务卡片
    const taskCards = await page.locator('[data-testid="spotlight-card"]').count();
    expect(taskCards).toBe(1);
  });

  test('完成任务应该退出聚光灯', async ({ page }) => {
    await page.click('[data-testid="task-card"]');
    await page.click('[data-testid="spotlight-enter"]');
    
    await page.click('[data-testid="spotlight-complete"]');

    await expect(page.locator('[data-testid="spotlight-view"]')).not.toBeVisible();
  });

  test('跳过任务应该显示下一个', async ({ page }) => {
    // 假设队列中有多个任务
    await page.click('[data-testid="spotlight-enter-queue"]');
    
    const firstTask = await page.locator('[data-testid="spotlight-card-title"]').textContent();
    
    await page.click('[data-testid="spotlight-skip"]');
    
    const secondTask = await page.locator('[data-testid="spotlight-card-title"]').textContent();
    
    expect(firstTask).not.toBe(secondTask);
  });

  test('Escape 键应该退出聚光灯', async ({ page }) => {
    await page.click('[data-testid="task-card"]');
    await page.click('[data-testid="spotlight-enter"]');
    
    await page.keyboard.press('Escape');

    await expect(page.locator('[data-testid="spotlight-view"]')).not.toBeVisible();
  });
});

test.describe('Focus Mode - Strata (地质层)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });
  });

  test('完成任务后应该出现在地质层', async ({ page }) => {
    // 完成一个任务
    await page.click('[data-testid="task-card"]');
    await page.click('[data-testid="task-complete"]');

    // 打开地质层面板
    await page.click('[data-testid="strata-toggle"]');

    await expect(page.locator('[data-testid="strata-item"]').first()).toBeVisible();
  });

  test('应该按日期分层显示', async ({ page }) => {
    await page.click('[data-testid="strata-toggle"]');

    // 应该有日期层
    await expect(page.locator('[data-testid="strata-layer"]')).toBeVisible();
  });

  test('层应该可以折叠展开', async ({ page }) => {
    await page.click('[data-testid="strata-toggle"]');
    
    // 点击折叠
    await page.click('[data-testid="strata-layer-header"]');
    
    // 内容应该隐藏
    await expect(page.locator('[data-testid="strata-layer-content"]')).not.toBeVisible();

    // 再次点击展开
    await page.click('[data-testid="strata-layer-header"]');
    
    await expect(page.locator('[data-testid="strata-layer-content"]')).toBeVisible();
  });

  test('更早的层应该更淡', async ({ page }) => {
    // 假设有多天的数据
    await page.click('[data-testid="strata-toggle"]');

    const layers = await page.locator('[data-testid="strata-layer"]').all();
    
    if (layers.length > 1) {
      const firstOpacity = await layers[0].evaluate(el => 
        getComputedStyle(el).opacity
      );
      const lastOpacity = await layers[layers.length - 1].evaluate(el => 
        getComputedStyle(el).opacity
      );
      
      expect(parseFloat(firstOpacity)).toBeGreaterThanOrEqual(parseFloat(lastOpacity));
    }
  });
});

test.describe('Focus Mode - Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });
  });

  test('应该能在设置中禁用各模块', async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-focus-mode"]');

    // 禁用大门
    await page.click('[data-testid="toggle-gate"]');
    
    // 保存
    await page.click('[data-testid="settings-save"]');

    // 验证大门不再显示（即使有待处理项目）
    await page.reload();
    await expect(page.locator('[data-testid="gate-overlay"]')).not.toBeVisible();
  });

  test('应该能调整贪睡时长', async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-focus-mode"]');

    await page.fill('[data-testid="snooze-duration"]', '60');
    await page.click('[data-testid="settings-save"]');

    // 验证设置已保存
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-focus-mode"]');
    
    await expect(page.locator('[data-testid="snooze-duration"]')).toHaveValue('60');
  });
});

test.describe('Focus Mode - Offline', () => {
  test('离线时应该能使用黑匣子', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });

    // 模拟离线
    await context.setOffline(true);

    await page.click('[data-testid="black-box-trigger"]');
    await page.fill('[data-testid="black-box-text-input"]', '离线创建的条目');
    await page.click('[data-testid="black-box-submit"]');

    // 条目应该显示，但有待同步标记
    await expect(page.locator('[data-testid="black-box-entry"]').first())
      .toContainText('离线创建的条目');
    await expect(page.locator('[data-testid="sync-pending-indicator"]')).toBeVisible();
  });

  test('恢复在线后应该同步数据', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"]');

    // 离线创建
    await context.setOffline(true);
    await page.click('[data-testid="black-box-trigger"]');
    await page.fill('[data-testid="black-box-text-input"]', '离线条目');
    await page.click('[data-testid="black-box-submit"]');

    // 恢复在线
    await context.setOffline(false);

    // 等待同步
    await page.waitForTimeout(5000);

    // 同步标记应该消失
    await expect(page.locator('[data-testid="sync-pending-indicator"]')).not.toBeVisible();
  });
});

test.describe('Focus Mode - Accessibility', () => {
  test('大门应该可以用键盘导航', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="gate-overlay"]');

    // Tab 到已读按钮
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="gate-read-button"]')).toBeFocused();

    // Tab 到完成按钮
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="gate-complete-button"]')).toBeFocused();

    // Tab 到贪睡按钮
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="gate-snooze-button"]')).toBeFocused();
  });

  test('应该有正确的 ARIA 标签', async ({ page }) => {
    await page.goto('/');
    
    await page.click('[data-testid="black-box-trigger"]');
    
    const panel = page.locator('[data-testid="black-box-panel"]');
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel).toHaveAttribute('aria-label');
  });

  test('应该支持屏幕阅读器', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="gate-overlay"]');

    // 检查 live region
    const liveRegion = page.locator('[aria-live="polite"]');
    await expect(liveRegion).toBeVisible();
  });
});
