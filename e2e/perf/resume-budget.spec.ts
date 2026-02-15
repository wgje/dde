import { test, expect } from '@playwright/test';
import { ensurePerfAuthenticated, getPerfTargetPath } from './authenticated-perf.setup';
import { mergePerfMetrics } from './perf-metrics';

const RESUME_BUDGET = {
  MAX_INTERACTION_READY_MS: 150,
  MAX_BACKGROUND_REFRESH_MS: 10_000,
  MAX_HEAVY_EVENT_COUNT: 1,
} as const;

test.describe('Resume Budget Guard', () => {
  test.setTimeout(120_000);

  test.skip(
    !process.env['PERF_BUDGET_TEST'],
    '需要 PERF_BUDGET_TEST=1 启用恢复预算门禁测试'
  );

  test('heavy resume should remain interaction-first and finish background refresh within SLA', async ({ page }) => {
    await ensurePerfAuthenticated(page);

    await page.goto(getPerfTargetPath(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      const scope = window as Window & {
        __NANOFLOW_RESUME_METRICS__?: Array<{
          ticketId?: string;
          reason?: string;
          interactionReadyMs?: number;
          backgroundRefreshMs?: number;
          fastPathHit?: boolean;
        }>;
      };
      scope.__NANOFLOW_RESUME_METRICS__ = [];
      window.addEventListener('nanoflow:resume-metrics', (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
        scope.__NANOFLOW_RESUME_METRICS__?.push({
          ticketId: typeof detail['ticketId'] === 'string' ? detail['ticketId'] : undefined,
          reason: typeof detail['reason'] === 'string' ? detail['reason'] : undefined,
          interactionReadyMs: typeof detail['interactionReadyMs'] === 'number' ? detail['interactionReadyMs'] : undefined,
          backgroundRefreshMs: typeof detail['backgroundRefreshMs'] === 'number' ? detail['backgroundRefreshMs'] : undefined,
          fastPathHit: typeof detail['fastPathHit'] === 'boolean' ? detail['fastPathHit'] : undefined,
        });
      }, { once: false });
    });

    await page.evaluate(() => {
      const pageshow = new Event('pageshow') as PageTransitionEvent;
      Object.defineProperty(pageshow, 'persisted', { value: true });
      window.dispatchEvent(pageshow);
      // 连续触发 online，验证只执行一次 heavy 补偿
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });

    await page.waitForFunction(() => {
      const scope = window as Window & {
        __NANOFLOW_RESUME_METRICS__?: Array<{ backgroundRefreshMs?: number }>;
      };
      const records = scope.__NANOFLOW_RESUME_METRICS__ || [];
      return records.some((record) => typeof record.backgroundRefreshMs === 'number');
    }, undefined, { timeout: 20_000 });

    const result = await page.evaluate(() => {
      const scope = window as Window & {
        __NANOFLOW_RESUME_METRICS__?: Array<{
          ticketId?: string;
          reason?: string;
          interactionReadyMs?: number;
          backgroundRefreshMs?: number;
          fastPathHit?: boolean;
        }>;
      };
      const records = scope.__NANOFLOW_RESUME_METRICS__ || [];
      const heavyRecords = records.filter((record) => typeof record.backgroundRefreshMs === 'number');
      const latest = records[records.length - 1] || null;
      const heavyTicketCount = new Set(
        heavyRecords
          .map((record) => record.ticketId)
          .filter((ticketId): ticketId is string => typeof ticketId === 'string')
      ).size;

      return {
        latest,
        heavyRecordCount: heavyRecords.length,
        heavyTicketCount,
      };
    });

    const interactionReadyMs = Number(result.latest?.interactionReadyMs ?? 0);
    const backgroundRefreshMs = Number(result.latest?.backgroundRefreshMs ?? 0);

    mergePerfMetrics({
      'resume.interaction_ready_ms': interactionReadyMs,
      'resume.background_refresh_ms': backgroundRefreshMs,
    });

    expect(
      result.heavyRecordCount,
      `恢复窗口 heavy 指标事件次数超限: ${result.heavyRecordCount}`
    ).toBeLessThanOrEqual(RESUME_BUDGET.MAX_HEAVY_EVENT_COUNT);

    expect(
      result.heavyTicketCount,
      `恢复窗口出现多个 heavy ticket: ${result.heavyTicketCount}`
    ).toBeLessThanOrEqual(RESUME_BUDGET.MAX_HEAVY_EVENT_COUNT);

    expect(
      interactionReadyMs,
      `resume.interaction_ready_ms 超预算 (${interactionReadyMs}ms > ${RESUME_BUDGET.MAX_INTERACTION_READY_MS}ms)`
    ).toBeLessThanOrEqual(RESUME_BUDGET.MAX_INTERACTION_READY_MS);
    expect(
      interactionReadyMs,
      'resume.interaction_ready_ms 必须大于 0（防止假通过）'
    ).toBeGreaterThan(0);

    expect(
      backgroundRefreshMs,
      `resume.background_refresh_ms 超预算 (${backgroundRefreshMs}ms > ${RESUME_BUDGET.MAX_BACKGROUND_REFRESH_MS}ms)`
    ).toBeLessThanOrEqual(RESUME_BUDGET.MAX_BACKGROUND_REFRESH_MS);
    expect(
      backgroundRefreshMs,
      'resume.background_refresh_ms 必须大于 0（防止假通过）'
    ).toBeGreaterThan(0);
  });
});
