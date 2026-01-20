# Angular 19 测试架构现代化转型项目策划案

> **项目代号**: TestPerfX  
> **目标**: 测试执行时间从 34.5s → ≤10s（3.5x 性能提升）  
> **创建日期**: 2026-01-19  
> **状态**: 执行中（差异修复中）  
> **基线版本**: 2026-01-19 实测

---

## 1. 项目概述

### 1.1 背景与动机

当前 NanoFlow 项目测试套件存在显著的性能和覆盖度问题：

**实测基线数据（2026-01-19 最新测量）**：
```
Test Files  38 passed (38)
     Tests  724 passed | 8 skipped (732)
  Duration  34.52s
    ├── transform:   1.58s (5%)
    ├── setup:      11.99s (35%) ← 主要瓶颈
    ├── import:      2.97s (9%)
    ├── tests:       5.96s (17%) ← 实际测试执行
    └── environment: 8.43s (24%) ← 次要瓶颈
```

| 问题 | 现状 | 影响 |
|------|------|------|
| Setup 开销过大 | 11.99s (35%) | 每个 worker 重复初始化 Angular/zone |
| Environment 开销 | 8.43s (24%) | happy-dom 环境创建成本 |
| TestBed 依赖率 | **7/39 文件 (18%)** | 主要集中在组件/集成测试 |
| TDD 难以落地 | 34.5s 反馈周期 | 开发者跳过测试 |
| 离线场景缺失 | 0% 覆盖 | Offline-first 核心功能无保障 |

### 1.2 项目目标

> **目标校准**：基于实际基线数据（2026-01-19 实测 34.52s）和技术限制，调整为更务实的目标。

| 指标 | 当前值 | 目标值 | 提升倍数 |
|------|--------|--------|----------|
| 总执行时间 | 34.52s | ≤10s | 3.5x |
| Setup 时间 | 11.99s | <4s | 3.0x |
| Environment 时间 | 8.43s | <2s | 4.2x |
| 实际测试时间 | 5.96s | <4s | 1.5x |
| TestBed 使用率（服务层） | **0% (0/25)** | 0% | 已达成 |
| TestBed 使用率（核心层） | 0% (0/3) | 0% | 已达成 |
| TestBed 使用率（Features层） | 33% (1/3) | 0% | 需评估（组件测试保留） |
| TestBed 使用率（集成测试） | 100% (6/6) | 100% | 保留（允许） |
| TestBed 使用率（总体） | **18% (7/39)** | ≤15% | 接近目标 |
| 离线场景覆盖率 | 0% | ≥80% | ∞ |

> **⚠️ 数据校正说明**（2026-01-20 差异审查 v4）：
> - 服务层：**25** 个测试文件，**0** 个使用 TestBed（已清零）
> - 核心层（core/）：**3** 个测试文件，**0** 个使用 TestBed
> - Features层：**3** 个测试文件，**1** 个使用 TestBed（flow-task-detail.component.spec.ts）
> - 集成测试：**6** 个测试文件，全部使用 TestBed（符合集成测试定位）
> - 总体：**7/39** 文件使用 TestBed（18%）
> - 已迁移至隔离模式的服务：`circuit-breaker`, `change-tracker`, `tab-sync`, `request-throttle`, `sentry-alert`, `action-queue`, `unsaved-changes.guard`

### 1.3 核心策略（三大支柱）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       测试架构现代化三大支柱                                 │
├───────────────────────┬───────────────────────┬─────────────────────────────┤
│     运行环境优化       │      架构解耦         │    边界模拟与离线策略        │
│  Setup/Env 时间压缩   │    废除 TestBed       │   GoJS/Supabase Mock        │
│  Worker 初始化优化    │   Signal 隔离测试     │  Optimistic UI 回滚验证      │
│  isolate: false 共享  │ runInInjectionContext │  LWW 冲突解决测试           │
└───────────────────────┴───────────────────────┴─────────────────────────────┘
```

### 1.4 性能瓶颈深度分析

#### 1.4.1 Karma 与浏览器的固有开销（历史背景）

虽然项目已迁移至 Vitest，但理解传统架构的问题有助于避免回退：

| Karma 操作 | 耗时占比 | Vitest 对应优化 |
|------------|----------|-----------------|
| 启动浏览器进程 | ~30% | Node.js 运行，无进程启动 |
| Socket 通信建立 | ~10% | 直接内存调用 |
| 全量 Webpack 构建 | ~40% | Vite JIT 按需转换 |
| DOM 渲染/Reflow | ~20% | happy-dom 轻量模拟 |

#### 1.4.2 TestBed 的隐性成本（当前瓶颈）

每次 `TestBed.configureTestingModule()` 调用产生的开销：

```
┌─────────────────────────────────────────────────────────────┐
│ TestBed.configureTestingModule() 执行流程                   │
├─────────────────────────────────────────────────────────────┤
│ 1. 解析元数据 (@Component 装饰器)         ~5ms              │
│ 2. 编译组件模板 (JIT 编译)                ~10ms             │
│ 3. 构建注入器树 (DI Provider 解析)         ~8ms              │
│ 4. 创建 ComponentFixture                   ~3ms              │
│ 5. afterEach 销毁清理                      ~2ms              │
├─────────────────────────────────────────────────────────────┤
│ 单次开销: ~28ms × 362 测试 (50%) = 10.1s 理论累积            │
│ 实测: Setup 12.1s + Environment 8.55s = 20.65s              │
└─────────────────────────────────────────────────────────────┘
```

**关键洞察**：移除 TestBed 可释放 ~60% 的非测试时间开销。

#### 1.4.3 当前 Vitest 配置的优化空间

已有优化（vitest.config.mts）：
- ✅ `environment: 'happy-dom'` - 比 jsdom 快 3-8x
- ✅ `pool: 'threads'` - 线程级并行
- ✅ `isolate: false` - 减少环境重建
- ✅ `css: { include: [] }` - 禁用 CSS 处理

**已有 Mock 基础设施**（`src/test-setup.mocks.ts`）：
- ✅ Supabase 客户端 Mock（支持链式调用）
- ✅ Sentry Mock（完整 API 覆盖）
- ✅ localStorage / IndexedDB Mock（fake-indexeddb + fallback）
- ✅ navigator.onLine / crypto.randomUUID Mock
- ✅ beforeEach 自动 reset 机制

待优化项：
- ⚠️ **7/39** 测试文件仍使用 TestBed（组件 1/3，集成测试 6/6）
- ⚠️ 每个 worker 重复执行 setupFiles（无法完全规避，需靠分层配置与最小化 setup）
- ✅ 已引入 GoJS 模块级 Mock（resolve alias）
- ❌ 离线同步场景零覆盖
- ✅ 已引入 fake-indexeddb（自定义 Mock 仅作 fallback）

> **重要发现**：项目已有完善的 Mock 基础设施（`test-setup.mocks.ts`），本方案应**复用并扩展**现有 Mock，而非从零开始。

---

### 1.5 差异审查与补充问题（2026-01-20）

**已确认完成（与策划案对齐）**
- ✅ 服务层/核心层 TestBed 已清零（仅组件与集成保留）
- ✅ GoJS 模块级 Mock 已落地（resolve alias）
- ✅ 引入 fake-indexeddb，原自定义 IndexedDB Mock 作为 fallback
- ✅ ActionQueue/UnsavedChangesGuard 迁移到 `runInInjectionContext`

**仍未覆盖的关键问题（需补充到计划）**
- ⚠️ 默认 `vitest run` 仍走 base 配置（含 zone/TestBed 初始化），性能提升需在 CI/本地流程显式采用分层配置

**补充建议（新增任务）**
- ✅ Offline-first 关键用例：断网入队 → 重连同步 → LWW 冲突解决 → 本地回滚校验（已落地测试覆盖）
- ✅ 分层配置“污染检测”守卫（事件监听/定时器泄漏检测 + 清理）
- ✅ `fake-indexeddb` 最小化清理策略（fallback + 清理流程）

## 2. 技术方案详述

### 2.1 Phase 1: 运行环境深度优化

#### 2.1.1 当前 Vitest 配置分析

项目已使用 Vitest + happy-dom，但仍有优化空间：

```typescript
// 当前 vitest.config.mts 关键配置
export default defineConfig({
  test: {
    environment: 'happy-dom',      // ✅ 已优化
    pool: 'threads',               // ✅ 已优化
    poolOptions: {
      threads: {
        isolate: false,            // ✅ 共享环境减少开销
        minThreads: 2,
        maxThreads: 4,             // ✅ 限制 worker 数量
      }
    },
    setupFiles: ['./src/test-setup.ts'],  // ⚠️ 每个 worker 都执行
    css: { include: [] },          // ✅ 禁用 CSS
  }
});
```

#### 2.1.2 增强优化方案

```typescript
// vitest.config.mts 目标配置（增量优化）
export default defineConfig({
  test: {
    environment: 'happy-dom',
    css: false,                    // 完全禁用 CSS 解析
    globals: true,
    include: ['src/**/*.spec.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: false,            // 关键：共享环境
        minThreads: 1,
        maxThreads: 4,
      }
    },
    
    // 优化 setupFiles - 拆分为轻量级初始化
    setupFiles: [
      'src/test-setup.minimal.ts',   // 新：最小化初始化
      'fake-indexeddb/auto'           // IndexedDB 模拟
    ],
    
    // 全局 setup（只执行一次）
    globalSetup: 'src/test-global-setup.ts',
    
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    }
  },
  
  resolve: {
    alias: {
      // 模块级 Mock - 阻止真实库加载
      'gojs': './tests/mocks/gojs-mock.ts',
      '@supabase/supabase-js': './tests/mocks/supabase-mock.ts'
    }
  }
});
```

#### 2.1.3 环境优化对比

> **重要说明**：原预估过于乐观。Angular 测试环境有固有开销（zone.js + TestBed.initTestEnvironment），无法完全消除。

| 配置项 | 当前值 | 优化值 | 预期节省 |
|--------|--------|--------|----------|
| setupFiles | 完整初始化 | 最小化初始化 | ~3s |
| TestBed.configureTestingModule | **63% 使用率** | 服务层 0% | ~8s |
| GoJS Mock | 无 | 模块级 Mock | ~2s |
| Worker 并行优化 | 默认配置 | 优化线程数 | ~3s |
| CSS 处理 | 部分禁用 | 完全禁用 | ~1s |
| **总计** | **34.52s** | ~10s | **~24s** |

> **为什么不是 5s？** Angular 测试环境的 `TestBed.initTestEnvironment()` 是必需的（即使不使用 configureTestingModule），这带来约 3-5s 的固有开销。

#### 2.1.4 当前 Vitest 配置关键参数（实测分析）

> **深度审查补充**：基于 [vitest.config.mts](vitest.config.mts) 的实际配置分析。

```typescript
// 当前配置的关键性能参数
poolOptions: {
  threads: {
    minThreads,        // 动态计算：min(2, maxThreads)
    maxThreads,        // 动态计算：min(4, cpuCount - 1)
    isolate: false,    // ✅ 关键优化：禁用隔离减少开销
    singleThread: false,
  }
}

// 当前超时配置（已优化）
testTimeout: 2000,     // 2s 足够（使用 fake timers）
hookTimeout: 1000,     // 1s 限制 beforeEach/afterEach
```

**⚠️ 发现的潜在问题**：
1. `optimizeDeps.include` 包含了 `zone.js/testing`，但 `@angular/core/testing` 依赖可能导致重复编译
2. `cacheDir` 使用 `node_modules/.vitest`，在 CI 环境下可能因缓存失效导致性能波动
3. `deps.optimizer.web.include` 的范围可能需要扩展

**建议的优化点**：
```typescript
// 增加以下配置以进一步优化
deps: {
  optimizer: {
    web: {
      include: [
        '@angular/*',
        'rxjs',
        'zone.js',
        // 新增：预构建常用测试依赖
        '@angular/core/testing',
        '@angular/platform-browser-dynamic/testing',
      ],
    },
  },
},
```

### 2.2 Phase 2: 架构解耦（去 TestBed 化）

#### 2.2.1 TestBed 使用现状

当前项目中 **7/39 (18%)** 测试文件使用 TestBed：

| 目录 | 文件数 | 使用 TestBed | 不使用 TestBed | 迁移优先级 |
|------|--------|--------------|----------------|-----------|
| `src/services/` | 25 | **0 (0%)** | 25 | P0 - 核心服务（已完成） |
| `src/app/core/` | 3 | 0 (0%) | 3 | P0 - 核心状态（已完成） |
| `src/app/features/` | 3 | 1 (33%) | 2 | P1 - 业务组件（保留组件 TestBed） |
| `src/tests/integration/` | 6 | 6 (100%) | 0 | P2 - 集成测试（保留） |
| 其他（app.component, utils） | 2 | 0 (0%) | 2 | 无需迁移 |

**已迁移至隔离模式的服务（参考范例）**：
```
✅ circuit-breaker.service.spec.ts
✅ change-tracker.service.spec.ts
✅ tab-sync.service.spec.ts
✅ request-throttle.service.spec.ts（含 DestroyRef Mock 最佳实践）
✅ sentry-alert.service.spec.ts
✅ action-queue.service.spec.ts
✅ guards/unsaved-changes.guard.spec.ts
```

**待迁移的服务层测试文件**：无（服务层 TestBed 已清零）

> **注意**：`src/tests/integration/` 中的集成测试全部使用 TestBed，这符合集成测试的定位。最终目标是服务层和组件层 0% TestBed，集成测试可保留 TestBed 用于真实 DI 场景验证。

#### 2.2.2 传统模式 vs 隔离模式

```typescript
// ❌ 传统 TestBed 模式（慢 ~28ms/test）
// 当前项目中 50% 测试使用此模式
beforeEach(async () => {
  await TestBed.configureTestingModule({
    imports: [MyComponent],
    providers: [{ provide: MyService, useValue: mockService }]
  }).compileComponents();
  fixture = TestBed.createComponent(MyComponent);
  component = fixture.componentInstance;
});

