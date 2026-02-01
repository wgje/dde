<!-- markdownlint-disable-file -->

# Task Details: PWA "Instant Open" 性能优化

## Research Reference

- 研究文件: [20260201-pwa-instant-open-optimization-research.md](.copilot-tracking/research/20260201-pwa-instant-open-optimization-research.md)

---

## Phase 1: Sentry SDK 懒加载 (P0 - 预期收益: -200~300 ms)

### Task 1.1: 创建 Sentry 懒加载服务

**描述**: 创建一个专门的服务来管理 Sentry SDK 的懒加载初始化，确保 Sentry 在首屏渲染完成后才加载。

- **Files**:
  - `src/services/sentry-lazy-loader.service.ts` - 新建 Sentry 懒加载服务
  
- **实现规范**:

```typescript
// src/services/sentry-lazy-loader.service.ts
import { Injectable, signal, computed } from '@angular/core';
import { environment } from '../environments/environment';

/**
 * Sentry 懒加载服务
 * 延迟加载 Sentry SDK 以避免阻塞首屏渲染
 * 
 * 策略：
 * 1. 首屏渲染完成后（requestIdleCallback 或 2s 后备）
 * 2. 动态导入 @sentry/angular
 * 3. 初始化配置
 */
@Injectable({ providedIn: 'root' })
export class SentryLazyLoaderService {
  /** Sentry 模块实例（懒加载后可用） */
  private sentryModule = signal<typeof import('@sentry/angular') | null>(null);
  
  /** Sentry 是否已初始化 */
  readonly isInitialized = computed(() => this.sentryModule() !== null);
  
  /** 待发送的错误队列（初始化前捕获的错误） */
  private pendingErrors: { error: unknown; context?: Record<string, unknown> }[] = [];
  
  /** 初始化 Promise（防止重复初始化） */
  private initPromise: Promise<void> | null = null;

  /**
   * 触发 Sentry 懒加载初始化
   * 使用 requestIdleCallback 确保不阻塞主线程
   */
  triggerLazyInit(): void {
    if (this.initPromise) return;
    
    if (!environment.production && !environment.sentryDsn) {
      console.log('[SentryLazyLoader] 开发环境跳过 Sentry 初始化');
      return;
    }

    const initCallback = () => {
      this.initPromise = this.initSentry();
    };

    // 使用 requestIdleCallback（有 2s 超时后备）
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(initCallback, { timeout: 2000 });
    } else {
      setTimeout(initCallback, 2000);
    }
  }

  /**
   * 异步初始化 Sentry
   */
  private async initSentry(): Promise<void> {
    try {
      const Sentry = await import('@sentry/angular');
      
      Sentry.init({
        dsn: environment.sentryDsn,
        environment: environment.production ? 'production' : 'development',
        release: environment.appVersion,
        integrations: [
          Sentry.browserTracingIntegration(),
          Sentry.replayIntegration({
            maskAllText: false,
            blockAllMedia: false,
          }),
        ],
        tracesSampleRate: environment.production ? 0.1 : 1.0,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
      });
      
      this.sentryModule.set(Sentry);
      
      // 发送队列中的待处理错误
      this.flushPendingErrors();
      
      console.log('[SentryLazyLoader] Sentry 初始化完成');
    } catch (error) {
      console.error('[SentryLazyLoader] Sentry 初始化失败:', error);
    }
  }

  /**
   * 捕获错误（支持初始化前后）
   */
  captureException(error: unknown, context?: Record<string, unknown>): void {
    const sentry = this.sentryModule();
    if (sentry) {
      if (context) {
        sentry.withScope(scope => {
          Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
          });
          sentry.captureException(error);
        });
      } else {
        sentry.captureException(error);
      }
    } else {
      // 加入待处理队列
      this.pendingErrors.push({ error, context });
    }
  }

  /**
   * 发送待处理错误队列
   */
  private flushPendingErrors(): void {
    const sentry = this.sentryModule();
    if (!sentry || this.pendingErrors.length === 0) return;
    
    console.log(`[SentryLazyLoader] 发送 ${this.pendingErrors.length} 个待处理错误`);
    
    this.pendingErrors.forEach(({ error, context }) => {
      this.captureException(error, context);
    });
    
    this.pendingErrors = [];
  }
}
```

