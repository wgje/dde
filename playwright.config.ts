import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置文件
 * 用于 NanoFlow 项目的 E2E 测试
 */
const baseURL = process.env['PLAYWRIGHT_BASE_URL'] || 'http://localhost:3000';
// E2E 默认使用专用起服脚本，避免嵌套 npm run 在 Playwright webServer 管理下提前退出。
const webServerCommand = process.env['PLAYWRIGHT_WEB_SERVER_COMMAND'] || 'npm run start:e2e';
// Angular dev server 首次编译耗时较长，默认给 8 分钟防止超时
const webServerTimeout = Number(process.env['PLAYWRIGHT_WEB_SERVER_TIMEOUT'] || 480_000);
const configuredWorkers = Number.parseInt(process.env['PLAYWRIGHT_WORKERS'] || '', 10);
const resolvedWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
  ? configuredWorkers
  : process.env['CI']
    ? 1
    : undefined;
const includePerfSuites = process.env['PLAYWRIGHT_INCLUDE_PERF'] === '1' || process.env['PERF_BUDGET_TEST'] === '1';

export default defineConfig({
  testDir: './e2e',
  testIgnore: includePerfSuites ? [] : ['e2e/perf/**', 'e2e/weak-network-budget.spec.ts'],
  /* 每个测试的超时时间 */
  timeout: 60 * 1000,
  /* 测试期望的超时时间 */
  expect: {
    timeout: 10000
  },
  /* 完整运行失败时不重试 */
  fullyParallel: true,
  /* CI 环境下失败不重试 */
  forbidOnly: !!process.env['CI'],
  /* 重试机制：本地 1 次，CI 2 次，降低环境抖动导致的误报 */
  retries: process.env['CI'] ? 2 : 1,
  /* CI 默认保守单 worker，避免重型页面并发导致 Chromium 崩溃；需要提速时用 PLAYWRIGHT_WORKERS 显式覆盖 */
  workers: resolvedWorkers,
  /* 测试报告 */
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  /* 共享设置 */
  use: {
    /* 基础URL */
    baseURL,
    /* 浏览器语言环境：确保 DOM 文本提取与中文渲染一致 */
    locale: 'zh-CN',
    /* 容器环境下避免 /dev/shm 过小导致 Chromium 页面崩溃 */
    launchOptions: {
      args: ['--disable-dev-shm-usage'],
    },
    /* 收集失败测试的trace */
    trace: 'on-first-retry',
    /* 截图 */
    screenshot: 'only-on-failure',
    /* 视频 */
    video: 'on-first-retry',
  },

  /* 配置测试项目（浏览器） */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // 可选：移动端测试
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
  ],

  /* 测试前启动开发服务器 */
  webServer: {
    command: webServerCommand,
    url: baseURL,
    reuseExistingServer: !process.env['CI'] && !process.env['PLAYWRIGHT_WEB_SERVER_COMMAND'],
    timeout: webServerTimeout,
  },
});
