import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// pure-ts 套件：不初始化 zone/TestBed，仅复用全局 mocks。
// 说明：当前仓库里绝大多数 spec 使用了 TestBed（需要 zone.js/testing）。
// 该配置只收纳“无需 TestBed/zone” 的用例，以降低 setup/environment 固定成本。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    setupFiles: ['./src/test-setup.mocks.ts'],
    include: [
      // 自动扫描结果（2026-01-03）：该文件不依赖 TestBed/zone
      'src/utils/supabase-error.spec.ts',
      // 该 spec 已改为直接调用 prototype 私有方法，无需 TestBed/zone
      'src/app/core/services/simple-sync.topological.spec.ts',
      // Stores 仅依赖 Angular Signals，无需 TestBed/zone
      'src/app/core/state/stores.spec.ts',
      // 该 spec 已改为 Injector + runInInjectionContext，无需 TestBed/zone
      'src/services/circuit-breaker.service.spec.ts',
      // 该 spec 已改为 Injector + runInInjectionContext，无需 TestBed/zone
      'src/services/change-tracker.service.spec.ts',
      // 该 spec 已改为 Injector + runInInjectionContext（含 DestroyRef stub），无需 TestBed/zone
      'src/services/request-throttle.service.spec.ts',
      // 该 spec 已改为 Injector + runInInjectionContext，无需 TestBed/zone
      'src/services/sentry-alert.service.spec.ts',
      // 该 spec 已改为 Injector + runInInjectionContext，无需 TestBed/zone
      'src/services/tab-sync.service.spec.ts',
    ],
  },
});