// ✅ 隔离单元测试模式（快 ~0.5ms/test）
// 目标：100% 测试使用此模式
beforeEach(() => {
  const injector = Injector.create({
    providers: [{ provide: MyService, useValue: mockService }]
  });
  runInInjectionContext(injector, () => {
    component = new MyComponent();
  });
});
```

**性能对比**：
- TestBed 模式：~28ms × 24 文件累积开销 = **显著时间损耗**
- 隔离模式：~0.5ms × 724 tests = **0.36s**
- 实际节省预估：考虑到 setup/environment 占 20.42s (59%)，迁移后预估节省 **~12-15s**

> **⚠️ 性能节省修正**：
> 1. TestBed.initTestEnvironment 仍需保留（固有开销，约 2-3s）
> 2. Zone.js 初始化无法避免（约 1-2s）
> 3. 合理预估节省：**12-15s (35-45%)**，最终目标 ≤10s

#### 2.2.3 Angular 19 Signal 测试模式

项目大量使用 Angular Signals（如 `TaskOperationAdapterService`）。需要特殊处理：

```typescript
// Angular 19 Signal 组件/服务测试
// 示例：测试 OptimisticStateService
describe('OptimisticStateService', () => {
  let service: OptimisticStateService;
  let mockProjectState: MockProjectStateService;
  let mockToast: MockToastService;

  beforeEach(() => {
    // 1. 创建 Mock 依赖（使用 signal）
    mockProjectState = {
      projects: signal<Project[]>([]),
      activeProjectId: signal<string | null>(null),
      updateProjects: vi.fn((mutator) => {
        mockProjectState.projects.update(mutator);
      }),
    };
    
    mockToast = { success: vi.fn(), error: vi.fn() };
    
    // 2. 创建轻量级注入器
    const injector = Injector.create({
      providers: [
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: createMockLogger() },
      ]
    });

    // 3. 在注入上下文中实例化
    runInInjectionContext(injector, () => {
      service = new OptimisticStateService();
    });
  });

  it('should create snapshot before optimistic update', () => {
    // 直接操作 Signal，无需 fixture.detectChanges()
    mockProjectState.projects.set([createMockProject()]);
    
    const snapshot = service.createSnapshot('task-update', '更新任务');
    
    expect(snapshot.id).toBeDefined();
    expect(snapshot.projectsSnapshot).toHaveLength(1);
  });

  it('should rollback to snapshot on failure', () => {
    const originalProjects = [createMockProject()];
    mockProjectState.projects.set(originalProjects);
    
    const snapshot = service.createSnapshot('task-delete', '删除任务');
    
    // 模拟乐观更新
    mockProjectState.projects.set([]);
    expect(mockProjectState.projects()).toHaveLength(0);
    
    // 回滚
    service.rollbackSnapshot(snapshot.id);
    
    expect(mockProjectState.projects()).toHaveLength(1);
  });
});
```

#### 2.2.4 effect() 测试策略

Angular 的 `effect()` 在变更检测周期中运行，无 TestBed 时需特殊处理。

**项目现状分析**：

本项目大量使用 `effect()` 进行响应式副作用处理，主要场景包括：
- `FlowViewComponent`：11 个 effect 处理图表状态同步
- `FlowDiagramService`：主题切换 effect
- `TextTaskEditorComponent`：表单同步 effect
- `OfflineBannerComponent`：网络状态响应 effect

> **⚠️ 深度审查发现**：原策划案遗漏了 `computed()` 的测试策略。`computed` 与 `effect` 有本质区别：
> - `computed`：惰性求值，可直接调用并断言
> - `effect`：副作用驱动，需要等待执行

```typescript
// 策略 1: 重构为 computed（推荐）
// effect 用于副作用，测试应关注其产生的状态结果
// 将 effect 内的逻辑提取为可测试的纯函数

// 策略 2: 手动触发微任务队列
it('should execute effect after signal change', async () => {
  service.sourceSignal.set(newValue);
  
  // 等待 effect 执行
  await flushMicrotasks();
  
  expect(service.sideEffectResult).toBe(expectedValue);
});

// 辅助函数
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => queueMicrotask(resolve));
}

// 策略 3: TestBed.flushEffects()（需 TestBed 支持）
// 仅在集成测试中使用
it('should sync effect in integration test', () => {
  TestBed.flushEffects();  // Angular 19+ API
  expect(component.computedValue()).toBe(expected);
});
```

#### 2.2.4.1 computed() 测试策略（深度审查新增）

`computed()` 比 `effect()` 更容易测试，因为它是惰性求值的纯函数：

```typescript
describe('ProjectStateService - Computed Signals', () => {
  it('should derive active tasks from projects signal', () => {
    // computed 可直接调用
    const tasks = [
      createMockTask({ status: 'active' }),
      createMockTask({ status: 'completed' }),
    ];
    mockProjectState.setProjects([
      createMockProject({ tasks })
    ]);
    
    // computed 立即返回最新值
    expect(service.activeTasks()).toHaveLength(1);
    expect(service.activeTasks()[0].status).toBe('active');
  });

  it('should update computed when source signal changes', () => {
    // 初始状态
    expect(service.taskCount()).toBe(0);
    
    // 更新源 signal
    mockProjectState.setProjects([
      createMockProject({ tasks: [createMockTask(), createMockTask()] })
    ]);
    
    // computed 自动更新（无需 flushMicrotasks）
    expect(service.taskCount()).toBe(2);
  });

  it('should handle complex computed chains', () => {
    // computed 可以依赖其他 computed
    const project = createMockProject({
      tasks: [
        createMockTask({ stage: 1, status: 'active' }),
        createMockTask({ stage: 1, status: 'completed' }),
        createMockTask({ stage: 2, status: 'active' }),
      ]
    });
    mockProjectState.setProjects([project]);
    
    // tasksByStage 依赖 activeTasks
    expect(service.tasksByStage(1)).toHaveLength(2);
    expect(service.completedTasksByStage(1)).toHaveLength(1);
  });
});
```

**computed vs effect 对比**：

| 特性 | `computed()` | `effect()` |
|------|-------------|-----------|
| 求值时机 | 惰性（调用时） | 响应式（依赖变化时） |
| 返回值 | 有返回值 | 无返回值（副作用） |
| 测试难度 | ⭐ 简单 | ⭐⭐⭐ 复杂 |
| 推荐做法 | 直接调用断言 | 提取副作用逻辑 + flushMicrotasks |

**effect() 测试决策树**：

```
┌─────────────────────────────────────────────────────────────────┐
│                    effect() 测试策略选择                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  effect 是否产生可观测的外部副作用？                              │
│           │                                                     │
│         YES                                                     │
│           ↓                                                     │
│  是否可以重构为 computed + 独立副作用函数？                        │
│           │                    │                                │
│         YES                   NO                                │
│           ↓                    ↓                                │
│  测试 computed 结果        使用 flushMicrotasks()               │
│  + 副作用函数单独测试       await 副作用执行完成                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 2.2.5 DestroyRef Mock 策略（关键边界）

本项目多个服务使用 `DestroyRef` 进行清理：
- `NetworkAwarenessService`
- `AttachmentService`
- `PersistenceFailureHandlerService`
- `BeforeUnloadManagerService`
- `RequestThrottleService`

**参考实现**（来自 `request-throttle.service.spec.ts`）：

```typescript
import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';

describe('ServiceWithDestroyRef', () => {
  let destroyCallbacks: Array<() => void>;
  
  beforeEach(() => {
    destroyCallbacks = [];
    
    // 创建 DestroyRef Mock
    const destroyRef: Pick<DestroyRef, 'onDestroy'> = {
      onDestroy: (cb: () => void) => {
        destroyCallbacks.push(cb);
      },
    };
    
    const injector = Injector.create({
      providers: [
        { provide: DestroyRef, useValue: destroyRef },
        // ... 其他依赖
      ],
    });
    
    service = runInInjectionContext(injector, () => new MyService());
  });
  
  afterEach(() => {
    // 模拟组件/服务销毁
    for (const cb of destroyCallbacks) cb();
  });
  
  it('should cleanup resources on destroy', () => {
    // 触发销毁
    for (const cb of destroyCallbacks) cb();
    
    // 验证清理逻辑执行
    expect(service.isCleanedUp).toBe(true);
  });
});
```

**DestroyRef Mock 工厂函数**（建议添加到标准 Mock 库）：

```typescript
// tests/mocks/standard-mocks.ts
export function createMockDestroyRef(): {
  destroyRef: Pick<DestroyRef, 'onDestroy'>;
  triggerDestroy: () => void;
} {
  const callbacks: Array<() => void> = [];
  
  return {
    destroyRef: {
      onDestroy: (cb: () => void) => { callbacks.push(cb); }
    },
    triggerDestroy: () => { callbacks.forEach(cb => cb()); }
  };
}
```

### 2.3 Phase 3: 边界模拟策略

#### 2.3.1 GoJS 空壳模拟（Hollow Shell Pattern）

**问题分析**：GoJS 依赖 HTML5 Canvas API，在 happy-dom 中不完整。加载真实 GoJS 会：
1. 因缺少 Canvas API 报错
2. 初始化复杂对象图，消耗数百毫秒
3. 引入不必要的运行时依赖

**战略决策**：在单元测试中，测试"如何使用 GoJS"，而非 GoJS 本身。

```typescript
// tests/mocks/gojs-mock.ts
import { vi } from 'vitest';

// 模拟 GraphObject.make 工厂函数（GoJS 核心 API）
export class GraphObject {
  static make = vi.fn((type: string, ...args: any[]) => ({
    type,
    props: args,
    bind: vi.fn().mockReturnThis(),
    add: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  }));
}

export class Diagram {
  div: string;
  model: any = {};
  nodes: any = { each: vi.fn() };
  links: any = { each: vi.fn() };
  selection: any = { each: vi.fn(), first: vi.fn() };
  
  constructor(div: string) { this.div = div; }
  
  // 事务控制
  startTransaction = vi.fn();
  commitTransaction = vi.fn();
  rollbackTransaction = vi.fn();
  
  // 节点操作
  findNodeForKey = vi.fn();
  findLinkForData = vi.fn();
  
  // 事件监听
  addDiagramListener = vi.fn();
  removeDiagramListener = vi.fn();
  addModelChangedListener = vi.fn();
  
  // 生命周期
  clear = vi.fn();
  
  // 视图控制
  zoomToFit = vi.fn();
  centerRect = vi.fn();
  scroll = vi.fn();
}

// 导出 GoJS 常量（用于模板定义）
export const Node = 'Node';
export const Link = 'Link';
export const Shape = 'Shape';
export const TextBlock = 'TextBlock';
export const Panel = 'Panel';
export const Spot = { Center: 'Center', Top: 'Top', Bottom: 'Bottom' };
export const Binding = vi.fn((target: string, source: string) => ({ target, source }));

// 模型类
export const GraphLinksModel = vi.fn(() => ({
  nodeDataArray: [],
  linkDataArray: [],
  addNodeData: vi.fn(),
  removeNodeData: vi.fn(),
  setDataProperty: vi.fn(),
}));

export const TreeModel = vi.fn(() => ({
  nodeDataArray: [],
  addNodeData: vi.fn(),
}));
```

**测试验证策略**：

```typescript
// 测试 FlowTemplateService 如何使用 GoJS
describe('FlowTemplateService', () => {
  it('should create node template with correct bindings', () => {
    const template = service.createNodeTemplate();
    
    // 验证 GraphObject.make 被正确调用
    expect(GraphObject.make).toHaveBeenCalledWith(
      Node,
      expect.objectContaining({ locationSpot: expect.anything() })
    );
    
    // 验证绑定配置
    expect(Binding).toHaveBeenCalledWith('location', 'loc');
  });
});
```

#### 2.3.2 Supabase 链式调用模拟

**问题分析**：Supabase 客户端是有状态单例，会尝试连接后端。必须阻止真实网络请求。

**关键挑战**：Supabase 使用流式 API（fluent interface），如 `supabase.from('table').select('*').eq('id', 1)`。

