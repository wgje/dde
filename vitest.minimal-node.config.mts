import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// 无 DOM 依赖的纯逻辑测试车道：使用 node 环境进一步降低 setup/environment 成本。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    environment: 'node',
    maxWorkers: 1,
    setupFiles: ['./src/test-setup.node.ts'],
  },
});