- **Success**:
  - 服务文件创建成功
  - 支持 requestIdleCallback 和 setTimeout 后备
  - 支持错误队列（初始化前捕获的错误）
  - 使用 Angular Signals 管理状态

- **Research References**:
  - 研究文件 Lines 215-250 - Sentry SDK 懒加载模式

- **Dependencies**:
  - 无

### Task 1.2: 修改 main.ts 移除同步 Sentry 初始化

**描述**: 从 main.ts 中移除同步的 Sentry.init() 调用，改为在应用启动后异步初始化。

- **Files**:
  - `main.ts` - 移除 Sentry 同步初始化代码

- **当前代码分析**:
  需要检查 main.ts 中现有的 Sentry 初始化代码位置和配置。

- **修改规范**:

```typescript
// main.ts - 修改前
import * as Sentry from '@sentry/angular';

Sentry.init({
  dsn: environment.sentryDsn,
  // ... 配置
});

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));

// main.ts - 修改后
// 移除顶层 Sentry import 和 init
// Sentry 将由 SentryLazyLoaderService 异步加载

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
```

- **Success**:
  - main.ts 中无同步 Sentry 初始化
  - 应用正常启动
  - 首屏渲染时间减少

- **Research References**:
  - 研究文件 Lines 205-215 - main.ts 修改方案

- **Dependencies**:
  - Task 1.1 完成

### Task 1.3: 更新 app.config.ts 配置异步 Sentry 初始化

**描述**: 在 app.config.ts 中配置 APP_INITIALIZER，在应用稳定后触发 Sentry 懒加载。

- **Files**:
  - `src/app/app.config.ts` - 添加 Sentry 懒加载触发器

- **实现规范**:

```typescript
// src/app/app.config.ts
import { ApplicationConfig, APP_INITIALIZER } from '@angular/core';
import { SentryLazyLoaderService } from '../services/sentry-lazy-loader.service';

// Sentry 懒加载工厂函数
function initSentryLazyLoader(sentryLoader: SentryLazyLoaderService) {
  return () => {
    // 返回空 Promise，不阻塞启动
    // Sentry 在后台通过 requestIdleCallback 初始化
    queueMicrotask(() => sentryLoader.triggerLazyInit());
    return Promise.resolve();
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    // ... 现有 providers
    
    // Sentry 懒加载初始化（不阻塞启动）
    {
      provide: APP_INITIALIZER,
      useFactory: initSentryLazyLoader,
      deps: [SentryLazyLoaderService],
      multi: true,
    },
  ],
};
```

- **Success**:
  - APP_INITIALIZER 正确配置
  - 不阻塞应用启动（返回立即解决的 Promise）
  - Sentry 在空闲时后台初始化

- **Research References**:
  - 研究文件 Lines 220-235 - APP_INITIALIZER 配置

- **Dependencies**:
  - Task 1.1 完成
  - Task 1.2 完成

### Task 1.4: 更新 GlobalErrorHandler 使用懒加载 Sentry

**描述**: 修改 GlobalErrorHandler 使用 SentryLazyLoaderService 替代直接 Sentry 调用。

- **Files**:
  - `src/services/global-error-handler.service.ts` - 修改错误上报逻辑

- **实现规范**:

```typescript
// src/services/global-error-handler.service.ts
import { ErrorHandler, Injectable, inject } from '@angular/core';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly sentryLoader = inject(SentryLazyLoaderService);

  handleError(error: unknown): void {
    // 错误分级处理逻辑保持不变
    
    // 上报到 Sentry（使用懒加载服务）
    this.sentryLoader.captureException(error, {
      component: 'GlobalErrorHandler',
      timestamp: new Date().toISOString(),
    });
    
    // 开发环境打印到控制台
    if (!environment.production) {
      console.error('[GlobalErrorHandler]', error);
    }
  }
}
```

