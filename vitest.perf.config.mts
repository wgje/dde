import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/tests/perf/**/*.spec.ts', 'src/tests/perf/**/*.test.ts'],
    maxWorkers: 1,
    isolate: true,
    testTimeout: 15000,
    hookTimeout: 5000,
  },
});