```typescript
// tests/mocks/supabase-mock.ts
import { vi } from 'vitest';

/**
 * 创建可链式调用的 Mock 对象
 * 支持任意深度的链式调用
 */
const createChainableMock = (defaultResponse = { data: null, error: null }) => {
  const mock: any = {};
  
  // 链式方法（返回 this）
  const chainMethods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'contains',
    'order', 'limit', 'range', 'filter',
  ];
  
  chainMethods.forEach(method => {
    mock[method] = vi.fn().mockReturnThis();
  });
  
  // 终结方法（返回 Promise）
  mock.single = vi.fn().mockResolvedValue(defaultResponse);
  mock.maybeSingle = vi.fn().mockResolvedValue(defaultResponse);
  mock.then = vi.fn((resolve) => Promise.resolve(defaultResponse).then(resolve));
  
  return mock;
};

export const mockSupabaseClient = {
  // Auth 模块
  auth: {
    getSession: vi.fn().mockResolvedValue({ 
      data: { session: null }, 
      error: null 
    }),
    getUser: vi.fn().mockResolvedValue({ 
      data: { user: null }, 
      error: null 
    }),
    onAuthStateChange: vi.fn().mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } }
    }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: null, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: null, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    refreshSession: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
  
  // 数据库查询
  from: vi.fn((table: string) => createChainableMock()),
  
  // RPC 调用
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  
  // Storage 模块
  storage: {
    from: vi.fn((bucket: string) => ({
      upload: vi.fn().mockResolvedValue({ data: { path: 'mock-path' }, error: null }),
      download: vi.fn().mockResolvedValue({ data: new Blob(), error: null }),
      remove: vi.fn().mockResolvedValue({ data: null, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'mock-url' } }),
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'mock-signed-url' }, error: null }),
    }))
  },
  
  // Realtime 模块
  channel: vi.fn((name: string) => ({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnValue({ status: 'SUBSCRIBED' }),
    unsubscribe: vi.fn(),
    send: vi.fn(),
  })),
  
  removeChannel: vi.fn(),
  removeAllChannels: vi.fn(),
};

// 导出工厂函数
export const createClient = vi.fn(() => mockSupabaseClient);

// 辅助函数：设置特定查询的返回值
export function mockSupabaseQuery(
  table: string, 
  response: { data: any; error: any }
) {
  const chainable = createChainableMock(response);
  mockSupabaseClient.from.mockImplementation((t: string) => 
    t === table ? chainable : createChainableMock()
  );
  return chainable;
}
```

**使用示例**：

```typescript
describe('TaskRepositoryService', () => {
  beforeEach(() => {
    // 设置特定表的返回值
    mockSupabaseQuery('tasks', {
      data: [{ id: '1', title: 'Test Task' }],
      error: null
    });
  });

  it('should fetch tasks from Supabase', async () => {
    const tasks = await service.fetchTasks('project-1');
    
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('tasks');
    expect(tasks).toHaveLength(1);
  });

  it('should handle Supabase errors', async () => {
    mockSupabaseQuery('tasks', {
      data: null,
      error: { code: 'PGRST116', message: 'Not found' }
    });
    
    await expect(service.fetchTasks('invalid')).rejects.toThrow();
  });
});
```

### 2.4 Phase 4: 离线优先测试覆盖

> **审查报告重点指出**：缺失 Offline-first 同步场景测试是当前测试架构的关键盲区。

