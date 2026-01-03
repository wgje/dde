import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    setupFiles: ['./src/test-setup.services.ts'],
    // 主要跑纯服务/逻辑类单测：更适合 threads 并行
    include: [
      'src/services/**/*.spec.ts',
      'src/services/**/*.test.ts',
      'src/app/core/**/*.spec.ts',
      'src/app/core/**/*.test.ts',
      'src/utils/**/*.spec.ts',
      'src/utils/**/*.test.ts',
      'src/models/**/*.spec.ts',
      'src/models/**/*.test.ts',
    ],
    // 排除组件类 spec（它们会走 components 配置单线程跑）
    exclude: [
      ...(base.test?.exclude ?? []),
      // 纯 TS 用例交给 vitest.pure.config.mts 跑，避免 services 套件加载 zone/TestBed 的额外开销。
      'src/utils/supabase-error.spec.ts',
      'src/app/core/services/simple-sync.topological.spec.ts',
      'src/app/core/state/stores.spec.ts',
      'src/services/circuit-breaker.service.spec.ts',
      'src/services/change-tracker.service.spec.ts',
      'src/services/request-throttle.service.spec.ts',
      'src/services/sentry-alert.service.spec.ts',
      'src/services/tab-sync.service.spec.ts',
      'src/app/**/components/**/*.spec.ts',
      'src/app/**/components/**/*.test.ts',
      'src/components/**/*.spec.ts',
      'src/components/**/*.test.ts',
      'src/app.component.spec.ts',
    ],
  },
});
