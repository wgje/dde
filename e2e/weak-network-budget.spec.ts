/**
 * 弱网性能预算门禁测试
 *
 * 【性能优化 2026-02-14】P2-1 治理项
 * 在弱网 + 4xCPU 节流条件下验证性能预算：
 * - LCP < 3,000ms
 * - FCP < 2,000ms
 * - Long Task 总时长 < 3,000ms
 * - 分层请求门禁：
 *   - cold-path: totalDataRequests > 0
 *   - warm-path: 允许 totalDataRequests = 0（记录告警标记）且 startup-window <= 20
 *
 * 此测试用于 CI 回归检测，防止性能退化。
 */

import { test, expect } from '@playwright/test';
import { ensurePerfAuthenticated, getPerfTargetPath } from './perf/authenticated-perf.setup';
import { initPerfMetrics, mergePerfMetrics } from './perf/perf-metrics';
import { waitForAppReady, waitForCountToStabilize } from './shared/page-helpers';

// 弱网性能预算阈值
const BUDGET = {
  /** 最大可接受 LCP（毫秒）— Core Web Vitals "Good" 标准 */
  MAX_LCP_MS: 3_000,
  /** 最大可接受 FCP（毫秒）— Core Web Vitals "Good" 标准 */
  MAX_FCP_MS: 2_000,
  /** 最大可接受 Long Task 总时长（毫秒） */
  MAX_LONG_TASK_TOTAL_MS: 3_000,
  /** 首阶段最大 fetch 请求数 */
  MAX_INITIAL_FETCH_COUNT: 20,
  /** 首屏 black_box_entries 最大请求数 */
  MAX_BLACKBOX_PULLS: 1,
  /** 首屏 get_full_project_data RPC 400 允许数 */
  MAX_RPC_400_COUNT: 0,
  /** 用户未触发前，重型 lazy script chunk 不应下载 */
  MAX_PRE_FLOW_LARGE_CHUNK_COUNT: 0,
  /** 判定为重型 chunk 的最小体积 */
  LARGE_SCRIPT_CHUNK_MIN_BYTES: 600_000,
  /** relaxed 模式下 modulepreload 链接上限 */
  MAX_MODULEPRELOAD_LINKS: 8,
} as const;

