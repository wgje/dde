import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler, VERSION, NgZone, APP_INITIALIZER } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation, withRouterConfig } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
// ============= Sentry SDK 懒加载优化 =============
// 【性能优化 2026-02-01】Sentry 懒加载以消除 320ms 首屏阻塞
// 
// 优化策略：
// 1. 移除同步 Sentry.init()，改为 SentryLazyLoaderService 异步初始化
// 2. 使用 requestIdleCallback 在浏览器空闲时加载
// 3. 错误队列机制确保初始化前的错误不丢失
// 
// 预期收益：Render Delay -200~300ms，LCP 显著改善
// ============= Sentry 懒加载（非阻塞初始化）=============
// 【性能优化 2026-02-01】Sentry SDK 现由 SentryLazyLoaderService 管理
// - 首屏渲染完成后通过 requestIdleCallback 异步初始化
// - 初始化前的错误会被队列缓存，初始化后自动发送
// - 详见 src/services/sentry-lazy-loader.service.ts

// ============= BUILD ID: 2025-12-04-v19-TOGGLE-ALIGN =============
const BUILD_ID = '2025-12-04-v19-TOGGLE-ALIGN';
if (isDevMode()) {
  console.log('%c [NanoFlow] Main.ts Loaded: ' + BUILD_ID, 'background: #222; color: #bada55; font-size: 20px');
}
const START_TIME = Date.now();
const VERSION_STORAGE_KEY = 'nanoflow.app-version';
const FORCE_CLEAR_KEY = 'nanoflow.force-clear-cache';

// 简化日志 - 仅开发模式输出，生产模式静默
const VERBOSE_LOGS = isDevMode() && localStorage.getItem('nanoflow.verbose') === 'true';
const log = (msg: string, _color = '#0f0') => {
  if (!VERBOSE_LOGS) return;
  const elapsed = Date.now() - START_TIME;
  console.log(`[NanoFlow +${elapsed}ms] ${msg}`);
};
const logError = (msg: string, err?: any) => {
  const elapsed = Date.now() - START_TIME;
  console.error(`[NanoFlow +${elapsed}ms] ❌ ${msg}`, err || '');
};

// 在浏览器空闲时执行任务，避免阻塞首屏渲染
const scheduleIdleTask = (task: () => void) => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => task());
  } else {
    setTimeout(task, 0);
  }
};

const readBootFlag = (key: string, fallback: boolean): boolean => {
  if (typeof window === 'undefined') return fallback;
  const flags = (window as Window & { __NANOFLOW_BOOT_FLAGS__?: Record<string, unknown> }).__NANOFLOW_BOOT_FLAGS__;
  const value = flags?.[key];
  return typeof value === 'boolean' ? value : fallback;
};

// ========== 版本检测与缓存清理 ==========
async function checkAndClearCacheIfNeeded(): Promise<boolean> {
  try {
    const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);
    const forceClear = localStorage.getItem(FORCE_CLEAR_KEY);
    
    log(`当前版本: ${BUILD_ID}, 存储版本: ${storedVersion || '无'}`);
    
    // 如果有强制清理标记，或者版本不匹配
    if (forceClear === 'true' || (storedVersion && storedVersion !== BUILD_ID)) {
      log('🔄 检测到版本更新或强制清理标记，正在清理缓存...');
      
      // 清除强制清理标记
      localStorage.removeItem(FORCE_CLEAR_KEY);
      
      // 清理所有 caches
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        log(`清理 ${cacheNames.length} 个缓存...`);
        await Promise.all(cacheNames.map(name => {
          log(`  删除缓存: ${name}`);
          return caches.delete(name);
        }));
      }
      
      // 注销所有 Service Worker
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        log(`注销 ${registrations.length} 个 Service Worker...`);
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
      
      // 保存新版本号
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
      
      // 如果是版本更新（不是首次加载），需要刷新页面
      if (storedVersion && storedVersion !== BUILD_ID) {
        log('✅ 缓存已清理，即将刷新页面加载新版本...');
        // 使用 replace 避免产生历史记录循环
        setTimeout(() => {
          window.location.replace(window.location.href);
        }, 100);
        return true; // 表示需要刷新
      }
    } else if (!storedVersion) {
      // 首次加载，保存版本号
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
      log('首次加载，已保存版本号');
    }
    
    return false; // 不需要刷新
  } catch (e) {
    logError('版本检测失败', e);
    // 出错时保存版本号并继续
    try {
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
    } catch {}
    return false;
  }
}

