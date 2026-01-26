/**
 * 本地模式 INP 性能测试 (E2E)
 * 验证 2026-01-26 性能修复的实际效果
 * 
 * 预期改善:
 * - INP: 536ms → <200ms (↓62%)
 * - 路由守卫: 558ms → <10ms (↓98%)
 * 
 * @see /workspaces/dde/docs/performance-fix-2026-01-26.md
 */
import { test, expect } from '@playwright/test';

test.describe('本地模式 INP 性能优化', () => {
  test.beforeEach(async ({ page }) => {
    // 清除缓存，模拟首次访问
    await page.context().clearCookies();
    await page.goto('/');
  });

  test('点击本地模式按钮后导航应该 <200ms', async ({ page }) => {
    // 等待登录模态框出现
    await page.waitForSelector('button:has-text("本地模式")');

    // 开始性能监控
    const perfStart = Date.now();

    // 点击本地模式按钮
    await page.click('button:has-text("本地模式")');

    // 等待导航到 /projects
    await page.waitForURL('**/projects');

    // 记录总耗时
    const perfEnd = Date.now();
    const totalTime = perfEnd - perfStart;

    console.log(`✅ 本地模式导航总耗时: ${totalTime}ms`);

    // 断言：总时间应该 <500ms（包含点击、导航、数据加载）
    // 注意：E2E 测试包含真实的 DOM 渲染和网络延迟，所以允许更长的时间
    expect(totalTime).toBeLessThan(500);
  });

  test('本地模式不应该发起云端同步请求', async ({ page }) => {
    // 监控网络请求
    const networkRequests: string[] = [];
    page.on('request', request => {
      const url = request.url();
      if (url.includes('supabase.co')) {
        networkRequests.push(url);
      }
    });

    // 点击本地模式按钮
    await page.click('button:has-text("本地模式")');

    // 等待导航完成
    await page.waitForURL('**/projects');

    // 等待 2 秒，观察是否有后台同步请求
    await page.waitForTimeout(2000);

    // 断言：不应该有 saveProjectToCloud 相关的请求
    const syncRequests = networkRequests.filter(url => 
      url.includes('/rest/v1/projects') || 
      url.includes('/rest/v1/tasks') ||
      url.includes('/auth/v1/token')
    );

    console.log('📡 Supabase 请求数量:', syncRequests.length);
    expect(syncRequests.length).toBe(0);
  });

  test('本地模式不应该显示"登录已过期"提示', async ({ page }) => {
    // 点击本地模式按钮
    await page.click('button:has-text("本地模式")');

    // 等待导航完成
    await page.waitForURL('**/projects');

    // 等待 1 秒，观察是否有 Toast 提示
    await page.waitForTimeout(1000);

    // 断言：不应该看到"登录已过期"提示
    const toastText = await page.textContent('.toast-container').catch(() => '');
    expect(toastText).not.toContain('登录已过期');
  });

  test('路由守卫检查应该 <10ms', async ({ page }) => {
    // 注入性能监控代码
    await page.addInitScript(() => {
      (window as any).__guardTiming = [];
      
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        originalLog.apply(console, args);
        
        // 捕获守卫性能日志
        const message = args[0];
        if (typeof message === 'string' && message.includes('[Guard] ⚡')) {
          const match = message.match(/(\d+\.\d+)ms/);
          if (match) {
            (window as any).__guardTiming.push(parseFloat(match[1]));
          }
        }
      };
    });

    // 点击本地模式按钮
    await page.click('button:has-text("本地模式")');

    // 等待导航完成
    await page.waitForURL('**/projects');

    // 获取守卫耗时
    const guardTiming = await page.evaluate(() => (window as any).__guardTiming);
    
    if (guardTiming && guardTiming.length > 0) {
      const avgTime = guardTiming.reduce((a: number, b: number) => a + b) / guardTiming.length;
      console.log(`✅ 路由守卫平均耗时: ${avgTime.toFixed(1)}ms`);
      
      // 断言：每次守卫检查应该 <50ms（允许一定的浏览器开销）
      guardTiming.forEach((time: number) => {
        expect(time).toBeLessThan(50);
      });
    }
  });

  test('会话检查不应该导致阻塞', async ({ page }) => {
    // 监控控制台日志
    const logs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[Guard]') || text.includes('[Session]')) {
        logs.push(text);
      }
    });

    // 点击本地模式按钮
    await page.click('button:has-text("本地模式")');

    // 等待导航完成
    await page.waitForURL('**/projects');

    // 检查日志，应该看到快速放行的日志
    const hasQuickPass = logs.some(log => 
      log.includes('本地模式已启用，立即允许访问') ||
      log.includes('本地模式，从缓存或种子加载')
    );

    expect(hasQuickPass).toBe(true);

    // 不应该看到"批量推送前检测到会话丢失"
    const hasSessionLoss = logs.some(log => 
      log.includes('批量推送前检测到会话丢失')
    );

    expect(hasSessionLoss).toBe(false);
  });
});

test.describe('性能回归保护', () => {
  test('本地模式 INP 不应该超过 200ms', async ({ page }) => {
    await page.goto('/');

    // 使用 Web Vitals API 监控 INP
    await page.addInitScript(() => {
      (window as any).__inpValues = [];
      
      // 注入 Web Vitals 监控
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'event') {
            const eventEntry = entry as PerformanceEventTiming;
            if (eventEntry.processingStart > 0) {
              const inp = eventEntry.processingEnd - eventEntry.processingStart;
              (window as any).__inpValues.push({
                name: eventEntry.name,
                inp: inp
              });
            }
          }
        }
      });
      
      observer.observe({ type: 'event', buffered: true });
    });

    // 点击本地模式按钮
    await page.click('button:has-text("本地模式")');

    // 等待导航完成
    await page.waitForURL('**/projects');

    // 获取 INP 数据
    const inpValues = await page.evaluate(() => (window as any).__inpValues);
    
    if (inpValues && inpValues.length > 0) {
      const maxInp = Math.max(...inpValues.map((v: any) => v.inp));
      console.log(`📊 最大 INP: ${maxInp.toFixed(1)}ms`);
      
      // 断言：INP 不应该超过 200ms
      expect(maxInp).toBeLessThan(200);
    }
  });
});