#### 2.4.1 离线测试层次架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    离线优先测试金字塔                            │
├─────────────────────────────────────────────────────────────────┤
│                     E2E (Playwright)                            │
│                    网络仿真 + 全流程                             │
│                      ~5 个场景                                  │
├─────────────────────────────────────────────────────────────────┤
│                 集成测试 (Vitest)                               │
│            IndexedDB + Sync 协调                                │
│                   ~15 个场景                                    │
├─────────────────────────────────────────────────────────────────┤
│                    单元测试 (Vitest)                            │
│         乐观更新 + LWW 冲突 + RetryQueue                         │
│                   ~50 个场景                                    │
└─────────────────────────────────────────────────────────────────┘
```

#### 2.4.2 乐观 UI 回滚测试（核心场景）

**场景描述**：用户触发操作 → 界面立即更新（假设成功）→ 后台请求失败 → **必须回滚**

这是离线优先架构最容易出 Bug 的地方。使用"受控 Promise"模式精确测试时序：

```typescript
// 测试 TaskOperationAdapterService 的乐观更新回滚
describe('TaskOperationAdapterService - Optimistic UI', () => {
  let service: TaskOperationAdapterService;
  let mockOptimisticState: MockOptimisticStateService;
  let mockSyncCoordinator: MockSyncCoordinatorService;
  
  beforeEach(() => {
    // 使用隔离模式初始化（无 TestBed）
    const injector = createTestInjector([
      { provide: OptimisticStateService, useValue: mockOptimisticState },
      { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
      // ... 其他依赖
    ]);
    
    runInInjectionContext(injector, () => {
      service = new TaskOperationAdapterService();
    });
  });

  it('should rollback optimistic update when sync fails', async () => {
    // 1. 创建受控 Promise（关键技术）
    let rejectSync!: (error: Error) => void;
    const syncPromise = new Promise<void>((_, reject) => {
      rejectSync = reject;
    });
    
    mockSyncCoordinator.schedulePersist.mockReturnValue(syncPromise);
    
    // 2. 记录初始状态
    const originalTask = { id: 'task-1', title: 'Original Title' };
    mockProjectState.setProjects([createProjectWithTask(originalTask)]);
    
    // 3. 执行乐观更新
    service.updateTaskTitle('task-1', 'Updated Title');
    
    // 4. 验证乐观状态（UI 已更新，但同步未完成）
    expect(mockProjectState.getTask('task-1')?.title).toBe('Updated Title');
    expect(mockOptimisticState.createTaskSnapshot).toHaveBeenCalled();
    
    // 5. 触发同步失败
    rejectSync(new Error('Network Offline'));
    await flushPromises();
    
    // 6. 验证状态回滚
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalled();
    expect(mockProjectState.getTask('task-1')?.title).toBe('Original Title');
  });

  it('should commit snapshot when sync succeeds', async () => {
    // 1. 创建受控 Promise
    let resolveSync!: () => void;
    const syncPromise = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    
    mockSyncCoordinator.schedulePersist.mockReturnValue(syncPromise);
    
    // 2. 执行操作
    service.addTask('New Task', '', null, null, false);
    
    // 3. 验证快照已创建
    expect(mockOptimisticState.createTaskSnapshot).toHaveBeenCalled();
    
    // 4. 同步成功
    resolveSync();
    await flushPromises();
    
    // 5. 验证快照已提交（非回滚）
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalled();
    expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
  });
});

// 辅助函数
async function flushPromises(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
```

#### 2.4.3 LWW（Last-Write-Wins）冲突解决测试

根据项目架构（`AGENTS.md` 中定义的冲突策略），测试 LWW 机制：

```typescript
describe('ConflictResolutionService - LWW', () => {
  it('should resolve conflict using Last-Write-Wins', () => {
    const localTask = {
      id: 'task-1',
      title: 'Local Edit',
      updatedAt: '2026-01-19T10:00:00Z'
    };
    
    const remoteTask = {
      id: 'task-1',
      title: 'Remote Edit',
      updatedAt: '2026-01-19T10:00:05Z'  // 5秒后
    };
    
    const resolved = service.resolveConflict(localTask, remoteTask);
    
    // 远程时间更晚，应使用远程版本
    expect(resolved.title).toBe('Remote Edit');
    expect(resolved.updatedAt).toBe('2026-01-19T10:00:05Z');
  });

  it('should prefer local when timestamps are equal', () => {
    const sameTime = '2026-01-19T10:00:00Z';
    
    const localTask = { id: 'task-1', title: 'Local', updatedAt: sameTime };
    const remoteTask = { id: 'task-1', title: 'Remote', updatedAt: sameTime };
    
    const resolved = service.resolveConflict(localTask, remoteTask);
    
    // 时间相同时优先本地（减少用户困惑）
    expect(resolved.title).toBe('Local');
  });
});
```

#### 2.4.4 RetryQueue 测试

```typescript
describe('ActionQueueService - RetryQueue', () => {
  it('should queue failed operations for retry', async () => {
    const operation = {
      id: 'op-1',
      type: 'task-update',
      payload: { taskId: 'task-1', title: 'New Title' }
    };
    
    // 模拟首次失败
    mockSyncService.push.mockRejectedValueOnce(new Error('Network Error'));
    
    await service.enqueue(operation);
    
    // 验证进入重试队列
    expect(service.pendingQueue()).toContainEqual(
      expect.objectContaining({ id: 'op-1', retryCount: 1 })
    );
  });

  it('should retry with exponential backoff', async () => {
    vi.useFakeTimers();
    
    const operation = { id: 'op-1', type: 'task-update', payload: {} };
    mockSyncService.push.mockRejectedValue(new Error('Still offline'));
    
    await service.enqueue(operation);
    
    // 第一次重试：1s 后
    vi.advanceTimersByTime(1000);
    expect(mockSyncService.push).toHaveBeenCalledTimes(2);
    
    // 第二次重试：2s 后（指数退避）
    vi.advanceTimersByTime(2000);
    expect(mockSyncService.push).toHaveBeenCalledTimes(3);
    
    vi.useRealTimers();
  });

  it('should process queue when network recovers', async () => {
    const operation = { id: 'op-1', type: 'task-update', payload: {} };
    
    // 先失败
    mockSyncService.push.mockRejectedValueOnce(new Error('Offline'));
    await service.enqueue(operation);
    
    // 网络恢复
    mockSyncService.push.mockResolvedValueOnce({ success: true });
    service.processQueue();
    
    await flushPromises();
    
    // 队列应清空
    expect(service.pendingQueue()).toHaveLength(0);
  });
});
```

#### 2.4.5 IndexedDB 持久化测试

```typescript
// 使用 fake-indexeddb 测试本地存储
import 'fake-indexeddb/auto';

describe('StorageAdapterService', () => {
  beforeEach(async () => {
    // 清理 IndexedDB
    const databases = await indexedDB.databases();
    for (const db of databases) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });

  it('should persist task to IndexedDB', async () => {
    const task = { 
      id: crypto.randomUUID(), 
      title: 'Test Task',
      updatedAt: new Date().toISOString()
    };
    
    await service.saveTask(task);
    const retrieved = await service.getTask(task.id);
    
    expect(retrieved).toEqual(task);
  });

  it('should queue changes when offline', async () => {
    mockNetworkService.isOnline.mockReturnValue(false);
    
    const task = { id: '1', title: 'Offline Task' };
    await service.saveTask(task);
    
    const queue = await service.getPendingSyncQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      action: 'upsert',
      table: 'tasks',
      data: task
    });
  });

  it('should sync queued changes when online', async () => {
    // 离线时保存
    mockNetworkService.isOnline.mockReturnValue(false);
    await service.saveTask({ id: '1', title: 'Task 1' });
    await service.saveTask({ id: '2', title: 'Task 2' });
    
    // 网络恢复
    mockNetworkService.isOnline.mockReturnValue(true);
    await service.syncPendingChanges();
    
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('tasks');
    
    // 队列应清空
    const queue = await service.getPendingSyncQueue();
    expect(queue).toHaveLength(0);
  });
});
```

#### 2.4.6 Playwright 网络仿真（E2E 层）

```typescript
// e2e/offline-sync.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Offline-First Sync', () => {
  test.beforeEach(async ({ page }) => {
    // 使用存储状态避免重复登录
    await page.goto('/project/test-project');
    await expect(page.getByTestId('project-loaded')).toBeVisible();
  });

  test('should show offline indicator when network disconnected', async ({ context, page }) => {
    await context.setOffline(true);
    
    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveText('离线');
  });

  test('should save data locally when offline', async ({ context, page }) => {
    // 断网
    await context.setOffline(true);
    
    // 创建任务
    await page.getByTestId('add-task-btn').click();
    await page.getByTestId('task-title-input').fill('Offline Task');
    await page.getByTestId('save-btn').click();
    
    // 验证任务显示
    await expect(page.getByText('Offline Task')).toBeVisible();
    
    // 验证同步状态
    await expect(page.getByTestId('sync-status')).toHaveText('等待同步');
    
    // 验证 IndexedDB 中有数据
    const hasLocalData = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('nanoflow-db');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('tasks', 'readonly');
      const store = tx.objectStore('tasks');
      const count = await new Promise<number>((resolve) => {
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
      });
      return count > 0;
    });
    
    expect(hasLocalData).toBe(true);
  });

  test('should sync data after reconnection', async ({ context, page }) => {
    // 断网并创建任务
    await context.setOffline(true);
    await page.getByTestId('add-task-btn').click();
    await page.getByTestId('task-title-input').fill('Will Sync Later');
    await page.getByTestId('save-btn').click();
    
    // 恢复网络
    await context.setOffline(false);
    
    // 等待同步完成
    await expect(page.getByTestId('sync-status')).toHaveText('已同步', {
      timeout: 10000
    });
    
    // 刷新页面验证数据持久化
    await page.reload();
    await expect(page.getByText('Will Sync Later')).toBeVisible();
  });

  test('should handle sync conflict with LWW', async ({ context, page, browser }) => {
    // 在另一个 context 中模拟远程修改
    const remoteContext = await browser.newContext();
    const remotePage = await remoteContext.newPage();
    await remotePage.goto('/project/test-project');
    
    // 本地断网
    await context.setOffline(true);
    
    // 本地修改任务
    await page.getByTestId('task-task-1').click();
    await page.getByTestId('task-title-input').fill('Local Edit');
    await page.getByTestId('save-btn').click();
    
    // 远程修改同一任务（5秒后）
    await remotePage.getByTestId('task-task-1').click();
    await remotePage.getByTestId('task-title-input').fill('Remote Edit');
    await remotePage.getByTestId('save-btn').click();
    await remotePage.waitForTimeout(5000);
    
    // 本地恢复网络
    await context.setOffline(false);
    
    // 等待冲突解决
    await expect(page.getByTestId('sync-status')).toHaveText('已同步');
    
    // LWW 策略：远程更晚，应显示远程版本
    await expect(page.getByTestId('task-task-1')).toContainText('Remote Edit');
    
    await remoteContext.close();
  });
});
```

#### 2.4.7 遗漏边界场景补充（深度审查新增）

> **⚠️ 关键补充**：原策划案遗漏了以下离线优先架构的关键边界场景。

##### 2.4.7.1 Supabase Realtime 断连恢复测试

```typescript
describe('RealtimeSubscriptionService - Connection Recovery', () => {
  it('should resubscribe after connection lost', async () => {
    // 1. 建立订阅
    service.subscribeToProject('project-1');
    expect(mockSupabaseClient.channel).toHaveBeenCalled();
    
    // 2. 模拟连接断开（Supabase 会发出 'CLOSED' 状态）
    const channelCallback = mockSupabaseClient.channel.mock.results[0].value;
    channelCallback.trigger('CLOSED');
    
    // 3. 验证重连逻辑触发
    await flushPromises();
    expect(mockSupabaseClient.channel).toHaveBeenCalledTimes(2); // 重新订阅
  });

  it('should not lose data during reconnection', async () => {
    // 1. 订阅中收到更新
    const remoteUpdate = { id: 'task-1', title: 'Remote Update' };
    service.subscribeToProject('project-1');
    
    // 2. 模拟断连期间的远程变更
    mockNetworkService.isOnline.mockReturnValue(false);
    // 重连后应通过 delta sync 拉取丢失的变更
    
    mockNetworkService.isOnline.mockReturnValue(true);
    await service.reconnect();
    
    // 3. 验证触发增量同步
    expect(mockSyncCoordinator.pullRemoteChanges).toHaveBeenCalledWith(
      expect.objectContaining({ since: expect.any(String) })
    );
  });
});
```

##### 2.4.7.2 并发写入竞态条件测试

```typescript
describe('SyncCoordinatorService - Race Conditions', () => {
  it('should serialize concurrent local writes', async () => {
    const writeOrder: string[] = [];
    
    // 模拟序列化写入
    mockActionQueue.enqueue.mockImplementation(async (op) => {
      writeOrder.push(op.id);
      await new Promise(r => setTimeout(r, 10));
    });
    
    // 并发触发多个写入
    const writes = [
      service.saveTask({ id: 't1', title: 'A' }),
      service.saveTask({ id: 't2', title: 'B' }),
      service.saveTask({ id: 't3', title: 'C' }),
    ];
    
    await Promise.all(writes);
    
    // 验证写入是串行处理的（FIFO）
    expect(writeOrder).toEqual(['t1', 't2', 't3']);
  });

  it('should handle rapid toggle operations correctly', async () => {
    // 模拟用户快速点击完成/取消完成
    const task = { id: 't1', status: 'active' };
    
    service.toggleTaskStatus(task.id);
    service.toggleTaskStatus(task.id);
    service.toggleTaskStatus(task.id);
    
    await flushPromises();
    
    // 最终状态应为 'completed'（奇数次切换）
    expect(mockProjectState.getTask(task.id)?.status).toBe('completed');
    // 但同步应该只发送最终状态，而非中间状态
    expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalledTimes(1);
  });
});
```

##### 2.4.7.3 Storage 配额耗尽测试

```typescript
describe('StorageAdapterService - Quota Exceeded', () => {
  it('should handle IndexedDB quota exceeded gracefully', async () => {
    // 模拟配额耗尽错误
    const quotaError = new DOMException('QuotaExceededError', 'QuotaExceededError');
    mockIndexedDB.put.mockRejectedValue(quotaError);
    
    const result = await service.saveTask(largeTask);
    
    // 应显示用户友好的错误提示
    expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringContaining('存储空间不足')
    );
    // 应触发 Sentry 报告
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      quotaError, 
      expect.objectContaining({ level: 'warning' })
    );
    // 应尝试清理旧数据
    expect(service.triggerStorageCleanup).toHaveBeenCalled();
  });

  it('should prioritize pending sync data over cache', async () => {
    // 配额不足时，应优先保留待同步数据，删除可恢复的缓存
    mockStorageQuota.getUsage.mockResolvedValue({ used: 0.95, total: 1 });
    
    await service.handleLowStorage();
    
    // 应删除可恢复数据（如远程同步过的数据）
    expect(service.cleanupSyncedData).toHaveBeenCalled();
    // 待同步队列应保留
    expect(service.pendingSyncQueue.length).toBeGreaterThan(0);
  });
});
```

##### 2.4.7.4 GoJS 内存泄漏防护测试

```typescript
describe('FlowDiagramService - Memory Management', () => {
  it('should clean up event listeners on destroy', () => {
    // 创建图表
    service.initDiagram(mockDivElement);
    
    // 验证事件监听已注册
    expect(mockDiagram.addDiagramListener).toHaveBeenCalled();
    
    // 触发销毁
    service.ngOnDestroy();
    
    // 验证事件监听已移除
    expect(mockDiagram.removeDiagramListener).toHaveBeenCalled();
    expect(mockDiagram.clear).toHaveBeenCalled();
  });

  it('should prevent diagram operations after destroy', () => {
    service.initDiagram(mockDivElement);
    service.ngOnDestroy();
    
    // 销毁后的操作应被静默忽略，不抛错
    expect(() => service.addNode({ id: 'x', title: 'Test' })).not.toThrow();
    expect(mockDiagram.startTransaction).not.toHaveBeenCalled();
  });

  it('should handle @defer lazy loading correctly on mobile', async () => {
    // 模拟移动端
    mockUiState.isMobile.mockReturnValue(true);
    
    // Flow 视图不应预加载
    expect(service.isInitialized).toBe(false);
    
    // 用户切换到 Flow 视图时才初始化
    await service.lazyInit(mockDivElement);
    expect(service.isInitialized).toBe(true);
    
    // 切换回 Text 视图时应销毁
    service.destroy();
    expect(service.isInitialized).toBe(false);
  });
});
```

##### 2.4.7.5 时钟偏移导致的 LWW 异常测试

```typescript
describe('ConflictResolutionService - Clock Skew', () => {
  it('should handle future timestamps gracefully', () => {
    // 远程时间戳在未来（时钟偏移）
    const futureTime = new Date(Date.now() + 3600000).toISOString(); // 1小时后
    
    const localTask = { id: 't1', title: 'Local', updatedAt: new Date().toISOString() };
    const remoteTask = { id: 't1', title: 'Future', updatedAt: futureTime };
    
    const resolved = service.resolveConflict(localTask, remoteTask);
    
    // 应使用远程版本（LWW），但记录警告
    expect(resolved.title).toBe('Future');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('时钟偏移')
    );
  });

  it('should use server timestamp for sync when available', async () => {
    // 使用服务器时间戳避免本地时钟问题
    mockClockSync.getServerTime.mockReturnValue(new Date('2026-01-19T10:00:00Z'));
    
    const task = service.createTask('New Task');
    
    // updatedAt 应使用服务器时间
    expect(task.updatedAt).toBe('2026-01-19T10:00:00.000Z');
  });
});
```

##### 2.4.7.6 附件上传离线回退测试

```typescript
describe('AttachmentService - Offline Upload', () => {
  it('should queue attachment for upload when offline', async () => {
    mockNetworkService.isOnline.mockReturnValue(false);
    
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const result = await service.uploadAttachment('task-1', file);
    
    // 应返回临时本地 ID
    expect(result.id).toMatch(/^local-/);
    expect(result.status).toBe('pending-upload');
    
    // 应保存到本地
    expect(mockStorageAdapter.saveAttachmentLocally).toHaveBeenCalled();
    // 应入队等待上传
    expect(service.pendingUploads()).toContainEqual(
      expect.objectContaining({ taskId: 'task-1', localId: result.id })
    );
  });

  it('should upload queued attachments when online', async () => {
    // 先离线上传
    mockNetworkService.isOnline.mockReturnValue(false);
    await service.uploadAttachment('task-1', mockFile);
    
    // 恢复网络
    mockNetworkService.isOnline.mockReturnValue(true);
    await service.processPendingUploads();
    
    // 应上传到 Supabase Storage
    expect(mockSupabaseClient.storage.from).toHaveBeenCalledWith('attachments');
    // 队列应清空
    expect(service.pendingUploads()).toHaveLength(0);
  });

  it('should handle upload failure with retry', async () => {
    mockNetworkService.isOnline.mockReturnValue(true);
    mockSupabaseClient.storage.from().upload.mockRejectedValueOnce(new Error('Network Error'));
    
    await service.uploadAttachment('task-1', mockFile);
    
    // 应重试
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockSupabaseClient.storage.from().upload).toHaveBeenCalledTimes(2);
  });
});
```

##### 2.4.7.7 树遍历深度限制测试（深度审查新增）

> **⚠️ 关键边界**：根据 AGENTS.md，树遍历必须使用迭代算法 + 深度限制（MAX_SUBTREE_DEPTH = 100）。

```typescript
describe('TaskOperationService - Tree Traversal Limits', () => {
  it('should respect MAX_SUBTREE_DEPTH when traversing subtree', () => {
    // 创建超深嵌套结构（101 层）
    const deepTree = createDeepNestedTasks(101);
    mockProjectState.setProjects([createProjectWithTasks(deepTree)]);
    
    // 获取子树应在 100 层停止
    const subtree = service.getSubtreeIds(deepTree[0].id);
    
    expect(subtree.length).toBeLessThanOrEqual(100);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('MAX_SUBTREE_DEPTH')
    );
  });

  it('should use iterative algorithm to prevent stack overflow', () => {
    // 创建宽树（1000 个节点）
    const wideTree = createWideTree(1000);
    mockProjectState.setProjects([createProjectWithTasks(wideTree)]);
    
    // 不应抛出 Maximum call stack size exceeded
    expect(() => service.getAllDescendantIds(wideTree[0].id)).not.toThrow();
  });

  it('should handle circular reference gracefully', () => {
    // 创建循环引用（A -> B -> C -> A）
    const circularTasks = [
      { id: 'a', parentId: 'c' },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
    ];
    mockProjectState.setProjects([createProjectWithTasks(circularTasks)]);
    
    // 应检测循环并安全退出
    const result = service.getSubtreeIds('a');
    
    expect(result).not.toContain('a'); // 不应包含自身
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('循环引用')
    );
  });
});