// ========== 强制清理缓存工具函数（暴露到全局供紧急使用）==========
function registerForceClearCacheTool(): void {
  (window as any).__NANOFLOW_FORCE_CLEAR_CACHE__ = async function() {
    log('🧹 用户触发强制清理缓存...');
    localStorage.setItem(FORCE_CLEAR_KEY, 'true');
    
    try {
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
      // 清除可能导致问题的本地数据
      localStorage.removeItem('nanoflow.offline-cache-v2');
      localStorage.removeItem('nanoflow.escape-pod');
    } catch (e) {
      logError('强制清理失败', e);
    }
    
    window.location.reload();
  };
}

// 将维护工具注册放到浏览器空闲阶段，避免阻塞启动热路径。
scheduleIdleTask(() => registerForceClearCacheTool());

log('Build: ' + BUILD_ID);
log('🚀 main.ts 开始执行');
log('Angular 版本: ' + VERSION.full);
log('当前 URL: ' + window.location.href);
log('User Agent: ' + navigator.userAgent.substring(0, 80) + '...');

// 检查 Zone.js 是否已加载
const zoneLoaded = typeof (window as any).Zone !== 'undefined';
log('Zone.js: ' + (zoneLoaded ? '✅已加载' : '❌未加载'));

if (!zoneLoaded) {
  logError('Zone.js 未加载！Angular 无法工作！');
}

// 检测浏览器能力
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
log('设备: ' + (isMobile ? (isIOS ? 'iOS' : 'Android') : 'Desktop'));

// 全局错误捕获 - 在 Angular 启动前就开始捕获
window.onerror = (message, source, lineno, colno, error) => {
  // Supabase Auth 多标签页/多实例场景的 LockManager 锁争用：
  // 不影响功能，但 Zone.js/浏览器默认处理会在控制台打印堆栈，造成噪音。
  const messageText = String(message ?? '');
  const isSupabaseAuthLockContention =
    /Navigator LockManager lock/i.test(messageText) ||
    /Acquiring an exclusive Navigator LockManager lock/i.test(messageText) ||
    /lock:sb-.*-auth-token/i.test(messageText);

  if (isSupabaseAuthLockContention) {
    return true; // 阻止默认处理（避免控制台噪音）
  }

  logError(`全局错误: ${message}`, { source, lineno, colno, error });
  return false; // 继续默认处理
};

window.addEventListener('unhandledrejection', (event) => {
  // Supabase Auth 在多标签页/多实例场景会用 Navigator LockManager 做互斥。
  // 当锁被其他实例占用时会出现立即失败的 rejection；这通常不影响登录态本身，
  // 但 Zone.js + 浏览器默认行为会把它打印成“未处理错误”，造成噪音。
  const reasonText = String((event as any)?.reason?.message ?? (event as any)?.reason ?? '');
  const isSupabaseAuthLockContention =
    /Navigator LockManager lock/i.test(reasonText) ||
    /Acquiring an exclusive Navigator LockManager lock/i.test(reasonText) ||
    /lock:sb-.*-auth-token/i.test(reasonText);

  if (isSupabaseAuthLockContention) {
    event.preventDefault();
    return;
  }

  logError('未处理的 Promise 拒绝', event.reason);
});

