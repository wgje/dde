import { test, expect } from '@playwright/test';
import { ensurePerfAuthenticated, getPerfTargetPath } from './authenticated-perf.setup';

const PERF_GUARD = {
  MAX_INITIAL_DATA_FETCH: 20,
  MAX_BLACKBOX_PULLS_IN_10S: 1,
  MAX_RPC_400_COUNT: 0,
  LARGE_SCRIPT_CHUNK_MIN_BYTES: 600_000,
  MAX_MODULEPRELOAD_LINKS: 0,
} as const;

test.describe('Weak Network Startup Guard', () => {
  test.setTimeout(120_000);

  test.skip(
    !process.env['PERF_BUDGET_TEST'],
    '需要 PERF_BUDGET_TEST=1 启用弱网启动门禁测试'
  );

  test('startup should avoid redundant requests before flow intent', async ({ page }) => {
    await ensurePerfAuthenticated(page);

    const cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send('Network.enable');
    await cdpSession.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
      latency: 400,
    });
    await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    const responses: Array<{ url: string; status: number; resourceType: string }> = [];
    page.on('response', (response) => {
      responses.push({
        url: response.url(),
        status: response.status(),
        resourceType: response.request().resourceType(),
      });
    });

    await page.goto(getPerfTargetPath(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(10_000);

    const dataRequests = responses.filter(
      (item) => item.resourceType === 'fetch' || item.resourceType === 'xhr'
    );
    const blackBoxPulls = dataRequests.filter((item) => item.url.includes('black_box_entries')).length;
    const rpc400Count = dataRequests.filter(
      (item) => item.url.includes('rpc/get_full_project_data') && item.status === 400
    ).length;
    const preFlowLargeChunks = await page.evaluate((minBytes: number) => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return resources.filter((entry) => {
        if (entry.initiatorType !== 'script') return false;
        if (!entry.name.includes('/chunk-')) return false;
        const size = entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0;
        return size >= minBytes;
      }).length;
    }, PERF_GUARD.LARGE_SCRIPT_CHUNK_MIN_BYTES);
    const modulepreloadLinks = await page.evaluate(
      () => document.querySelectorAll('link[rel=\"modulepreload\"]').length
    );

    expect(
      dataRequests.length,
      `认证态首阶段数据请求必须大于 0，当前=${dataRequests.length}`
    ).toBeGreaterThan(0);

    expect(
      dataRequests.length,
      `认证态首阶段数据请求超限: ${dataRequests.length} > ${PERF_GUARD.MAX_INITIAL_DATA_FETCH}`
    ).toBeLessThanOrEqual(PERF_GUARD.MAX_INITIAL_DATA_FETCH);

    expect(
      blackBoxPulls,
      `black_box_entries 请求次数超限: ${blackBoxPulls}`
    ).toBeLessThanOrEqual(PERF_GUARD.MAX_BLACKBOX_PULLS_IN_10S);

    expect(
      rpc400Count,
      `get_full_project_data 出现 400: ${rpc400Count}`
    ).toBeLessThanOrEqual(PERF_GUARD.MAX_RPC_400_COUNT);

    expect(
      preFlowLargeChunks,
      `Flow/重型 lazy chunk 在用户未触发前被下载: ${preFlowLargeChunks}`
    ).toBe(0);

    expect(
      modulepreloadLinks,
      `strict 模式下 modulepreload 链接数量超限: ${modulepreloadLinks}`
    ).toBeLessThanOrEqual(PERF_GUARD.MAX_MODULEPRELOAD_LINKS);

    await cdpSession.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });
    await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