- **Success**:
  - GlobalErrorHandler 使用 SentryLazyLoaderService
  - 初始化前的错误被正确队列化
  - 初始化后的错误正常上报

- **Research References**:
  - 研究文件 Lines 240-260 - 错误处理集成

- **Dependencies**:
  - Task 1.1 完成

---

## Phase 2: JS Bundle 分析与优化 (P1 - 预期收益: -100~200 ms)

### Task 2.1: 配置 source-map-explorer 分析工具

**描述**: 安装并配置 source-map-explorer 用于分析 JavaScript Bundle 组成。

- **Files**:
  - `package.json` - 添加 devDependency
  - `scripts/analyze-bundle.sh` - 创建分析脚本

- **实现规范**:

```bash
# 安装依赖
npm install --save-dev source-map-explorer

# scripts/analyze-bundle.sh
#!/bin/bash
set -e

echo "🔍 Building with source maps..."
ng build --source-map

echo "📊 Analyzing main bundle..."
npx source-map-explorer dist/browser/main-*.js --html dist/bundle-report.html

echo "📊 Analyzing all bundles..."
npx source-map-explorer dist/browser/*.js --html dist/full-bundle-report.html

echo "✅ Reports generated:"
echo "  - dist/bundle-report.html (main bundle)"
echo "  - dist/full-bundle-report.html (all bundles)"
```

- **Success**:
  - source-map-explorer 安装成功
  - 分析脚本可执行
  - 生成 HTML 报告

- **Research References**:
  - 研究文件 Lines 300-310 - Bundle 分析工具

- **Dependencies**:
  - 无

### Task 2.2: 分析当前 Bundle 组成并生成报告

**描述**: 执行 Bundle 分析，识别大型依赖和优化机会。

- **Files**:
  - `docs/bundle-analysis-report.md` - 分析报告

- **实现规范**:

1. 运行 `npm run analyze:bundle`
2. 检查 dist/bundle-report.html
3. 记录以下信息：
   - 总 Bundle 大小
   - 各依赖占比
   - 可懒加载的大型依赖

- **分析重点**:
  - @sentry/angular 大小（已通过 Phase 1 懒加载）
  - gojs 大小（已通过 @defer 懒加载）
  - rxjs 操作符使用情况
  - zone.js 大小

- **Success**:
  - Bundle 分析报告生成
  - 识别至少 3 个优化机会
  - 记录当前基准数据

- **Research References**:
  - 研究文件 Lines 295-310 - Bundle 优化建议

- **Dependencies**:
  - Task 2.1 完成

### Task 2.3: 调整 angular.json 构建 Budgets

**描述**: 根据分析结果调整构建预算，设置更严格的限制。

- **Files**:
  - `angular.json` - 更新 budgets 配置

- **实现规范**:

```json
{
  "budgets": [
    {
      "type": "initial",
      "maximumWarning": "400kb",
      "maximumError": "800kb"
    },
    {
      "type": "anyComponentStyle",
      "maximumWarning": "8kb",
      "maximumError": "16kb"
    },
    {
      "type": "bundle",
      "name": "main",
      "maximumWarning": "350kb",
      "maximumError": "600kb"
    }
  ]
}
```

- **Success**:
  - Budgets 配置更新
  - 构建时产生预算警告（如适用）
  - 文档记录当前与目标差距

- **Research References**:
  - 研究文件 Lines 295-300 - Budget 调整建议

- **Dependencies**:
  - Task 2.2 完成

### Task 2.4: 优化大型依赖的懒加载策略

**描述**: 根据 Bundle 分析结果，优化大型依赖的加载策略。

- **Files**:
  - 根据分析结果确定需修改的文件

- **优化策略**:

1. **已完成的懒加载**:
   - GoJS: `@defer (on viewport; prefetch on idle)`
   - Sentry: Phase 1 实现的懒加载

2. **待评估的依赖**:
   - `@supabase/supabase-js` - 考虑延迟导入非核心功能
   - Chart 库（如有）- 按需加载