// ========== 应用启动函数 ==========
async function startApplication() {
  log('🏗️ 准备启动 Angular...');
  
  // 3. 添加启动超时保护（15秒）
  const startupTimeout = setTimeout(() => {
    logError('Angular 启动超时！');
    showStartupError('启动超时', '应用启动时间过长，可能是缓存问题导致。', new Error('Startup timeout'));
  }, 15000);
  
  try {
    const [
      appComponentModule,
      appRoutesModule,
      globalErrorHandlerModule,
      sentryLoaderModule
    ] = await Promise.all([
      import('./src/app.component'),
      import('./src/app.routes'),
      import('./src/services/global-error-handler.service'),
      import('./src/services/sentry-lazy-loader.service'),
    ]);
    const AppComponent = appComponentModule.AppComponent;
    const routes = appRoutesModule.routes;
    const GlobalErrorHandler = globalErrorHandlerModule.GlobalErrorHandler;
    const SentryLazyLoaderService = sentryLoaderModule.SentryLazyLoaderService;

    const appRef = await bootstrapApplication(AppComponent, {
      providers: [
        // ============= 错误处理器（使用 GlobalErrorHandler）=============
        // 【优化 2026-02-01】改用 GlobalErrorHandler 集成 SentryLazyLoaderService
        // GlobalErrorHandler 会在 Sentry 初始化完成后自动上报错误
        {
          provide: ErrorHandler,
          useClass: GlobalErrorHandler,
        },
        // ============= Sentry 懒加载初始化（非阻塞）=============
        // 【性能优化 2026-02-01】使用 APP_INITIALIZER + queueMicrotask 实现非阻塞初始化
        // 返回立即 resolve 的 Promise，不阻塞应用启动
        // Sentry 将在浏览器空闲时通过 requestIdleCallback 初始化
        {
          provide: APP_INITIALIZER,
          useFactory: (sentryLoader: { triggerLazyInit: () => void }) => () => {
            // 使用 queueMicrotask 确保不阻塞当前任务
            queueMicrotask(() => sentryLoader.triggerLazyInit());
            return Promise.resolve();
          },
          deps: [SentryLazyLoaderService],
          multi: true,
        },
        provideRouter(
          routes,
          withComponentInputBinding(),
          withHashLocation(),
          withRouterConfig({
            // 关键修复：Guard 取消导航后同步 Router/URL 状态，避免登录后同路径导航被误判为已在目标页
            canceledNavigationResolution: 'computed',
            // 【P2-38】子路由继承父路由参数，ProjectShellComponent 可直接读取子路由 taskId
            paramsInheritanceStrategy: 'always'
          })
        ),
        // Service Worker: 启用以检测应用更新
        provideServiceWorker('ngsw-worker.js', {
          enabled: !isDevMode(),
          registrationStrategy: 'registerWhenStable:30000'
        })
      ]
    });
    
    clearTimeout(startupTimeout);
    
    const elapsed = Date.now() - START_TIME;
    log('✅ Angular 启动成功! 耗时: ' + elapsed + 'ms');
    
    // 标记应用就绪
    (window as any).__NANOFLOW_READY__ = true;
    
    // 隐藏初始加载器
    const loader = document.getElementById('initial-loader');
    if (loader) loader.style.display = 'none';
    
    // 检查 Zone.js 是否正常工作 - 尝试触发变更检测
    try {
      const zone = appRef.injector.get(NgZone);
      zone.run(() => {
        log('🎉 应用完全就绪，Zone.js 正常工作');
      });
      
    } catch (e) {
      logError('Zone.js 运行时检查失败', e);
    }

    const initWebVitals = () => {
      void import('./src/services/web-vitals.service')
        .then((module) => {
          const webVitals = appRef.injector.get(module.WebVitalsService);
          webVitals.init();
        })
        .catch((error) => {
          logError('Web Vitals 延迟初始化失败', error);
        });
    };
    const webVitalsIdleBootEnabled = readBootFlag('WEB_VITALS_IDLE_BOOT_V2', true);
    if (webVitalsIdleBootEnabled) {
      // Web Vitals 监控下沉到 idle 阶段，避免主路径静态依赖膨胀。
      scheduleIdleTask(initWebVitals);
    } else {
      void initWebVitals();
    }

    // 启动后维护任务：版本检查/缓存清理/SW 注销
    scheduleIdleTask(() => {
      void runPostBootstrapMaintenance();
    });
  } catch (err: any) {
    clearTimeout(startupTimeout);
    logError('❌ 启动失败', err);
    showStartupError('启动失败', '应用无法正常启动', err);
  }
}

