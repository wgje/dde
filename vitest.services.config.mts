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
      // ====== 以下用例已迁移到 vitest.pure.config.mts（Injector 隔离模式）======
      // 避免 services 套件加载 zone/TestBed 的额外开销
      'src/utils/supabase-error.spec.ts',
      'src/app/core/services/simple-sync.topological.spec.ts',
      'src/app/core/state/stores.spec.ts',
      'src/services/circuit-breaker.service.spec.ts',
      'src/services/change-tracker.service.spec.ts',
      'src/services/request-throttle.service.spec.ts',
      'src/services/sentry-alert.service.spec.ts',
      'src/services/tab-sync.service.spec.ts',
      'src/services/conflict-resolution.service.spec.ts',
      'src/services/undo.service.spec.ts',
      'src/services/auth.service.spec.ts',
      'src/services/network-awareness.service.spec.ts',
      'src/services/offline-integrity.service.spec.ts',
      'src/services/mobile-sync-strategy.service.spec.ts',
      'src/services/optimistic-state.service.spec.ts',
      'src/services/project-state.service.spec.ts',
      'src/services/task-repository.service.spec.ts',
      'src/services/task-trash.service.spec.ts',
      'src/services/task-operation-adapter.service.spec.ts',
      'src/services/attachment-export.service.spec.ts',
      'src/services/attachment-import.service.spec.ts',
      'src/services/action-queue.service.spec.ts',
      'src/services/guards/unsaved-changes.guard.spec.ts',
      // 以下服务已迁移到 Injector 隔离模式
      'src/services/sync-coordinator.service.spec.ts',
      // 注：以下文件因依赖需要 JIT 编译器的服务，保留在此配置中：
      // - global-error-handler.service.spec.ts
      // - import.service.spec.ts
      // - export.service.spec.ts（依赖 ThemeService -> isPlatformBrowser）
      // - export.service.spec.ts（依赖 ThemeService -> isPlatformBrowser）
      // - task-operation.service.spec.ts（依赖 LayoutService）
      // ====== 组件测试交给 vitest.components.config.mts 跑 ======
      'src/app/**/components/**/*.spec.ts',
      'src/app/**/components/**/*.test.ts',
      'src/components/**/*.spec.ts',
      'src/components/**/*.test.ts',
      'src/app.component.spec.ts',
    ],
  },
});