3. **RxJS 优化**:
```typescript
// 使用精确导入替代全量导入
// Before
import { map, filter, switchMap } from 'rxjs/operators';

// After（已是最佳实践，验证是否全项目遵循）
import { map } from 'rxjs/operators/map';
```

- **Success**:
  - 识别并实施至少 1 个新的懒加载优化
  - Initial Bundle 大小减少 5% 以上
  - 无功能回归

- **Research References**:
  - 研究文件 Lines 165-180 - @defer 最佳实践

- **Dependencies**:
  - Task 2.2 完成
  - Task 2.3 完成

---

## Phase 3: 字体渲染优化 (P2 - 预期收益: 感知性能提升)

### Task 3.1: 添加 size-adjust 减少布局偏移

**描述**: 为 LXGW WenKai 字体添加 size-adjust 属性，使其与 fallback 字体尺寸匹配。

- **Files**:
  - `index.html` - 更新内联 @font-face 定义

- **实现规范**:

```css
/* index.html 内联样式更新 */
@font-face {
  font-family: 'LXGW WenKai Screen';
  font-display: swap;
  size-adjust: 105%;  /* 匹配 sans-serif fallback 尺寸 */
  src: url('https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/fonts/subset/LXGWWenKaiScreen-subset-117.woff2') format('woff2');
  unicode-range: U+20-22, U+27-29, ...;
}
```