async function runPostBootstrapMaintenance(): Promise<void> {
  try {
    const needsRefresh = await checkAndClearCacheIfNeeded();
    if (needsRefresh) {
      log('等待页面刷新...');
      return;
    }
    // 【性能审计 2026-02-07】移除 unregisterAllServiceWorkers() 调用
    // SW 注册由 provideServiceWorker() 统一管理，不再每次启动时注销
  } catch (e) {
    logError('启动后维护任务失败', e);
  }
}

// 【性能审计 2026-02-07】unregisterAllServiceWorkers 已移除
// SW 生命周期由 Angular provideServiceWorker() + ngsw-config.json 统一管理
// 版本升级时的缓存清理仍保留在 checkAndClearCacheIfNeeded() 中

// ========== 显示启动错误界面 ==========
function showStartupError(title: string, description: string, err: any) {
  // 详细错误分析
  const errStr = String(err?.message || err);
  let diagnosis = '未知错误';
  let suggestion = '请尝试清除浏览器缓存并刷新';
  
  if (errStr.includes('NG0908')) {
    diagnosis = 'Zone.js 冲突 (NG0908) - 可能存在多个 Zone.js 实例';
    suggestion = '请确保只有一个 Zone.js 加载';
  } else if (errStr.includes('inject') || errStr.includes('NullInjector')) {
    diagnosis = '依赖注入错误 - 某个服务无法注入';
    suggestion = '检查所有服务是否正确配置';
  } else if (errStr.includes('chunk') || errStr.includes('Loading chunk')) {
    diagnosis = '代码块加载失败 - 网络问题或文件缺失';
    suggestion = '检查网络连接，或清除缓存重试';
  } else if (errStr.includes('Template') || errStr.includes('template')) {
    diagnosis = '模板编译错误';
    suggestion = '请检查组件模板语法';
  } else if (errStr.includes('Cannot read') || errStr.includes('undefined')) {
    diagnosis = '运行时空指针错误';
    suggestion = '某个对象为 undefined';
  } else if (errStr.includes('timeout') || errStr.includes('Timeout')) {
    diagnosis = '加载超时 - 可能是旧缓存导致';
    suggestion = '点击下方按钮清除缓存';
  }
  
  log('📋 诊断: ' + diagnosis);
  log('💡 建议: ' + suggestion);
  
  // 显示用户可见的错误界面
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:"LXGW WenKai Screen", sans-serif;z-index:99998;overflow:auto;';
  errorDiv.innerHTML = `
    <div style="max-width:600px;margin:0 auto;">
      <h1 style="color:#dc2626;margin-bottom:1rem;font-size:1.5rem;">${title}</h1>
      <p style="margin-bottom:0.5rem;color:#666;">Build: ${BUILD_ID}</p>
      <p style="margin-bottom:1rem;color:#666;">诊断: ${diagnosis}</p>
      <div style="background:#fef2f2;border:1px solid #fecaca;padding:1rem;border-radius:8px;margin-bottom:1rem;">
        <p style="font-size:0.9rem;color:#991b1b;margin:0;">💡 ${suggestion}</p>
      </div>
      <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:11px;max-height:200px;margin-bottom:1rem;white-space:pre-wrap;word-break:break-all;border-radius:8px;">${err?.stack || err?.message || err}</pre>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button onclick="location.reload()" style="padding:0.75rem 1.5rem;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">刷新页面</button>
        <button onclick="window.__NANOFLOW_FORCE_CLEAR_CACHE__()" style="padding:0.75rem 1.5rem;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">清除缓存并刷新</button>
      </div>
      <p style="margin-top:1rem;font-size:0.8rem;color:#999;">如果问题持续，请检查浏览器控制台获取更多信息</p>
    </div>
  `;
  document.body.appendChild(errorDiv);
}

// 启动应用
startApplication();
