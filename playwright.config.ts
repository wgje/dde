import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置文件
 * 用于 NanoFlow 项目的 E2E 测试
 */
const baseURL = process.env['PLAYWRIGHT_BASE_URL'] || 'http://localhost:4200';
const webServerCommand = process.env['PLAYWRIGHT_WEB_SERVER_COMMAND'] || 'npm run start';
const webServerTimeout = Number(process.env['PLAYWRIGHT_WEB_SERVER_TIMEOUT'] || 240_000);

export default defineConfig({
  testDir: './e2e',
  /* 每个测试的超时时间 */
  timeout: 30 * 1000,
  /* 测试期望的超时时间 */
  expect: {
    timeout: 5000
  },
  /* 完整运行失败时不重试 */
  fullyParallel: true,
  /* CI 环境下失败不重试 */
  forbidOnly: !!process.env['CI'],
  /* CI 环境下重试1次 */
  retries: process.env['CI'] ? 1 : 0,
  /* CI 环境并行worker数 */
  workers: process.env['CI'] ? 1 : undefined,
  /* 测试报告 */
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  /* 共享设置 */
  use: {
    /* 基础URL */
    baseURL,
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