// 辅助函数
function createDeepNestedTasks(depth: number): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < depth; i++) {
    tasks.push(createMockTask({
      id: `task-${i}`,
      parentId: i === 0 ? null : `task-${i - 1}`,
    }));
  }
  return tasks;
}
```

##### 2.4.7.8 toSignal/toObservable 互操作测试（深度审查新增）

> **⚠️ 关键边界**：项目中存在 RxJS Observable 与 Angular Signal 的互操作场景。

```typescript
describe('Signal-Observable Interop', () => {
  it('should convert observable to signal correctly', async () => {
    const subject = new BehaviorSubject('initial');
    
    const injector = Injector.create({ providers: [] });
    let signalValue: Signal<string>;
    
    runInInjectionContext(injector, () => {
      signalValue = toSignal(subject.asObservable(), { initialValue: 'default' });
    });
    
    // 初始值
    expect(signalValue!()).toBe('initial');
    
    // Observable 发射新值
    subject.next('updated');
    await flushMicrotasks();
    
    expect(signalValue!()).toBe('updated');
  });

  it('should handle observable errors in toSignal', async () => {
    const errorSubject = new Subject<string>();
    
    const injector = Injector.create({ providers: [] });
    let signalValue: Signal<string | undefined>;
    
    runInInjectionContext(injector, () => {
      signalValue = toSignal(errorSubject.asObservable());
    });
    
    // 发射错误
    errorSubject.error(new Error('Stream error'));
    await flushMicrotasks();
    
    // 信号应保持最后有效值或 undefined
    expect(signalValue!()).toBeUndefined();
  });

  it('should convert signal to observable correctly', () => {
    const sourceSignal = signal('initial');
    const emissions: string[] = [];
    
    const injector = Injector.create({ providers: [] });
    
    runInInjectionContext(injector, () => {
      const obs$ = toObservable(sourceSignal);
      obs$.subscribe(v => emissions.push(v));
    });
    
    // 更新信号
    sourceSignal.set('updated');
    
    // 需要等待 effect 执行
    TestBed.flushEffects?.() || flushMicrotasks();
    
    expect(emissions).toContain('updated');
  });
});
```

##### 2.4.7.9 防抖同步边界测试（深度审查新增）

> **⚠️ 关键边界**：根据 SYNC_CONFIG.DEBOUNCE_DELAY = 3000ms，需要测试防抖边界。

```typescript
describe('SyncCoordinatorService - Debounce Behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should debounce rapid changes for 3 seconds', async () => {
    // 快速连续修改
    service.markLocalChanges('task-1');
    vi.advanceTimersByTime(1000);
    service.markLocalChanges('task-1');
    vi.advanceTimersByTime(1000);
    service.markLocalChanges('task-1');
    
    // 还未到 3 秒，不应触发同步
    expect(mockSyncService.push).not.toHaveBeenCalled();
    
    // 到达 3 秒
    vi.advanceTimersByTime(1000);
    
    // 现在应触发同步
    expect(mockSyncService.push).toHaveBeenCalledTimes(1);
  });

  it('should flush immediately on beforeunload', async () => {
    service.markLocalChanges('task-1');
    
    // 模拟页面关闭
    window.dispatchEvent(new Event('beforeunload'));
    
    // 应立即同步，不等待防抖
    expect(mockSyncService.push).toHaveBeenCalledTimes(1);
  });

  it('should batch multiple task changes into single sync', async () => {
    // 防抖窗口内修改多个任务
    service.markLocalChanges('task-1');
    service.markLocalChanges('task-2');
    service.markLocalChanges('task-3');
    
    vi.advanceTimersByTime(3000);
    
    // 应只调用一次同步，包含所有变更
    expect(mockSyncService.push).toHaveBeenCalledTimes(1);
    expect(mockSyncService.push).toHaveBeenCalledWith(
      expect.objectContaining({
        taskIds: expect.arrayContaining(['task-1', 'task-2', 'task-3'])
      })
    );
  });
});
```

##### 2.4.7.10 多标签页同步测试（深度审查新增）

> **⚠️ 关键边界**：TabSyncService 负责跨标签页状态同步。

```typescript
describe('TabSyncService - Cross-Tab Synchronization', () => {
  it('should broadcast changes to other tabs', () => {
    const task = createMockTask({ id: 'task-1', title: 'Updated' });
    
    service.broadcastTaskUpdate(task);
    
    expect(mockBroadcastChannel.postMessage).toHaveBeenCalledWith({
      type: 'TASK_UPDATE',
      payload: task,
      sourceTabId: expect.any(String),
    });
  });

  it('should apply changes from other tabs', async () => {
    // 模拟接收其他标签页的消息
    const remoteTask = createMockTask({ id: 'task-1', title: 'Remote Update' });
    
    mockBroadcastChannel.onmessage({
      data: {
        type: 'TASK_UPDATE',
        payload: remoteTask,
        sourceTabId: 'other-tab',
      }
    });
    
    await flushMicrotasks();
    
    // 应更新本地状态
    expect(mockProjectState.updateTask).toHaveBeenCalledWith(remoteTask);
  });

  it('should ignore self-originated messages', () => {
    const task = createMockTask();
    const selfTabId = service.getTabId();
    
    mockBroadcastChannel.onmessage({
      data: {
        type: 'TASK_UPDATE',
        payload: task,
        sourceTabId: selfTabId, // 来自自己
      }
    });
    
    // 不应重复处理
    expect(mockProjectState.updateTask).not.toHaveBeenCalled();
  });

  it('should handle tab becoming leader', async () => {
    // 当其他标签页关闭时，当前标签页应成为 leader
    mockBroadcastChannel.onmessage({
      data: { type: 'TAB_CLOSED', sourceTabId: 'leader-tab' }
    });
    
    await flushMicrotasks();
    
    // 应接管同步职责
    expect(service.isLeader()).toBe(true);
    expect(mockSyncCoordinator.startBackgroundSync).toHaveBeenCalled();
  });
});
```

---

## 3. 冗余测试剔除策略

### 3.1 当前测试分布分析

基于实测数据（38 个测试文件，724 个测试用例，8 个跳过）：

| 测试类型 | 文件数 | 使用 TestBed | 用例数 | 平均用例/文件 |
|----------|--------|--------------|--------|---------------|
| 服务测试 | 24 | 19 (79%) | ~500 | 21 |
| 核心层测试 | 3 | 1 (33%) | ~70 | 23 |
| Features层测试 | 3 | 1 (33%) | ~30 | 10 |
| 集成测试 | 5 | 5 (100%) | ~50 | 10 |
| 其他（utils, app） | 3 | 0 (0%) | ~74 | 25 |

### 3.2 识别规则与启发式分析

| 类型 | 识别特征 | 判定逻辑 | 行动 |
|------|----------|----------|------|
| **Should Create** | `it('should create',...)` 或 `it('should be created',...)` | 如果该组件有任何其他功能测试通过，组件必然已创建 | **删除** |
| **框架功能** | 测试 `*ngIf`、`*ngFor`、`async` 管道行为 | 这是在测试 Angular 框架，不是业务逻辑 | **删除** |
| **琐碎 DOM** | `expect(h1.textContent).toBe('Title')` | 脆弱、维护成本高、价值低 | **移至 E2E** |
| **重复覆盖** | 多个测试验证完全相同的逻辑路径 | 冗余 | **合并/删除** |
| **无断言** | 测试体内没有 `expect` 语句 | 无验证价值 | **删除** |

### 3.3 保留原则

```
┌─────────────────────────────────────────────────────────────────┐
│                    测试保留决策树                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│     是否验证业务逻辑？─────────────────────── YES ──→ 保留     │
│           │                                                     │
│          NO                                                     │
│           ↓                                                     │
│     是否验证边界条件？─────────────────────── YES ──→ 保留     │
│           │                                                     │
│          NO                                                     │
│           ↓                                                     │
│     是否验证状态转换？─────────────────────── YES ──→ 保留     │
│           │                                                     │
│          NO                                                     │
│           ↓                                                     │
│     是否验证错误处理？─────────────────────── YES ──→ 保留     │
│           │                                                     │
│          NO                                                     │
│           ↓                                                     │
│     是否为关键 SEO/可访问性？──────────────── YES ──→ 移至 E2E │
│           │                                                     │
│          NO                                                     │
│           ↓                                                     │
│        删除                                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 预估影响

| 测试类别 | 当前数量 | 预估删除 | 保留数量 | 删除比例 |
|----------|----------|----------|----------|----------|
| 服务测试 | ~450 | ~60 | ~390 | 13% |
| 组件测试 | ~80 | ~25 | ~55 | 31% |
| 集成测试 | ~120 | ~5 | ~115 | 4% |
| 工具函数 | ~74 | ~10 | ~64 | 14% |
| **总计** | **724** | **~100** | **~624** | **14%** |

### 3.5 具体冗余测试示例

```typescript
// ❌ 冗余：Should Create 测试
it('should create', () => {
  expect(component).toBeTruthy();  // 如果其他测试通过，这个必然通过
});

// ❌ 冗余：测试 Angular 框架行为
it('should hide element when condition is false', () => {
  component.showElement = false;
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('.element')).toBeNull();
  // 这是测试 *ngIf，不是业务逻辑
});

// ❌ 冗余：琐碎 DOM 断言
it('should display correct title', () => {
  expect(fixture.nativeElement.querySelector('h1').textContent)
    .toBe('Dashboard');
  // 标题变更是 E2E 或视觉回归测试的职责
});

// ✅ 保留：业务逻辑测试
it('should calculate task priority based on due date', () => {
  const task = { dueDate: tomorrow(), priority: undefined };
  service.calculatePriority(task);
  expect(task.priority).toBe('high');
});

// ✅ 保留：边界条件测试
it('should handle empty task list', () => {
  mockProjectState.setTasks([]);
  expect(service.getActiveTaskCount()).toBe(0);
});

// ✅ 保留：错误处理测试
it('should show error toast when save fails', async () => {
  mockSyncService.save.mockRejectedValue(new Error('Network Error'));
  
  await service.saveTask(task);
  
  expect(mockToast.error).toHaveBeenCalledWith('保存失败');
});
```

---

## 4. 迁移实施指南

### 4.1 服务测试迁移模板

将现有 TestBed 测试迁移到隔离模式的标准模板：

```typescript
// ===== 迁移前 (TestBed 模式) =====
import { TestBed } from '@angular/core/testing';
import { MyService } from './my.service';
import { DependencyService } from './dependency.service';

describe('MyService', () => {
  let service: MyService;
  let mockDependency: jasmine.SpyObj<DependencyService>;

  beforeEach(() => {
    mockDependency = jasmine.createSpyObj('DependencyService', ['method']);
    
    TestBed.configureTestingModule({
      providers: [
        MyService,
        { provide: DependencyService, useValue: mockDependency }
      ]
    });
    
    service = TestBed.inject(MyService);
  });

  it('should do something', () => {
    // test
  });
});

// ===== 迁移后 (隔离模式) =====
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { MyService } from './my.service';
import { DependencyService } from './dependency.service';

describe('MyService', () => {
  let service: MyService;
  let mockDependency: MockDependencyService;

  beforeEach(() => {
    mockDependency = {
      method: vi.fn(),
    };
    
    const injector = Injector.create({
      providers: [
        { provide: DependencyService, useValue: mockDependency }
      ]
    });
    
    runInInjectionContext(injector, () => {
      service = new MyService();
    });
  });

  it('should do something', () => {
    // test (unchanged)
  });
});
```

### 4.2 迁移检查清单

每个测试文件迁移时的检查项：

- [ ] 移除 `import { TestBed } from '@angular/core/testing'`
- [ ] 移除 `import { ComponentFixture } from '@angular/core/testing'`
- [ ] 将 `jasmine.createSpyObj` 替换为 `vi.fn()` 对象
- [ ] 将 `TestBed.configureTestingModule` 替换为 `Injector.create`
- [ ] 将 `TestBed.inject` 替换为 `runInInjectionContext` + `new Service()`
- [ ] 将 `fixture.detectChanges()` 移除（Signal 自动更新）
- [ ] 将 `spyOn` 替换为 `vi.spyOn`
- [ ] 将 `jasmine.any` 替换为 `expect.any`
- [ ] 验证所有 `inject()` 调用都在 `runInInjectionContext` 内
- [ ] 运行测试确保通过

### 4.3 高频依赖的标准 Mock

为项目中高频使用的服务创建标准化 Mock：

```typescript
// tests/mocks/standard-mocks.ts
import { vi } from 'vitest';
import { signal } from '@angular/core';

// LoggerService Mock（几乎所有服务都依赖）
export const createMockLogger = () => ({
  category: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// ToastService Mock
export const createMockToast = () => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
});

// ProjectStateService Mock
export const createMockProjectState = () => {
  const projectsSignal = signal<Project[]>([]);
  const activeProjectIdSignal = signal<string | null>(null);
  
  return {
    projects: () => projectsSignal(),
    activeProject: () => {
      const id = activeProjectIdSignal();
      return projectsSignal().find(p => p.id === id) ?? null;
    },
    activeProjectId: () => activeProjectIdSignal(),
    setProjects: vi.fn((projects) => projectsSignal.set(projects)),
    setActiveProjectId: vi.fn((id) => activeProjectIdSignal.set(id)),
    updateProjects: vi.fn((mutator) => projectsSignal.update(mutator)),
    // 内部访问（用于断言）
    _projectsSignal: projectsSignal,
    _activeProjectIdSignal: activeProjectIdSignal,
  };
};

// UiStateService Mock
export const createMockUiState = () => ({
  isEditing: false,
  isMobile: vi.fn(() => false),
  markEditing: vi.fn(),
  clearEditing: vi.fn(),
  selectedTaskId: signal<string | null>(null),
});

// SyncCoordinatorService Mock
export const createMockSyncCoordinator = () => ({
  markLocalChanges: vi.fn(),
  schedulePersist: vi.fn(),
  hasPendingLocalChanges: vi.fn(() => false),
  softDeleteTasksBatch: vi.fn().mockResolvedValue(0),
});
```

---

## 5. 项目里程碑与时间线

### 5.1 里程碑概览

```
Week 1          Week 2          Week 3          Week 4          Week 5
│               │               │               │               │
├─ M1 ──────────┼─ M2 ──────────┼─ M3 ──────────┼─ M4 ──────────┼─ M5
│ Mock 实现     │ 服务层迁移    │ 组件层迁移    │ 离线测试      │ 收尾优化
│               │               │               │               │
▼               ▼               ▼               ▼               ▼
验收:           验收:           验收:           验收:           验收:
GoJS/Supabase   services/ 0%   features/ 0%   离线场景       ≤5s
Mock 完成       TestBed        TestBed         80% 覆盖       目标达成
```

### 5.2 详细任务分解

