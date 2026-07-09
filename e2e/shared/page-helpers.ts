import { expect, Page } from '@playwright/test';

interface WaitForAppReadyOptions {
  timeoutMs?: number;
  recoverStaticLoader?: boolean;
}

interface WaitForStableCountOptions {
  idleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

const APP_READY_SELECTORS = [
  '[data-testid="app-container"]',
  '[data-testid="project-shell-main-content"]',
  '[data-testid="project-selector"]',
  '[data-testid="login-modal"]',
];

async function hasVisibleStaticStartupLoader(page: Page): Promise<boolean> {
  return page.locator('#initial-loader')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    })
    .catch(() => false);
}

async function findReadySelector(page: Page): Promise<string | null> {
  if (await hasVisibleStaticStartupLoader(page)) {
    return null;
  }

  for (const selector of APP_READY_SELECTORS) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return selector;
    }
  }

  return null;
}

async function waitForReadySelector(page: Page, timeoutMs: number): Promise<string | null> {
  let readySelector: string | null = null;
  await expect
    .poll(async () => {
      readySelector = await findReadySelector(page);
      return readySelector;
    }, {
      timeout: timeoutMs,
      intervals: [100, 200, 300, 500],
    })
    .not.toBeNull();

  return readySelector;
}

async function recoverStaticStartupLoader(page: Page): Promise<boolean> {
  const staticLoaderVisible = await page.getByText('加载时间较长，可能是网络问题')
    .first()
    .isVisible()
    .catch(() => false);
  const timeoutLoaderVisible = await page.getByText('加载超时')
    .first()
    .isVisible()
    .catch(() => false);

  if (!staticLoaderVisible && !timeoutLoaderVisible && !(await hasVisibleStaticStartupLoader(page))) {
    return false;
  }

  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return true;
}

export async function waitForAppReady(
  page: Page,
  options?: WaitForAppReadyOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const firstAttemptTimeoutMs = Math.min(timeoutMs, 15_000);
  let readySelector = await waitForReadySelector(page, firstAttemptTimeoutMs).catch(() => null);

  if (!readySelector && options?.recoverStaticLoader && await recoverStaticStartupLoader(page)) {
    readySelector = await waitForReadySelector(page, timeoutMs).catch(() => null);
  }

  expect(readySelector, '应用未在超时内挂载到可交互界面').not.toBeNull();

  // 先等待主要脚本执行完毕，再观察 loading-indicator 是否迟到挂载。
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  // 等待 loading-indicator 消失（如果存在）；同时给迟到挂载一个短观察窗口，避免过早放行。
  const loadingIndicator = page.locator('[data-testid="loading-indicator"]');
  const observeTimeoutMs = Math.min(timeoutMs, 2_000);
  const observePollMs = 60;
  let sawLoadingIndicator = false;
  let idleSince = Date.now();

  await expect
    .poll(async () => {
      const loadingVisible = await loadingIndicator.isVisible().catch(() => false);

      if (loadingVisible) {
        sawLoadingIndicator = true;
        idleSince = Date.now();
        return false;
      }

      const settleWindowMs = sawLoadingIndicator ? 120 : 180;
      return Date.now() - idleSince >= settleWindowMs;
    }, {
      timeout: observeTimeoutMs,
      intervals: [observePollMs],
    })
    .toBe(true);

  if (sawLoadingIndicator) {
    await expect(loadingIndicator).toBeHidden({ timeout: Math.max(500, timeoutMs / 2) });
  }
}

export async function waitForCountToStabilize(
  readCount: () => number,
  options?: WaitForStableCountOptions,
): Promise<number> {
  const idleMs = options?.idleMs ?? 1_500;
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const pollMs = options?.pollMs ?? 200;

  let lastCount = readCount();
  let stableSince = Date.now();
  const deadline = stableSince + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const now = Date.now();
    const currentCount = readCount();

    if (currentCount !== lastCount) {
      lastCount = currentCount;
      stableSince = now;
      continue;
    }

    if (now - stableSince >= idleMs) {
      return lastCount;
    }
  }

  throw new Error(`计数在 ${timeoutMs}ms 内未稳定，最后一次观测值为 ${lastCount}`);
}
