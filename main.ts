import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideExperimentalZonelessChangeDetection, isDevMode } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { AppComponent } from './src/app.component';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './src/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideExperimentalZonelessChangeDetection(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withHashLocation() // 使用 hash 路由以兼容静态部署
    ),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
}).catch(err => console.error(err));
