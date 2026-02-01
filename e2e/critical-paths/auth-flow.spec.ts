/**
 * 关键路径 1: 登录 + 数据加载
 * 
 * 从 critical-paths.spec.ts 拆分
 */
import { test, expect } from '@playwright/test';
import { testHelpers } from './helpers';

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