- **确定 size-adjust 值的方法**:
1. 使用 [Fallback Font Generator](https://screenspan.net/fallback) 工具
2. 输入 LXGW WenKai Screen 和 sans-serif
3. 获取推荐的 size-adjust 值

- **Success**:
  - size-adjust 属性添加到所有 @font-face 定义
  - CLS 保持 0
  - 字体切换更平滑

- **Research References**:
  - 研究文件 Lines 320-330 - size-adjust 优化

- **Dependencies**:
  - 无

### Task 3.2: 优化关键字体子集预加载策略

**描述**: 评估并优化字体子集的预加载策略。

- **Files**:
  - `index.html` - 评估 preload 配置
  - `ngsw-config.json` - 验证缓存配置

- **当前状态分析**:
- 已预加载: subset-117, 118, 119
- 策略: performance + 365天缓存

- **优化评估**:

1. **验证预加载子集覆盖率**:
```javascript
// 开发者工具中运行
// 检查首屏文字使用的 unicode 范围
const text = document.body.innerText;
const codePoints = [...text].map(c => c.codePointAt(0).toString(16));
console.log('Used code points:', new Set(codePoints));
```

2. **考虑减少预加载数量**:
   - 如果某个子集首屏未使用，移除 preload
   - 保留最常用的中文字符子集

- **Success**:
  - 预加载策略经过验证
  - 预加载文件数量合理（≤3）
  - 首屏字体加载时间优化

- **Research References**:
  - 研究文件 Lines 85-100 - 字体预加载现状

- **Dependencies**:
  - Task 3.1 完成

---

## Phase 4: 性能验证与监控 (P3)

### Task 4.1: 创建性能基准测试脚本

**描述**: 创建自动化性能测试脚本，用于验证优化效果。

- **Files**:
  - `scripts/performance-benchmark.sh` - 性能基准测试脚本
  - `scripts/performance-benchmark.js` - Node.js 测试脚本

- **实现规范**:

```bash
#!/bin/bash
# scripts/performance-benchmark.sh
set -e

echo "🚀 Performance Benchmark Test"
echo "=============================="

# 确保生产构建
npm run build

# 启动本地服务器（后台）
npx http-server dist/browser -p 4200 &
SERVER_PID=$!
sleep 3

# 运行 Lighthouse
echo "📊 Running Lighthouse..."
npx lighthouse http://localhost:4200 \
  --output=json,html \
  --output-path=./dist/lighthouse-report \
  --chrome-flags="--headless" \
  --only-categories=performance

# 提取关键指标
node scripts/extract-lighthouse-metrics.js dist/lighthouse-report.json

# 清理
kill $SERVER_PID

echo "✅ Benchmark complete!"
```

```javascript
// scripts/extract-lighthouse-metrics.js
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const metrics = {
  LCP: report.audits['largest-contentful-paint'].numericValue,
  FCP: report.audits['first-contentful-paint'].numericValue,
  CLS: report.audits['cumulative-layout-shift'].numericValue,
  TBT: report.audits['total-blocking-time'].numericValue,
  TTI: report.audits['interactive'].numericValue,
};

console.log('\n📈 Performance Metrics:');
console.log('========================');
console.log(`LCP: ${(metrics.LCP / 1000).toFixed(2)}s`);
console.log(`FCP: ${(metrics.FCP / 1000).toFixed(2)}s`);
console.log(`CLS: ${metrics.CLS.toFixed(3)}`);
console.log(`TBT: ${metrics.TBT.toFixed(0)}ms`);
console.log(`TTI: ${(metrics.TTI / 1000).toFixed(2)}s`);

// 保存到 JSON 文件用于对比
fs.writeFileSync('dist/metrics.json', JSON.stringify(metrics, null, 2));
```

- **Success**:
  - 脚本可成功执行
  - 输出关键性能指标
  - 指标保存为 JSON 用于历史对比

- **Research References**:
  - 研究文件 Lines 25-40 - 性能基准数据

- **Dependencies**:
  - Phase 1-3 完成

### Task 4.2: 配置 Lighthouse CI 自动化测试

**描述**: 配置 Lighthouse CI 用于 CI/CD 流水线中的性能监控。

- **Files**:
  - `lighthouserc.js` - Lighthouse CI 配置
  - `.github/workflows/lighthouse.yml` - GitHub Actions 工作流（可选）

- **实现规范**:

```javascript
// lighthouserc.js
module.exports = {
  ci: {
    collect: {
      url: ['http://localhost:4200/'],
      startServerCommand: 'npm run serve:prod',
      startServerReadyPattern: 'Compiled successfully',
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.85 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 1500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'first-contentful-paint': ['error', { maxNumericValue: 1000 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
```

- **Success**:
  - Lighthouse CI 配置完成
  - 断言规则设置合理
  - 可本地运行 `npx lhci autorun`

- **Research References**:
  - 研究文件 Lines 350-360 - 目标指标

- **Dependencies**:
  - Task 4.1 完成

### Task 4.3: 验证优化效果并生成对比报告

**描述**: 执行最终性能测试，生成优化前后对比报告。

- **Files**:
  - `docs/performance-optimization-results.md` - 优化结果报告

- **实现规范**:

```markdown
# PWA 性能优化结果报告

## 优化前后对比

| 指标 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| LCP | 1,943 ms | {{lcp_after}} | {{lcp_diff}} |
| Render Delay | 1,872 ms | {{render_after}} | {{render_diff}} |
| CLS | 0.00 | {{cls_after}} | {{cls_diff}} |
| TTFB | 71 ms | {{ttfb_after}} | {{ttfb_diff}} |
| Initial Bundle | {{bundle_before}} | {{bundle_after}} | {{bundle_diff}} |

## 实施的优化措施

1. ✅ Sentry SDK 懒加载
2. ✅ JS Bundle 优化
3. ✅ 字体 size-adjust 配置
4. ✅ 性能监控自动化

## 结论

{{conclusion}}
```

- **Success**:
  - 优化前后对比数据完整
  - LCP < 1,500ms 目标达成
  - 报告清晰易懂

- **Research References**:
  - 研究文件 Lines 340-365 - 成功标准

- **Dependencies**:
  - Phase 1-3 完成
  - Task 4.1 完成
  - Task 4.2 完成

---

## Dependencies

- source-map-explorer (npm 包)
- @lhci/cli (Lighthouse CI，可选)
- lighthouse (npm 包)
- http-server (npm 包)

## Success Criteria

- LCP < 1,500ms (P75)
- Render Delay < 1,000ms
- CLS = 0 保持不变
- Sentry 错误捕获完整
- 所有现有功能正常
- 自动化性能监控就绪