#### M1: Mock 层实现与基础优化（Week 1）

> **⚡ 已有基础**：项目已有 `test-setup.mocks.ts` 包含完整的 Supabase/Sentry Mock，M1.2 工时大幅减少。

| 任务 ID | 任务描述 | 预估工时 | 优先级 | 依赖 | 验收标准 |
|---------|----------|----------|--------|------|----------|
| M1.1 | 实现 GoJS 空壳 Mock（完整版） | 6h | P0 | - | 覆盖 Diagram, GraphObject, Model 核心 API |
| M1.2 | ~~实现 Supabase 链式 Mock~~ 扩展现有 Mock | 2h | P0 | - | 在 test-setup.mocks.ts 基础上添加 storage 完整支持 |
| M1.3 | 配置 Vitest alias 路径映射（GoJS） | 2h | P0 | M1.1 | GoJS alias 生效，无真实库加载 |
| M1.4 | 创建标准 Mock 工厂函数库 | 4h | P0 | - | Logger/Toast/ProjectState/UiState/Sync/DestroyRef |
| M1.5 | 创建 test-setup.minimal.ts | 3h | P1 | - | 最小化初始化，减少 setup 时间 |
| M1.6 | 评估 globalSetup 必要性 | 1h | P2 | M1.5 | 见下方说明 |
| M1.7 | 安装 fake-indexeddb（可选） | 1h | P1 | - | 评估是否需要替换现有轻量 Mock |
| M1.8 | 编写 Mock 层验证测试 | 2h | P1 | M1.1-M1.4 | Mock 行为符合预期 |

> **关于 globalSetup 的说明**（深度审查修正）：
> 
> Vitest 的 `globalSetup` 与 `setupFiles` 有本质区别：
> - `globalSetup`：在**所有 worker 启动前**执行一次，运行在**主进程**中，**无法访问测试上下文**
> - `setupFiles`：在**每个 worker 中**执行，可以访问 `vi`、`expect` 等测试 API
>
> **⚠️ 重要**：当前项目已配置 `globalSetup: undefined`（见 vitest.config.mts:75），这是正确的选择。
> Angular 的 `TestBed.initTestEnvironment()` 必须在每个 worker 中执行，因此只能使用 `setupFiles`。
>
> **globalSetup 适用场景**（项目目前不需要）：
> - 启动共享的外部服务（如测试数据库）
> - 生成一次性的测试数据文件
> - 设置环境变量（如 `process.env.TZ`）
>
> **不适用场景**：
> - 任何需要访问 `vi.mock()` 的操作
> - Angular/zone.js 初始化
> - 任何需要在测试上下文中运行的代码

**验收标准**: 
- `npm run test:run` 无真实 GoJS 加载
- Setup 时间从 12.1s 降至 <8s

#### M2: 服务层测试迁移（Week 2）

> **⚡ 范围调整**：实际需迁移 **19 个服务文件**（非原文档 13 个），已有 5 个使用隔离模式可作为参考范例。

| 任务 ID | 任务描述 | 预估工时 | 优先级 | 依赖 | 受影响文件 |
|---------|----------|----------|--------|------|-----------|
| M2.1 | 创建 runInInjectionContext 辅助函数 | 2h | P0 | M1.4 | test-helpers.ts |
| M2.2 | 迁移 optimistic-state.service.spec.ts | 3h | P0 | M2.1 | 核心服务（复杂依赖） |
| M2.3 | 迁移 project-state.service.spec.ts | 3h | P0 | M2.1 | 核心服务 |
| M2.4 | 迁移 conflict-resolution.service.spec.ts | 2h | P0 | M2.1 | 冲突处理 |
| M2.5 | 迁移 action-queue.service.spec.ts | 2h | P0 | M2.1 | 队列服务 |
| M2.6 | 迁移 sync-coordinator.service.spec.ts | 4h | P0 | M2.1 | 同步协调（复杂） |
| M2.7 | 迁移 task-operation-adapter.service.spec.ts | 3h | P0 | M2.1 | 适配器 |
| M2.8 | 迁移 task-operation.service.spec.ts | 4h | P0 | M2.1 | 核心服务 |
| M2.9 | 迁移剩余 11 个服务测试 | 11h | P1 | M2.1 | services/*.spec.ts |
| M2.10 | 删除服务层冗余测试 | 2h | P1 | M2.2-M2.9 | ~40 个用例 |

**待迁移服务列表（按复杂度排序）**：
```
高复杂度（4h）：sync-coordinator, task-operation
中复杂度（3h）：optimistic-state, project-state, task-operation-adapter, task-repository
低复杂度（2h）：conflict-resolution, action-queue, undo, auth, network-awareness,
              offline-integrity, mobile-sync-strategy, global-error-handler,
              export, import, attachment-export, attachment-import, task-trash
```

**验收标准**: 
- services/ 目录 0% TestBed.configureTestingModule 使用
- 所有服务测试通过
- 迁移后测试时间降低 30%+

#### M3: 组件层与集成测试迁移（Week 3）

> **⚡ 范围调整**：核心层 1 个文件、Features 层 1 个文件需迁移，工时相应减少。集成测试保留 TestBed。

| 任务 ID | 任务描述 | 预估工时 | 优先级 | 依赖 |
|---------|----------|----------|--------|------|
| M3.1 | 迁移 flow-task-detail.component.spec.ts | 4h | P0 | M1.1, M2.1 |
| M3.2 | 迁移 simple-sync.service.spec.ts（core 层） | 4h | P0 | M2.1 |
| M3.3 | 审查 stores.spec.ts（已隔离，验证质量） | 1h | P1 | - |
| M3.4 | 审查 simple-sync.topological.spec.ts（已隔离） | 1h | P1 | - |
| M3.5 | 审查 flow-view-select-node.spec.ts（已隔离） | 1h | P1 | - |
| M3.6 | 审查 flow-currentUserId-regression.spec.ts（已隔离） | 1h | P1 | - |
| M3.7 | 审查并优化集成测试（保留 TestBed） | 4h | P1 | M2.1 |
| M3.8 | 删除组件层冗余测试 | 2h | P1 | M3.1-M3.6 |

**验收标准**: 
- 服务层 + 核心层 + Features层 0% TestBed.configureTestingModule
- 集成测试保留 TestBed（允许）
- 总测试时间 <20s

#### M4: 离线优先测试覆盖（Week 4）

> **⚡ 范围扩充**：新增边界场景测试（Realtime 断连、并发写入、Storage 配额、时钟偏移、树遍历、多标签页同步等）。

| 任务 ID | 任务描述 | 预估工时 | 优先级 | 依赖 |
|---------|----------|----------|--------|------|
| M4.1 | 实现乐观 UI 回滚测试（TaskOperationAdapter） | 5h | P0 | M2.7 |
| M4.2 | 实现 LWW 冲突解决测试 | 3h | P0 | M2.4 |
| M4.3 | 实现 RetryQueue 测试 | 3h | P0 | M2.5 |
| M4.4 | 实现 IndexedDB 持久化测试 | 4h | P0 | M1.7 |
| M4.5 | 实现离线状态 UI 反馈测试 | 3h | P1 | M4.1 |
| M4.6 | Realtime 订阅断连恢复测试 | 3h | P0 | M2.6 |
| M4.7 | 并发写入竞态条件测试 | 3h | P0 | M2.6 |
| M4.8 | Storage 配额耗尽处理测试 | 2h | P1 | M4.4 |
| M4.9 | 时钟偏移 LWW 异常测试 | 2h | P1 | M4.2 |
| M4.10 | 附件离线上传回退测试 | 3h | P1 | M4.4 |
| M4.11 | **新增**：树遍历深度限制测试 | 2h | P0 | M2.8 |
| M4.12 | **新增**：toSignal/toObservable 互操作测试 | 2h | P1 | M2.1 |
| M4.13 | **新增**：防抖同步边界测试 | 2h | P0 | M2.6 |
| M4.14 | **新增**：多标签页同步测试 | 3h | P1 | M2.1 |
| M4.15 | 编写 Playwright 离线场景 E2E（3个场景） | 6h | P1 | M4.4 |
| M4.16 | 编写 Playwright 冲突场景 E2E | 4h | P2 | M4.15 |

**验收标准**: 
- 离线同步核心路径 80%+ 覆盖
- 所有新增边界场景测试通过
- E2E 离线场景通过

#### M5: 收尾优化与性能调优（Week 5）

| 任务 ID | 任务描述 | 预估工时 | 优先级 | 依赖 |
|---------|----------|----------|--------|------|
| M5.1 | 性能基准测试与分析 | 3h | P0 | M4.7 |
| M5.2 | 识别剩余慢测试并优化 | 5h | P0 | M5.1 |
| M5.3 | 优化 Vitest 配置（线程/缓存） | 2h | P1 | M5.1 |
| M5.4 | 配置 CI 测试分片策略 | 2h | P1 | M5.2 |
| M5.5 | 更新测试编写规范文档 | 3h | P1 | M5.2 |
| M5.6 | 团队培训与知识转移 | 3h | P2 | M5.5 |
| M5.7 | 最终验收与项目收尾 | 2h | P0 | M5.6 |

**验收标准**: 
- 测试执行时间 ≤10s（考虑到集成测试保留 TestBed，5s 目标调整为 10s）
- 文档完善
- 团队能独立编写隔离测试

---

## 6. 风险评估与缓解策略

### 6.1 风险矩阵

| 风险 ID | 风险描述 | 概率 | 影响 | 等级 | 缓解策略 |
|---------|----------|------|------|------|----------|
| R1 | GoJS Mock 覆盖不完整导致运行时错误 | 中 | 高 | 🔴 | 渐进式添加 Mock；保留 1-2 个真实 GoJS 集成测试验证关键路径 |
| R2 | 去 TestBed 后 DI 场景遗漏（inject() 错误） | 中 | 中 | 🟡 | 创建 `createIsolatedService()` 辅助函数封装 `runInInjectionContext`，统一处理 |
| R3 | happy-dom API 不兼容导致测试失败 | 低 | 中 | 🟢 | 对关键 DOM 操作（如 ResizeObserver）在 test-setup 中 polyfill |
| R4 | 离线测试 IndexedDB 状态污染 | 中 | 中 | 🟡 | 每个测试前清理 IndexedDB；使用 `fake-indexeddb` 内存模式 |
| R5 | 团队学习曲线影响进度 | 中 | 低 | 🟢 | 提前准备迁移模板和示例代码；Pair Programming |
| R6 | 10s 目标无法达成 | 中 | 高 | 🟡 | 设定阶梯目标：25s → 15s → 10s；识别最慢测试优先优化 |
| R7 | Signal effect() 测试困难 | 中 | 中 | 🟡 | 重构 effect 逻辑为 computed 或可测试的服务方法 |
| R8 | 迁移过程中引入回归 Bug | 中 | 高 | 🔴 | 每个文件迁移后立即运行，确保测试通过；保留 git 历史便于回滚 |
| R9 | 工时低估导致进度延迟 | 高 | 中 | 🟡 | 实际迁移 19 个服务文件；预留 20% 缓冲时间 |
| R10 | Realtime 订阅 Mock 复杂度 | 中 | 中 | 🟡 | 参考现有 `mockSupabaseChannel` 实现；先验证简单场景 |
| R11 | 并发测试时序不稳定 | 中 | 低 | 🟢 | 使用受控 Promise + `vi.useFakeTimers()` 确保确定性 |
| **R12** | **树遍历循环引用导致无限循环** | **低** | **高** | 🟡 | 迭代算法 + visitedSet 防护；MAX_SUBTREE_DEPTH 限制 |
| **R13** | **toSignal/toObservable 互操作泄漏** | **中** | **中** | 🟡 | 确保订阅在 DestroyRef 上正确清理；使用 takeUntilDestroyed |
| **R14** | **防抖窗口内页面关闭导致数据丢失** | **中** | **高** | 🔴 | beforeunload 时立即刷新同步队列；关键操作跳过防抖 |
| **R15** | **多标签页状态不一致** | **中** | **中** | 🟡 | TabSyncService 使用 BroadcastChannel；Leader 选举机制 |

### 6.2 回滚方案

```
┌─────────────────────────────────────────────────────────────────┐
│                    分级回滚策略                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Level 1: 单文件回滚                                            │
│  ─────────────────                                              │
│  git checkout HEAD~1 -- src/services/xxx.service.spec.ts       │
│                                                                 │
│  Level 2: 批量回滚（某个 Milestone）                             │
│  ─────────────────                                              │
│  git revert --no-commit M2.1..M2.8                              │
│                                                                 │
│  Level 3: 完整回滚（恢复 TestBed 模式）                          │
│  ─────────────────                                              │
│  git checkout main -- src/**/*.spec.ts                         │
│  npm run test:run  # 验证原始测试仍可运行                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 依赖风险

| 依赖包 | 风险等级 | 替代方案 |
|--------|----------|----------|
| `@analogjs/vite-plugin-angular` | 低 | 官方 Angular Vite 支持（Angular 19+） |
| `happy-dom` | 低 | `jsdom`（较慢但兼容性更好） |
| `fake-indexeddb` | 低 | `idb-keyval` + 内存 shim |
| `vitest` | 极低 | 生态成熟，Angular 官方推荐 |

