/**
 * 关键路径 1: 登录 + 数据加载
 * 
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect } from '@playwright/test';
import { getTestEnvConfig, testHelpers } from './helpers';
import { ensureLoginModalVisible } from '../shared/auth-helpers';

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
    
    // 打开登录对话框（Guard 场景下可能已自动弹出）
    await ensureLoginModalVisible(page);
    
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
    const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
    if (!TEST_USER_EMAIL || !TEST_USER_PASSWORD) {
      test.skip(true, '跳过：未配置测试账户');
      return;
    }

    await testHelpers.ensureCloudAuthenticated(page);
    await expect(page).toHaveURL(/#\/projects(?:$|[/?])/);
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="sync-status"]')).toBeVisible();
  });
});
