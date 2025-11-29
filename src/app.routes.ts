import { Routes } from '@angular/router';

/**
 * 应用路由配置
 * 支持项目深度链接和视图状态保持
 */
export const routes: Routes = [
  // 默认重定向到项目列表
  { path: '', redirectTo: '/projects', pathMatch: 'full' },
  
  // 项目列表/主视图
  { 
    path: 'projects', 
    loadComponent: () => import('./app.component').then(m => m.AppComponent),
    children: [
      // 特定项目视图
      { 
        path: ':projectId', 
        loadComponent: () => import('./app.component').then(m => m.AppComponent),
        children: [
          // 特定视图模式
          { path: 'text', loadComponent: () => import('./app.component').then(m => m.AppComponent) },
          { path: 'flow', loadComponent: () => import('./app.component').then(m => m.AppComponent) },
          // 特定任务（深度链接）
          { path: 'task/:taskId', loadComponent: () => import('./app.component').then(m => m.AppComponent) }
        ]
      }
    ]
  },
  
  // 密码重置回调页面
  { path: 'reset-password', loadComponent: () => import('./app.component').then(m => m.AppComponent) },
  
  // 兜底路由
  { path: '**', redirectTo: '/projects' }
];
