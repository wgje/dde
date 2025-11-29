import { Routes } from '@angular/router';
import { authGuard, projectExistsGuard } from './services/guards';

/**
 * 应用路由配置
 * 支持项目深度链接和视图状态保持
 * 
 * 路由守卫：
 * - authGuard: 认证检查（支持离线模式）
 * - projectExistsGuard: 项目存在性检查
 */
export const routes: Routes = [
  // 默认重定向到项目列表
  { path: '', redirectTo: '/projects', pathMatch: 'full' },
  
  // 项目列表/主视图
  { 
    path: 'projects', 
    loadComponent: () => import('./app.component').then(m => m.AppComponent),
    canActivate: [authGuard],
    children: [
      // 特定项目视图
      { 
        path: ':projectId', 
        loadComponent: () => import('./app.component').then(m => m.AppComponent),
        canActivate: [projectExistsGuard],
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
  
  // 密码重置回调页面 - 使用专门的组件处理 token
  { 
    path: 'reset-password', 
    loadComponent: () => import('./components/reset-password.component').then(m => m.ResetPasswordComponent)
  },
  
  // 404 页面
  { 
    path: 'not-found', 
    loadComponent: () => import('./components/not-found.component').then(m => m.NotFoundComponent)
  },
  
  // 兜底路由 - 重定向到 404
  { path: '**', redirectTo: '/not-found' }
];
