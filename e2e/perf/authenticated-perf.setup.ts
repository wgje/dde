import { expect, Page } from '@playwright/test';

interface PerfAuthConfig {
  email: string;
  password: string;
  projectId?: string;
}

function readPerfAuthConfig(): PerfAuthConfig {
  const email = process.env['E2E_PERF_EMAIL']?.trim();
  const password = process.env['E2E_PERF_PASSWORD']?.trim();
  const projectId = process.env['E2E_PERF_PROJECT_ID']?.trim();

  if (!email || !password) {
    throw new Error(
      '缺少认证态弱网测试凭据：请设置 E2E_PERF_EMAIL 与 E2E_PERF_PASSWORD'
    );
  }

  return { email, password, projectId: projectId || undefined };
}

export function getPerfTargetPath(): string {
  const { projectId } = readPerfAuthConfig();
  return projectId ? `/#/projects/${projectId}` : '/#/projects';
}

async function ensureLoginModalVisible(page: Page): Promise<void> {
  const loginModal = page.locator('[data-testid="login-modal"]');
  if (await loginModal.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  const loginButton = page.locator('[data-testid="login-btn"]');
  if (await loginButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await loginButton.click();
  }

  await page.waitForSelector('[data-testid="login-modal"]', { timeout: 10000 });
}

/**
 * 确保页面处于已登录状态（用于认证态弱网预算测试）。
 */
export async function ensurePerfAuthenticated(page: Page): Promise<void> {
  const { email, password } = readPerfAuthConfig();

  await page.goto('/#/projects', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const userMenu = page.locator('[data-testid="user-menu"]');
  if (await userMenu.isVisible({ timeout: 1500 }).catch(() => false)) {
    return;
  }

  await ensureLoginModalVisible(page);
  await page.fill('[data-testid="email-input"]', email);
  await page.fill('[data-testid="password-input"]', password);
  await page.click('[data-testid="submit-login"]');

  await expect(page.locator('[data-testid="login-modal"]')).not.toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/#\/projects/);
}