test.describe('弱网性能预算门禁', () => {
  test.setTimeout(120_000);

  test.skip(
    !process.env['PERF_BUDGET_TEST'],
    '需要 PERF_BUDGET_TEST=1 环境变量启用（避免日常 CI 运行过慢）'
  );

  test('弱网场景下首屏加载性能在预算内', async ({ page }) => {
    initPerfMetrics();
    const authResult = await ensurePerfAuthenticated(page);

    // 模拟 Slow 3G 网络条件
    const cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send('Network.enable');
    await cdpSession.send('Network.emulateNetworkConditions', {
      offline: false,
      // Slow 3G 模拟参数
      downloadThroughput: (400 * 1024) / 8, // 400 Kbps
      uploadThroughput: (400 * 1024) / 8,
      latency: 400, // 400ms RTT
    });

    // 4x CPU 节流
    await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    // 收集性能数据
    const allResponses: { url: string; status: number; resourceType: string }[] = [];
    page.on('response', (response) => {
      allResponses.push({
        url: response.url(),
        status: response.status(),
        resourceType: response.request().resourceType(),
      });
    });

    // 导航到应用
    await page.goto(getPerfTargetPath(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForAppReady(page, { timeoutMs: 20_000 });
    await waitForCountToStabilize(
      () => allResponses.filter((item) => item.resourceType === 'fetch' || item.resourceType === 'xhr').length,
      { idleMs: 1_500, timeoutMs: 20_000, pollMs: 250 },
    );

    // 收集 LCP
    const lcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          resolve(last?.startTime ?? 0);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        // 兜底：5s 后如果没有 LCP entry，返回 0
        setTimeout(() => resolve(0), 5000);
      });
    });

    // 收集 FCP
    const fcp = await page.evaluate(() => {
      const entries = performance.getEntriesByName('first-contentful-paint', 'paint');
      return entries.length > 0 ? entries[0].startTime : 0;
    });

    // 收集 Long Task
    const longTaskMetrics = await page.evaluate(() => {
      return new Promise<{ count: number; totalDuration: number; maxDuration: number }>((resolve) => {
        let count = 0;
        let totalDuration = 0;
        let maxDuration = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            count++;
            totalDuration += entry.duration;
            maxDuration = Math.max(maxDuration, entry.duration);
          }
        }).observe({ type: 'longtask', buffered: true });
        // 等待额外 2s 收集可能的尾部 Long Task
        setTimeout(() => resolve({ count, totalDuration, maxDuration }), 2000);
      });
    });

    // 统计首阶段 fetch/xhr 请求数（仅数据请求，不包含脚本/样式/字体）
    const startupWindowRequests = allResponses.filter(
      (item) => item.resourceType === 'fetch' || item.resourceType === 'xhr'
    );
    const startupWindowFetchCount = startupWindowRequests.length;
    const totalDataRequests = authResult.authStageDataRequests + startupWindowFetchCount;
    const warmZeroFetch = authResult.pathMode === 'warm' && totalDataRequests === 0;

    // 统计 black_box_entries 请求数
    const blackboxPulls = startupWindowRequests.filter(
      (r) => r.url.includes('black_box_entries')
    ).length;

    // 统计 RPC 400 错误
    const rpc400Count = startupWindowRequests.filter(
      (r) => r.url.includes('rpc/get_full_project_data') && r.status === 400
    ).length;

    const preFlowLargeChunks = await page.evaluate((minBytes: number) => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return resources.filter((entry) => {
        if (entry.initiatorType !== 'script') return false;
        if (!entry.name.includes('/chunk-')) return false;
        const size = entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0;
        return size >= minBytes;
      }).length;
    }, BUDGET.LARGE_SCRIPT_CHUNK_MIN_BYTES);
    const modulepreloadLinks = await page.evaluate(
      () => document.querySelectorAll('link[rel="modulepreload"]').length
    );

    // 断言性能预算
    console.log(
      `[弱网预算] Path=${authResult.pathMode}, LCP: ${lcp}ms, FCP: ${fcp}ms, Long Task: ${longTaskMetrics.totalDuration}ms (${longTaskMetrics.count}次), AuthFetch: ${authResult.authStageDataRequests}, WindowFetch: ${startupWindowFetchCount}, TotalFetch: ${totalDataRequests}, AllResponses: ${allResponses.length}, BlackBox: ${blackboxPulls}, RPC400: ${rpc400Count}, LargeChunks: ${preFlowLargeChunks}, ModulePreload: ${modulepreloadLinks}`
    );
    console.log(
      `[weak-budget] path=${authResult.pathMode} login=${authResult.loginSucceeded ? 1 : 0} authFetch=${authResult.authStageDataRequests} windowFetch=${startupWindowFetchCount} totalFetch=${totalDataRequests} warmZero=${warmZeroFetch ? 1 : 0}`
    );

    mergePerfMetrics({
      'auth.login_success_flag': authResult.loginSucceeded ? 1 : 0,
      'startup.lcp_ms': Number(lcp || 0),
      'startup.fcp_ms': Number(fcp || 0),
      'startup.long_task_total_ms': Number(longTaskMetrics.totalDuration || 0),
      'startup.auth_data_requests': Number(authResult.authStageDataRequests),
      'startup.window_data_requests': Number(startupWindowFetchCount),
      'startup.total_data_requests': Number(totalDataRequests),
      'startup.data_requests': Number(startupWindowFetchCount),
      'startup.warm_zero_fetch_flag': Number(warmZeroFetch ? 1 : 0),
      'startup.blackbox_pulls': Number(blackboxPulls),
      'startup.rpc_400_count': Number(rpc400Count),
      'startup.preflow_large_chunks': Number(preFlowLargeChunks),
      'startup.modulepreload_links': Number(modulepreloadLinks),
    });

    if (lcp > 0) {
      expect(lcp, `LCP 超出弱网预算 (${lcp}ms > ${BUDGET.MAX_LCP_MS}ms)`).toBeLessThanOrEqual(
        BUDGET.MAX_LCP_MS
      );
    }

    if (fcp > 0) {
      expect(fcp, `FCP 超出弱网预算 (${fcp}ms > ${BUDGET.MAX_FCP_MS}ms)`).toBeLessThanOrEqual(
        BUDGET.MAX_FCP_MS
      );
    }

    expect(
      longTaskMetrics.totalDuration,
      `Long Task 总时长超出预算 (${longTaskMetrics.totalDuration}ms > ${BUDGET.MAX_LONG_TASK_TOTAL_MS}ms)`
    ).toBeLessThanOrEqual(BUDGET.MAX_LONG_TASK_TOTAL_MS);

    if (authResult.pathMode === 'cold') {
      expect(
        totalDataRequests,
        `cold-path 总数据请求必须大于 0，当前=${totalDataRequests}`
      ).toBeGreaterThan(0);
    } else if (warmZeroFetch) {
      console.warn('[Weak Budget Guard] warm-path totalDataRequests=0，记录为告警样本');
    }

    expect(
      startupWindowFetchCount,
      `首阶段 fetch 数超出预算 (${startupWindowFetchCount} > ${BUDGET.MAX_INITIAL_FETCH_COUNT})`
    ).toBeLessThanOrEqual(BUDGET.MAX_INITIAL_FETCH_COUNT);

    expect(
      blackboxPulls,
      `black_box_entries 重复拉取 (${blackboxPulls} > ${BUDGET.MAX_BLACKBOX_PULLS})`
    ).toBeLessThanOrEqual(BUDGET.MAX_BLACKBOX_PULLS);

    expect(
      rpc400Count,
      `get_full_project_data RPC 400 错误 (${rpc400Count} > ${BUDGET.MAX_RPC_400_COUNT})`
    ).toBeLessThanOrEqual(BUDGET.MAX_RPC_400_COUNT);

    expect(
      preFlowLargeChunks,
      `用户未触发前加载了重型 lazy chunk (${preFlowLargeChunks} > ${BUDGET.MAX_PRE_FLOW_LARGE_CHUNK_COUNT})`
    ).toBeLessThanOrEqual(BUDGET.MAX_PRE_FLOW_LARGE_CHUNK_COUNT);

    expect(
      modulepreloadLinks,
      `relaxed 模式下 modulepreload 数量超限 (${modulepreloadLinks} > ${BUDGET.MAX_MODULEPRELOAD_LINKS})`
    ).toBeLessThanOrEqual(BUDGET.MAX_MODULEPRELOAD_LINKS);

    // 清理节流
    await cdpSession.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });
    await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
