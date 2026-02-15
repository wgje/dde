import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// 供 "无 TestBed" 分桶使用：保留 happy-dom，但使用最小化 setup。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    maxWorkers: 1,
    setupFiles: ['./src/test-setup.minimal.ts'],
  },
});
