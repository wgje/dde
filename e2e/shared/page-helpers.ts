import { expect, Page } from '@playwright/test';

interface WaitForAppReadyOptions {
  timeoutMs?: number;
}

interface WaitForStableCountOptions {
  idleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitForAppReady(
  page: Page,
  options?: WaitForAppReadyOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  await page.locator('[data-testid="app-container"]').waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });

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

  await expect
    .poll(() => {
      const currentCount = readCount();

      if (currentCount !== lastCount) {
        lastCount = currentCount;
        stableSince = Date.now();
        return false;
      }

      return Date.now() - stableSince >= idleMs;
    }, {
      timeout: timeoutMs,
      intervals: [pollMs],
      message: `计数在 ${timeoutMs}ms 内未稳定，最后一次观测值为 ${lastCount}`,
    })
    .toBe(true);

  return lastCount;
}