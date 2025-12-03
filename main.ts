import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler, VERSION, NgZone } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { AppComponent } from './src/app.component';
import { routes } from './src/app.routes';
import { GlobalErrorHandler } from './src/services/global-error-handler.service';

// ============= BUILD ID: 2025-12-03-v12-REMOVE-DEBUG =============
const BUILD_ID = '2025-12-03-v12-REMOVE-DEBUG';
const START_TIME = Date.now();

// 简化日志 - 仅输出到控制台，不创建屏幕浮层
const log = (msg: string, color = '#0f0') => {
  const elapsed = Date.now() - START_TIME;
  console.log(`[NanoFlow +${elapsed}ms] ${msg}`);
};
const logError = (msg: string) => {
  const elapsed = Date.now() - START_TIME;
  console.error(`[NanoFlow +${elapsed}ms] ❌ ${msg}`);
};

log('Build: ' + BUILD_ID);
log('🚀 main.ts 开始执行');
log('Angular 版本: ' + VERSION.full);

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

// 强制注销所有 Service Worker - 避免缓存问题
if ('serviceWorker' in navigator) {
  log('🧹 注销所有 Service Worker...');
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(reg => {
      log('注销 SW: ' + reg.scope);
      reg.unregister();
    });
    if (registrations.length === 0) {
      log('无 Service Worker 需要注销');
    }
  }).catch(e => logError('注销 SW 失败: ' + e));
}

log('🏗️ 准备启动 Angular...');

bootstrapApplication(AppComponent, {
  providers: [
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withHashLocation()
    ),
    // Service Worker: 提供 provider 但禁用功能，避免 SwUpdate 注入失败
    provideServiceWorker('ngsw-worker.js', {
      enabled: false,
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
}).then((appRef) => {
  const elapsed = Date.now() - START_TIME;
  log('✅ Angular 启动成功! 耗时: ' + elapsed + 'ms');
  
  // 标记应用就绪
  (window as any).__NANOFLOW_READY__ = true;
  
  // 隐藏初始加载器
  const loader = document.getElementById('initial-loader');
  if (loader) loader.style.display = 'none';
  
  log('🎉 应用完全就绪');
}).catch(err => {
  logError('❌ 启动失败: ' + (err?.message || err));
  
  // 检查常见错误类型
  const errStr = String(err?.message || err);
  if (errStr.includes('NG0908')) {
    logError('诊断: Zone.js 冲突 (NG0908)');
  } else if (errStr.includes('inject') || errStr.includes('NullInjector')) {
    logError('诊断: 依赖注入错误');
  }
  
  // 显示用户可见的错误界面
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:sans-serif;z-index:99998;overflow:auto;';
  errorDiv.innerHTML = `
    <h1 style="color:#dc2626;margin-bottom:1rem;">应用启动失败</h1>
    <p style="margin-bottom:1rem;">Build: ${BUILD_ID}</p>
    <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:11px;max-height:150px;margin-bottom:1rem;white-space:pre-wrap;word-break:break-all;">${err?.message || err}</pre>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button onclick="location.reload()" style="padding:0.5rem 1rem;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;">刷新</button>
      <button onclick="caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>location.reload())" style="padding:0.5rem 1rem;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;">清缓存刷新</button>
    </div>
  `;
  document.body.appendChild(errorDiv);
});