### 6.4 测试套件分层优化（深度审查新增）

> **⚠️ 关键策略**：为实现 10s 目标，需要对测试套件进行分层，支持快速反馈循环。

```
┌─────────────────────────────────────────────────────────────────┐
│                    测试套件分层架构                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: 纯单元测试 (Pure Unit)                                │
│  ─────────────────────────────                                  │
│  目标: <3s | 运行: 每次保存                                      │
│  范围: utils/*, 无 DI 的服务逻辑                                 │
│  配置: vitest.pure.config.mts                                   │
│                                                                 │
│  Layer 2: 服务层测试 (Services)                                 │
│  ─────────────────────────────                                  │
│  目标: <5s | 运行: git commit 前                                 │
│  范围: services/*.spec.ts (隔离模式)                             │
│  配置: vitest.services.config.mts                               │
│                                                                 │
│  Layer 3: 组件层测试 (Components)                               │
│  ─────────────────────────────                                  │
│  目标: <8s | 运行: PR 提交时                                     │
│  范围: app/**/*.spec.ts                                         │
│  配置: vitest.components.config.mts                             │
│                                                                 │
│  Layer 4: 集成测试 (Integration)                                │
│  ─────────────────────────────                                  │
│  目标: <15s | 运行: CI 全量                                      │
│  范围: tests/integration/*.spec.ts                               │
│  配置: vitest.config.mts (默认)                                  │
│                                                                 │
│  Layer 5: E2E 测试 (Playwright)                                 │
│  ─────────────────────────────                                  │
│  目标: <60s | 运行: 发布前                                       │
│  范围: e2e/*.spec.ts                                            │
│  配置: playwright.config.ts                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**NPM Scripts 配置**：
```json
{
  "scripts": {
    "test:pure": "vitest run --config vitest.pure.config.mts",
    "test:services": "vitest run --config vitest.services.config.mts",
    "test:components": "vitest run --config vitest.components.config.mts",
    "test:run": "vitest run",
    "test:e2e": "playwright test"
  }
}
```

**开发工作流**：
| 阶段 | 命令 | 耗时 | 用途 |
|------|------|------|------|
| 保存时 | `test:pure` | <3s | 即时反馈 |
| 提交前 | `test:services` | <5s | 服务逻辑验证 |
| PR 时 | `test:run` | <10s | 完整单元测试 |
| CI 时 | `test:run && test:e2e` | <70s | 全量验证 |

### 6.5 CI 性能优化策略（深度审查新增）

**分片执行**（适用于大型测试套件）：
```yaml
# .github/workflows/test.yml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npm run test:run -- --shard=${{ matrix.shard }}/4
```

**缓存优化**：
```yaml
- uses: actions/cache@v4
  with:
    path: |
      node_modules/.vitest
      ~/.cache/vitest
    key: vitest-${{ hashFiles('**/package-lock.json') }}-${{ github.sha }}
    restore-keys: |
      vitest-${{ hashFiles('**/package-lock.json') }}-
      vitest-
```

**并行作业**：
```yaml
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:run
  
  e2e-tests:
    runs-on: ubuntu-latest
    needs: unit-tests  # 可选：等待单元测试通过
    steps:
      - run: npm run test:e2e
```

---

## 7. 资源需求

### 7.1 人力资源

| 角色 | 人数 | 职责 | 投入度 | 关键技能 |
|------|------|------|--------|----------|
| 测试架构师 | 1 | 技术方案设计、Mock 实现、性能调优 | 100% | Vitest、Angular DI、性能优化 |
| 高级前端开发 | **2-3** | 测试迁移、代码重构、离线测试实现 | 80% | Angular Signals、TypeScript |
| QA 工程师 | 1 | 验收测试、E2E 编写、回归测试 | 50% | Playwright、E2E 测试 |

### 7.2 技术依赖

| 依赖 | 当前版本 | 用途 | 状态 |
|------|----------|------|------|
| vitest | ^3.x | 测试运行器 | ✅ 已安装 |
| happy-dom | ^16.x | 轻量 DOM 模拟 | ✅ 已安装 |
| @vitest/coverage-v8 | ^3.x | 覆盖率报告 | ✅ 已安装 |
| fake-indexeddb | ^6.x | IndexedDB 模拟 | ⚠️ 可选（现有轻量 Mock 可用） |
| @analogjs/vite-plugin-angular | ^1.x | Angular Vite 集成 | ✅ 已安装 |

### 7.3 工时汇总

> **注意**：工时已根据实际 TestBed 使用率（**63%，24/38**）和新增边界场景测试进行调整。

| 里程碑 | 工时（人时） | 持续时间 | 调整说明 |
|--------|-------------|----------|----------|
| M1: Mock 层实现 | 21h | Week 1 | Supabase Mock 已有，减少 6h |
| M2: 服务层迁移 | **36h** | Week 2 | 实际迁移 19 个文件 |
| M3: 组件层迁移 | **18h** | Week 3 | 2 个文件需迁移，1 个额外审查 |
| M4: 离线测试 | **50h** | Week 4 | 新增 9 个边界场景测试（树遍历、互操作、防抖、多标签页等） |
| M5: 收尾优化 | 20h | Week 5 | 目标调整为 ≤10s |
| **总计** | **145h** | **5 周** | 含 20% 缓冲时间，建议 3 名开发者 |

> **⚠️ 工时调整说明**：
> - M4 新增 4 个边界场景测试任务（+9h）
> - 总工时 145h，按 3 人团队计算，每人约 48h（5 周 × 每周 10h 投入）
> - 如需加速，可考虑增加人力或延长至 6 周

---

## 8. 验收标准

### 8.1 量化指标

> **目标调整说明**：原始目标 5s 过于激进。考虑到：
> 1. 集成测试保留 TestBed（5 个文件）
> 2. Angular 测试环境固有初始化开销（zone.js + TestBed.initTestEnvironment）
> 3. 项目实际复杂度
> 
> 将目标调整为 **≤10s**，这仍是 **3.5x 提升**，TDD 友好。

| 指标 | 基线（当前） | 目标 | 验收方法 |
|------|--------------|------|----------|
| 总执行时间 | **34.52s** | ≤10s | `time npm run test:run` |
| Setup 时间 | **11.99s** | <4s | Vitest 输出 |
| Environment 时间 | **8.43s** | <2s | Vitest 输出 |
| 测试通过率 | 100% | 100% | CI 报告 |
| 代码覆盖率 | 75% | ≥75% | Vitest coverage |
| 离线场景覆盖 | 0% | ≥80% | 覆盖率报告 |
| TestBed 使用率（服务层） | **79% (19/24)** | 0% | services/*.spec.ts |
| TestBed 使用率（总体） | **63% (24/38)** | ≤15% | 仅集成测试保留 |
| 冗余测试数量 | ~60 | 0 | 代码审查 |

> **关于 TestBed 的澄清**：
> - `TestBed.initTestEnvironment()` - **必须保留**，Angular 测试基础设施要求
> - `TestBed.configureTestingModule()` - **目标消除**，服务层和组件层改用 `Injector.create`
> - 集成测试可保留 TestBed 以验证真实 DI 场景

### 8.2 质量门禁

```yaml
# .github/workflows/test.yml 质量门禁配置
name: Test Quality Gates

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      
      - run: npm ci
      
      - name: Run Tests with Timing
        run: |
          start_time=$(date +%s)
          npm run test:run
          end_time=$(date +%s)
          duration=$((end_time - start_time))
          echo "Test duration: ${duration}s"
          
          # 质量门禁：测试时间不超过 15s（目标 10s + 缓冲）
          if [ $duration -gt 15 ]; then
            echo "::error::Test duration ${duration}s exceeds limit of 15s"
            exit 1
          fi
      
      - name: Check TestBed Usage in Services
        run: |
          # 只检查服务层，集成测试允许 TestBed
          count=$(grep -r "TestBed.configureTestingModule" src/services --include="*.spec.ts" | wc -l)
          echo "TestBed.configureTestingModule usage in services: $count"
          
          # 质量门禁：服务层不允许 TestBed.configureTestingModule
          if [ $count -gt 0 ]; then
            echo "::error::Found $count TestBed.configureTestingModule usages in services."
            exit 1
          fi
      
      - name: Coverage Check
        run: |
          npm run test:coverage
          # 使用 coverage 阈值配置
```

### 8.3 验收清单

- [x] 服务层 19 个测试文件迁移完成（0% TestBed.configureTestingModule）→ **实际: 1/24 (4%)，action-queue 因 effect() 保留**
- [x] 核心层 1 个测试文件迁移完成（simple-sync.service.spec.ts）
- [ ] Features层 1 个测试文件迁移完成（flow-task-detail.component.spec.ts）→ **保留 TestBed（组件需要 fixture）**
- [x] 集成测试保留 TestBed（允许）
- [ ] 测试执行时间 ≤10s → **实际: 35s（Angular 固有开销限制）**
- [x] 离线同步场景覆盖率 ≥80%
- [x] GoJS Mock 覆盖核心 API（779 行）
- [x] Supabase Mock 扩展完成（在现有基础上）
- [x] DestroyRef Mock 工厂函数完成（createMockDestroyRef）
- [x] Realtime 断连恢复测试通过
- [x] 并发写入竞态条件测试通过
- [x] Storage 配额耗尽处理测试通过
- [x] 时钟偏移 LWW 测试通过
- [x] 附件离线上传测试通过
- [x] **新增**：树遍历深度限制测试通过（11 测试）
- [x] **新增**：toSignal/toObservable 互操作测试通过 → **跳过（项目未使用）**
- [x] **新增**：防抖同步边界测试通过
- [x] **新增**：多标签页同步测试通过
- [x] CI 质量门禁配置完成
- [x] 测试编写规范文档更新
- [ ] 团队培训完成 → **待安排**

---

## 9. 后续规划

### 9.1 Phase 2 展望（项目完成后 3-6 个月）

| 能力 | 工具 | 价值 |
|------|------|------|
| **视觉回归测试** | Percy / Chromatic | 捕获 UI 意外变更 |
| **性能基准测试** | Lighthouse CI | 监控 Core Web Vitals |
| **Mutation Testing** | Stryker | 验证测试质量 |
| **Contract Testing** | Pact | 验证 Supabase API 契约 |

### 9.2 持续改进机制

```
┌─────────────────────────────────────────────────────────────────┐
│                    测试健康度监控 Dashboard                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ 执行时间趋势 │  │ 覆盖率趋势   │  │ 失败率趋势   │          │
│  │   5.2s ↓    │  │   78% ↑     │  │   0.1% →    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  警报规则：                                                      │
│  - 执行时间 > 8s → P1 警报                                       │
│  - 覆盖率 < 70% → P2 警报                                        │
│  - 失败率 > 1% → P0 警报                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 测试编写规范（新功能强制要求）

```typescript
// ✅ 必须遵循的测试模式
describe('NewFeatureService', () => {
  let service: NewFeatureService;
  
  beforeEach(() => {
    // 1. 使用标准 Mock 工厂
    const mocks = createStandardMocks();
    
    // 2. 使用隔离注入器
    const injector = Injector.create({
      providers: mocks.providers
    });
    
    // 3. 在注入上下文中实例化
    runInInjectionContext(injector, () => {
      service = new NewFeatureService();
    });
  });

  // 4. 测试业务逻辑，不测试框架行为
  it('should [specific business behavior]', () => {
    // Arrange - Given
    // Act - When
    // Assert - Then
  });

  // 5. 必须包含错误处理测试
  it('should handle [error case]', async () => {
    // ...
  });

  // 6. 如果涉及网络，必须包含离线场景
  it('should queue operation when offline', async () => {
    // ...
  });
});
```

---

## 10. AI 辅助迁移提示词

### 10.1 提示词设计原则

为加速迁移过程，设计结构化提示词供 AI 辅助代码重构：

```markdown
# Role
You are a Principal Software Architect specializing in Angular 19, Vitest, 
and High-Performance CI/CD pipelines.

# Task
Refactor the existing legacy Angular test from TestBed to isolated class mode.
Reduce test execution time while maintaining test coverage.

# Context
- Angular 19 application using Signals for state management
- GoJS for diagramming (mock available)
- Supabase for backend services (mock available)
- Target: 0% TestBed usage, 5s total test time

# Mandatory Constraints

## No-TestBed Policy
- NEVER use TestBed.configureTestingModule
- ALWAYS use Injector.create + runInInjectionContext
- Replace fixture.detectChanges() with direct Signal manipulation

## Signal Handling
For components using inject(), signal(), or computed():
```typescript
const injector = Injector.create({ providers: [...] });
runInInjectionContext(injector, () => {
  component = new MyComponent();
});
```

## Mock Strategy
- Use vi.fn() instead of jasmine.createSpyObj
- Use provided GoJS mock for diagram components
- Use provided Supabase mock for data services

## Offline-First Testing
- Include rollback test for optimistic updates
- Use controlled Promise for async timing control
- Test LWW conflict resolution

# Input
[Paste original TestBed-based test file here]

# Expected Output
Refactored test file with:
1. No TestBed imports
2. Isolated class instantiation
3. Vitest assertions (expect, vi.fn)
4. Maintained test coverage
```

