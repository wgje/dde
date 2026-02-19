import { Page } from '@playwright/test';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginOptions {
  projectsPath?: string;
  maxAttempts?: number;
  navigationTimeoutMs?: number;
  modalTimeoutMs?: number;
  submitTimeoutMs?: number;
  retryDelayMs?: number;
}

export type AuthPathMode = 'warm' | 'cold';

export interface AuthEnsureResult {
  pathMode: AuthPathMode;
  loginAttempted: boolean;
  loginSucceeded: boolean;
  attemptCount: number;
  lastError?: string;
}

const DEFAULT_OPTIONS: Required<LoginOptions> = {
  projectsPath: '/#/projects',
  maxAttempts: 2,
  navigationTimeoutMs: 60_000,
  modalTimeoutMs: 10_000,
  submitTimeoutMs: 15_000,
  retryDelayMs: 500,
};

async function isVisible(
  page: Page,
  selector: string,
  timeoutMs: number
): Promise<boolean> {
  return page.locator(selector).isVisible({ timeout: timeoutMs }).catch(() => false);
}

export async function ensureLoginModalVisible(
  page: Page,
  modalTimeoutMs = DEFAULT_OPTIONS.modalTimeoutMs
): Promise<void> {
  if (await isVisible(page, '[data-testid="login-modal"]', 800)) {
    return;
  }

  if (await isVisible(page, '[data-testid="login-btn"]', 2000)) {
    await page.click('[data-testid="login-btn"]');
  } else if (await isVisible(page, 'button:has-text("登录账号")', 2000)) {
    await page.click('button:has-text("登录账号")');
  }

  await page.locator('[data-testid="login-modal"]').waitFor({
    state: 'visible',
    timeout: modalTimeoutMs,
  });
}

async function waitForLoginSucceeded(page: Page, timeoutMs: number): Promise<boolean> {
  const loginModal = page.locator('[data-testid="login-modal"]');
  const hidden = await loginModal
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!hidden) {
    return false;
  }

  return isVisible(page, '[data-testid="user-menu"]', 2000);
}

async function readAuthError(page: Page): Promise<string | undefined> {
  const authError = page.locator('[data-testid="auth-error"]');
  if (!(await authError.isVisible({ timeout: 600 }).catch(() => false))) {
    return undefined;
  }
  const text = (await authError.textContent())?.trim();
  return text || undefined;
}

export async function submitLoginWithRetry(
  page: Page,
  credentials: LoginCredentials,
  options?: LoginOptions
): Promise<{ loginSucceeded: boolean; attemptCount: number; lastError?: string }> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  let attemptCount = 0;
  let lastError: string | undefined;

  await ensureLoginModalVisible(page, resolved.modalTimeoutMs);

  while (attemptCount < resolved.maxAttempts) {
    attemptCount += 1;
    await page.fill('[data-testid="email-input"]', credentials.email);
    await page.fill('[data-testid="password-input"]', credentials.password);
    await page.click('[data-testid="submit-login"]');

    const success = await waitForLoginSucceeded(page, resolved.submitTimeoutMs);
    if (success) {
      return { loginSucceeded: true, attemptCount };
    }

    lastError = (await readAuthError(page)) ?? `登录超时（第 ${attemptCount} 次）`;
    if (attemptCount < resolved.maxAttempts) {
      await page.waitForTimeout(resolved.retryDelayMs);
      await ensureLoginModalVisible(page, resolved.modalTimeoutMs);
    }
  }

  return { loginSucceeded: false, attemptCount, lastError };
}

export async function ensureAuthenticated(
  page: Page,
  credentials: LoginCredentials,
  options?: LoginOptions
): Promise<AuthEnsureResult> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  await page.goto(resolved.projectsPath, {
    waitUntil: 'domcontentloaded',
    timeout: resolved.navigationTimeoutMs,
  });

  if (await isVisible(page, '[data-testid="user-menu"]', 1500)) {
    return {
      pathMode: 'warm',
      loginAttempted: false,
      loginSucceeded: true,
      attemptCount: 0,
    };
  }

  const loginResult = await submitLoginWithRetry(page, credentials, resolved);
  if (!loginResult.loginSucceeded) {
    throw new Error(
      `登录失败（尝试 ${loginResult.attemptCount} 次）：${loginResult.lastError ?? '未知错误'}`
    );
  }

  return {
    pathMode: 'cold',
    loginAttempted: true,
    loginSucceeded: true,
    attemptCount: loginResult.attemptCount,
  };
}
