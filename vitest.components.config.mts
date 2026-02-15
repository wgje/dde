import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // 显式固定组件套件默认 worker，避免 TestBed 初始化重复放大。
    maxWorkers: 1,
    // 组件/Angular TestBed 类单测：尽量单线程，减少重复的 Angular/zone 初始化
    include: [
      'src/app/**/components/**/*.spec.ts',
      'src/app/**/components/**/*.test.ts',
      'src/components/**/*.spec.ts',
      'src/components/**/*.test.ts',
      'src/app.component.spec.ts',
    ],
    // 显式关闭文件并行 + 单线程 worker
    fileParallelism: false,
    pool: 'threads',
  },
});