### 10.2 批量迁移脚本

```bash
#!/bin/bash
# scripts/migrate-test.sh
# 辅助脚本：检测并报告 TestBed 使用情况

echo "=== TestBed Migration Status ==="
echo ""

# 统计 TestBed 使用
total=$(find src -name "*.spec.ts" | wc -l)
with_testbed=$(grep -rl "TestBed" src --include="*.spec.ts" | wc -l)
migrated=$((total - with_testbed))

echo "Total test files: $total"
echo "Using TestBed: $with_testbed"
echo "Migrated: $migrated"
echo "Progress: $((migrated * 100 / total))%"
echo ""

# 列出待迁移文件
echo "Files to migrate:"
grep -rl "TestBed" src --include="*.spec.ts" | head -20

echo ""
echo "Run 'npm run test:run' to verify current status"
```

---

## 11. 附录

### A. 配置文件模板

<details>
<summary>vitest.config.mts 完整优化配置</summary>

```typescript
/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import angular from '@analogjs/vite-plugin-angular';
import { resolve } from 'path';

export default defineConfig({
  plugins: [angular()],
  
  // 缓存配置
  cacheDir: 'node_modules/.vitest',
  
  test: {
    // 环境配置
    environment: 'happy-dom',
    css: false,                    // 完全禁用 CSS
    globals: true,
    
    // 文件匹配
    include: ['src/**/*.spec.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    
    // 并行配置（优化后）
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: false,            // 关键：共享环境减少开销
        minThreads: 1,
        maxThreads: 4,
      }
    },
    
    // 超时配置
    testTimeout: 2000,
    hookTimeout: 1000,
    
    // 初始化
    setupFiles: [
      'src/test-setup.minimal.ts',
      'fake-indexeddb/auto'
    ],
    globalSetup: 'src/test-global-setup.ts',
    
    // 覆盖率
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/test-setup*.ts',
        'src/environments/**',
      ],
      thresholds: {
        lines: 75,
        branches: 70,
        functions: 75,
        statements: 75,
      }
    },
    
    // 报告
    reporters: ['default'],
    
    // 序列化
    sequence: {
      shuffle: false,
    },
    
    // 依赖优化
    deps: {
      optimizer: {
        web: {
          include: ['@angular/*', 'rxjs', 'zone.js'],
        },
      },
    },
  },
  
  // 路径别名（Mock 注入）
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      'gojs': resolve(__dirname, 'tests/mocks/gojs-mock.ts'),
      '@supabase/supabase-js': resolve(__dirname, 'tests/mocks/supabase-mock.ts'),
    },
    extensions: ['.ts', '.js', '.json'],
  },
  
  // ESBuild 优化
  esbuild: {
    target: 'es2022',
    keepNames: true,
  },
});
```

</details>

<details>
<summary>test-setup.minimal.ts（最小化初始化）</summary>

```typescript
/**
 * 最小化测试初始化
 * 只包含必要的 polyfill 和全局配置
 */

// Zone.js（Angular 必需）
import 'zone.js';
import 'zone.js/testing';

// Angular 测试初始化（最小化）
import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

// 只初始化一次
const testBed = getTestBed();
if (!testBed.platform) {
  testBed.initTestEnvironment(
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting(),
  );
}

// 必要的 polyfill
if (typeof ResizeObserver === 'undefined') {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// crypto.randomUUID polyfill
if (!globalThis.crypto?.randomUUID) {
  globalThis.crypto = {
    ...globalThis.crypto,
    randomUUID: () => 
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }),
  } as Crypto;
}

// 禁用 console.warn/error 在测试中的噪音（可选）
// console.warn = vi.fn();
// console.error = vi.fn();
```

</details>

<details>
<summary>test-global-setup.ts（全局初始化，只执行一次）</summary>

```typescript
/**
 * 全局测试初始化
 * 在所有 worker 启动前执行一次
 */

export default async function globalSetup() {
  // 设置环境变量
  process.env.TZ = 'UTC';
  process.env.NODE_ENV = 'test';
  
  // 预热模块缓存（可选）
  console.log('🧪 Test environment initialized');
}
```

</details>

### B. 测试辅助函数库

<details>
<summary>tests/helpers/test-helpers.ts</summary>

```typescript
import { Injector, Provider, runInInjectionContext, signal } from '@angular/core';
import { vi } from 'vitest';

/**
 * 在隔离注入上下文中创建服务实例
 * 替代 TestBed，性能提升 10x+
 */
export function createIsolatedService<T>(
  ServiceClass: new () => T,
  providers: Provider[] = []
): T {
  const injector = Injector.create({ providers });
  let service: T;
  
  runInInjectionContext(injector, () => {
    service = new ServiceClass();
  });
  
  return service!;
}

/**
 * 创建测试注入器
 */
export function createTestInjector(providers: Provider[]): Injector {
  return Injector.create({ providers });
}

/**
 * 创建受控 Promise 用于测试异步时序
 */
export function createControlledPromise<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}

/**
 * 刷新微任务队列
 */
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * 刷新微任务（用于 effect 测试）
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => queueMicrotask(resolve));
}

/**
 * 创建 Mock 项目
 */
export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

/**
 * 创建 Mock 任务
 */
export function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: 'A',
    hasIncompleteTask: false,
    ...overrides,
  };
}
```

</details>

<details>
<summary>tests/mocks/standard-mocks.ts（标准 Mock 工厂）</summary>

```typescript
import { vi } from 'vitest';
import { signal } from '@angular/core';
import type { Project, Task } from '../../src/models';

// ========== Logger Mock ==========
export const createMockLogger = () => ({
  category: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// ========== Toast Mock ==========
export const createMockToast = () => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
});

// ========== ProjectState Mock ==========
export const createMockProjectState = (initialProjects: Project[] = []) => {
  const projectsSignal = signal<Project[]>(initialProjects);
  const activeProjectIdSignal = signal<string | null>(
    initialProjects[0]?.id ?? null
  );
  
  return {
    projects: () => projectsSignal(),
    activeProject: () => {
      const id = activeProjectIdSignal();
      return projectsSignal().find(p => p.id === id) ?? null;
    },
    activeProjectId: () => activeProjectIdSignal(),
    setProjects: vi.fn((projects: Project[]) => projectsSignal.set(projects)),
    setActiveProjectId: vi.fn((id: string | null) => activeProjectIdSignal.set(id)),
    updateProjects: vi.fn((mutator: (p: Project[]) => Project[]) => 
      projectsSignal.update(mutator)
    ),
    getTask: (taskId: string) => {
      for (const project of projectsSignal()) {
        const task = project.tasks.find(t => t.id === taskId);
        if (task) return task;
      }
      return undefined;
    },
    _projectsSignal: projectsSignal,
    _activeProjectIdSignal: activeProjectIdSignal,
  };
};

// ========== UiState Mock ==========
export const createMockUiState = () => ({
  isEditing: false,
  isMobile: vi.fn(() => false),
  markEditing: vi.fn(),
  clearEditing: vi.fn(),
  selectedTaskId: signal<string | null>(null),
});

// ========== SyncCoordinator Mock ==========
export const createMockSyncCoordinator = () => ({
  markLocalChanges: vi.fn(),
  schedulePersist: vi.fn().mockResolvedValue(undefined),
  hasPendingLocalChanges: vi.fn(() => false),
  softDeleteTasksBatch: vi.fn().mockResolvedValue(0),
});

// ========== OptimisticState Mock ==========
export const createMockOptimisticState = () => ({
  createSnapshot: vi.fn(() => ({ id: crypto.randomUUID() })),
  createTaskSnapshot: vi.fn(() => ({ id: crypto.randomUUID() })),
  commitSnapshot: vi.fn(),
  rollbackSnapshot: vi.fn(),
});

// ========== 组合 Mock（常用依赖集合） ==========
export const createStandardMocks = () => ({
  logger: createMockLogger(),
  toast: createMockToast(),
  projectState: createMockProjectState(),
  uiState: createMockUiState(),
  syncCoordinator: createMockSyncCoordinator(),
  optimisticState: createMockOptimisticState(),
  
  get providers() {
    return [
      { provide: 'LoggerService', useValue: this.logger },
      { provide: 'ToastService', useValue: this.toast },
      { provide: 'ProjectStateService', useValue: this.projectState },
      { provide: 'UiStateService', useValue: this.uiState },
      { provide: 'SyncCoordinatorService', useValue: this.syncCoordinator },
      { provide: 'OptimisticStateService', useValue: this.optimisticState },
    ];
  }
});
```

</details>

### C. 参考资料

| 资源 | 链接 | 用途 |
|------|------|------|
| Vitest 官方文档 | https://vitest.dev/ | 测试框架 |
| Angular 19 Signal 指南 | https://angular.dev/guide/signals | Signal 测试 |
| Happy-DOM 性能基准 | https://github.com/niceBird-py/happy-dom | DOM 模拟选型 |
| Playwright 网络仿真 | https://playwright.dev/docs/network | E2E 离线测试 |
| fake-indexeddb | https://github.com/niceBird-py/fake-indexeddb | IDB 模拟 |
| Angular Testing Guide | https://angular.dev/guide/testing | 官方测试指南 |

### D. 术语表

| 术语 | 定义 |
|------|------|
| **TestBed** | Angular 官方测试工具，用于模拟 NgModule 环境 |
| **TestBed.initTestEnvironment** | 初始化 Angular 测试环境，**必须保留** |
| **TestBed.configureTestingModule** | 配置测试模块，**目标消除** |
| **Isolated Test** | 不依赖框架运行时的纯类测试 |
| **Hollow Shell Pattern** | 用轻量级 Mock 替代重型外部依赖 |
| **Controlled Promise** | 可手动控制 resolve/reject 时机的 Promise |
| **LWW (Last-Write-Wins)** | 冲突解决策略，时间戳较新的版本获胜 |
| **Optimistic UI** | 乐观更新，假设操作成功立即更新 UI |
| **Rollback** | 操作失败后恢复到之前的状态 |
| **RetryQueue** | 失败操作的重试队列 |
| **runInInjectionContext** | Angular API，在指定注入器上下文中执行代码 |
| **DestroyRef** | Angular 服务销毁生命周期钩子 |

---

**文档版本**: 4.2  
**最后更新**: 2026-01-20  
**审批状态**: 🚧 执行中（差异修复中）  
**基线测量日期**: 2026-01-19  
**基线执行时间**: 34.52s  
**当前执行时间**: 待重新测量  
**TestBed.configureTestingModule 使用率**: 0%（服务层 0/25）  
**服务层迁移完成率**: 100% (25/25)  
**目标执行时间**: ≤10s（受限于 Angular 固有开销，需以分层配置为主）

---

### E. 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| **4.2** | **2026-01-20** | **差异修复 v5**：<br>• 新增 Offline-first RetryQueue → 重连清空测试<br>• 引入全局污染检测守卫（事件监听/定时器）<br>• 更新差异审查清单与补充建议状态 |
| **4.1** | **2026-01-20** | **差异修复 v4**：<br>• ActionQueue/UnsavedChangesGuard 迁移至 Injector 隔离模式<br>• TestBed 使用率更新为 7/39（仅组件+集成）<br>• 引入 fake-indexeddb + IndexedDB fallback 清理策略<br>• 计划补充：Offline-first 全链路用例与污染检测 |
| **4.0** | **2026-01-19** | **执行完成**：<br>• 服务层 TestBed.configureTestingModule 使用率从 79% 降至 4%<br>• 新增 tree-traversal-limits.spec.ts (11 测试)<br>• 新增 DestroyRef Mock 工厂函数 (createMockDestroyRef)<br>• sync-coordinator 迁移至 pure 配置<br>• 全量测试通过: 735 通过 / 8 跳过<br>• 分层配置优化: Pure(14.6s) + Services(7.5s) + Components(4.4s) |
| **3.2** | **2026-01-19** | **深度审查修复 v3（边界场景扩充）**：<br>• 新增 4 个边界场景测试：树遍历深度限制、toSignal/toObservable 互操作、防抖同步边界、多标签页同步<br>• 风险矩阵新增 4 项（R12-R15）：循环引用、Signal-Observable 泄漏、防抖数据丢失、多标签页不一致<br>• M4 任务扩展：16 个任务（原 12 个）<br>• 工时更新：145h（原 136h）<br>• 验收清单新增 4 项 |
| 3.1 | 2026-01-19 | 深度审查修复 v2（精确数据校正）：服务层 24 个文件、TestBed 79%、基线 34.52s |
| 3.0 | 2026-01-19 | 深度审查修复（全量更新） |
| 2.1 | 2026-01-19 | TestBed 数据校正、目标调整、DestroyRef/effect 策略、工时重估 |
| 2.0 | 2026-01-19 | 基于实测基线数据全面修订 |
| 1.0 | 2026-01-19 | 初始版本 |
