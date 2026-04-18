/**
 * sw-composed.js — 组合 Service Worker
 *
 * 复用 Angular NGSW 的缓存与更新能力，同时挂接 Widget 运行时事件处理。
 * 部署时必须对本文件设置 `Cache-Control: no-cache`，与 ngsw-worker.js 保持一致。
 *
 * REL-03: 本文件必须作为独立波次部署，先于 manifest widgets 暴露。
 */

// === 1. 导入 Angular NGSW ===
// ngsw-worker.js 由 @angular/service-worker 在 build 时生成到 dist/browser/
importScripts('./ngsw-worker.js');

// === 2. 导入 Widget 运行时 ===
// widget-runtime.js 处理 widgetinstall / widgetresume / widgetclick / widgetuninstall / periodicsync
importScripts('./widgets/widget-runtime.js');
