import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// pure-ts 套件：不初始化 zone/TestBed，仅复用全局 mocks。
// 说明：当前仓库里绝大多数 spec 使用了 TestBed（需要 zone.js/testing）。
// 该配置只收纳“无需 TestBed/zone” 的用例，以降低 setup/environment 固定成本。
// @see docs/test-architecture-modernization-plan.md Section 6.4
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // 使用最小化初始化（不加载 Angular/zone.js）
    setupFiles: ['./src/test-setup.minimal.ts'],
    include: [
      // === 工具类测试 ===
      'src/utils/supabase-error.spec.ts',

      // === Core 层测试 ===
      'src/app/core/services/simple-sync.topological.spec.ts',
      'src/app/core/state/stores.spec.ts',

      // === 服务层测试（Injector 隔离模式，无 NgZone/effect/JIT 依赖）===
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
      // 以下服务已迁移到 Injector 隔离模式，不依赖 zone.js/effect
      'src/services/sync-coordinator.service.spec.ts',
      // 注：以下文件因依赖需要 JIT 编译器的服务（PlatformLocation 等），保留在 services 配置中：
      // - global-error-handler.service.spec.ts
      // - import.service.spec.ts
      // - export.service.spec.ts（依赖 ThemeService -> isPlatformBrowser）
      // - task-operation.service.spec.ts（依赖 LayoutService）
    ],
  },
});
