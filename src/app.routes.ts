import { inject, Injector, runInInjectionContext } from '@angular/core';
import { CanActivateFn, CanDeactivateFn, Routes } from '@angular/router';
import { firstValueFrom, isObservable } from 'rxjs';

const readBootFlag = (key: string, fallback: boolean): boolean => {
  if (typeof window === 'undefined') return fallback;
  const flags = (window as Window & { __NANOFLOW_BOOT_FLAGS__?: Record<string, unknown> }).__NANOFLOW_BOOT_FLAGS__;
  const value = flags?.[key];
  return typeof value === 'boolean' ? value : fallback;
};

const ROUTE_GUARD_LAZY_IMPORT_ENABLED = readBootFlag('ROUTE_GUARD_LAZY_IMPORT_V1', true);
let authGuardModulePromise: Promise<typeof import('./services/guards/auth.guard')> | null = null;
let projectGuardModulePromise: Promise<typeof import('./services/guards/project.guard')> | null = null;
let unsavedChangesGuardModulePromise: Promise<typeof import('./services/guards/unsaved-changes.guard')> | null = null;

const loadAuthGuardModule = () =>
  (authGuardModulePromise ??= import('./services/guards/auth.guard'));
const loadProjectGuardModule = () =>
  (projectGuardModulePromise ??= import('./services/guards/project.guard'));
const loadUnsavedChangesGuardModule = () =>
  (unsavedChangesGuardModulePromise ??= import('./services/guards/unsaved-changes.guard'));

if (!ROUTE_GUARD_LAZY_IMPORT_ENABLED) {
  // 运行时回滚：立即预热守卫模块，逼近旧路径行为（不阻塞构建）。
  void loadAuthGuardModule();
  void loadProjectGuardModule();
  void loadUnsavedChangesGuardModule();
}

/**
 * 路由守卫懒加载包装器
 *
 * 目标：将重型守卫依赖（尤其是同步链路）移出 main 初始静态闭包。
 *
 * 【关键修复】inject() 必须在同步调用栈中执行，await 之后注入上下文丢失。
 * 因此必须在 await 前捕获 Injector，再用 runInInjectionContext 恢复上下文。
 */
export const requireAuthGuardLazy: CanActivateFn = async (route, state) => {
  // 关键：在 await 之前捕获注入上下文，否则 async 恢复后 inject() 会抛 NG0203
  const injector = inject(Injector);
  const module = await loadAuthGuardModule();
  const result = runInInjectionContext(injector, () => module.requireAuthGuard(route, state));
  if (isObservable(result)) {
    return firstValueFrom(result);
  }
  return result;
};

export const projectExistsGuardLazy: CanActivateFn = async (route, state) => {
  // 关键：在 await 之前捕获注入上下文，否则 async 恢复后 inject() 会抛 NG0203
  const injector = inject(Injector);
  const module = await loadProjectGuardModule();
  const result = runInInjectionContext(injector, () => module.projectExistsGuard(route, state));
  if (isObservable(result)) {
    return firstValueFrom(result);
  }
  return result;
};

export const unsavedChangesGuardLazy: CanDeactivateFn<unknown> = async (
  component,
  currentRoute,
  currentState,
  nextState
) => {
  const injector = inject(Injector);
  const module = await loadUnsavedChangesGuardModule();
  const guard = injector.get(module.UnsavedChangesGuard);
  return guard.canDeactivate(component, currentRoute, currentState, nextState);
};

/**
 * 应用路由配置
 * 支持项目深度链接和视图状态保持
 * 
 * 路由结构：
 * - /projects - 项目列表（AppComponent）
 * - /projects/:projectId - 项目视图外壳（ProjectShellComponent）
 *   - /projects/:projectId/text - 文本视图模式（子路由）
 *   - /projects/:projectId/flow - 流程图模式（子路由）
 *   - /projects/:projectId/task/:taskId - 定位到特定任务（子路由）
 * 
 * 【P2-38 修复】使用父子路由结构
 * 原来 4 个兄弟路由各自加载 ProjectShellComponent，
 * 导致在 /text ↔ /flow 之间导航时组件被销毁重建。
 * 现在 :projectId 作为父路由，text/flow/task 作为无组件子路由，
 * ProjectShellComponent 在子路由切换时保持存活。
 * 
 * 路由守卫：
 * - requireAuthGuard: 强制登录验证（数据归属权保障）
 * - projectExistsGuard: 项目存在性检查
 * 
 * 认证策略说明：
 * 采用「强制登录」模式，所有数据操作都需要明确的 user_id：
 * 1. 简化 Supabase RLS 策略 - 所有操作都有明确的数据归属
 * 2. 避免「幽灵数据」问题 - 无需处理匿名数据到正式账户的迁移
 * 3. 保障数据安全 - 防止未授权访问和垃圾数据注入
 */
export const routes: Routes = [
  // 默认重定向到项目列表
  { path: '', redirectTo: '/projects', pathMatch: 'full' },
  
  // 项目列表/主视图 - WorkspaceShell 懒加载承载重型工作区
  { 
    path: 'projects', 
    canActivate: [requireAuthGuardLazy],
    loadComponent: () => import('./workspace-shell.component').then(m => m.WorkspaceShellComponent),
    children: [
      // 项目列表首页（无选中项目）
      { 
        path: '', 
        pathMatch: 'full',
        loadComponent: () => import('./app/core/shell/project-shell.component').then(m => m.ProjectShellComponent)
      },
      // 特定项目视图 - ProjectShellComponent 管理 text/flow 视图切换
      // 使用父子路由避免 text/flow 切换时组件重建
      { 
        path: ':projectId', 
        canActivate: [projectExistsGuardLazy],
        canDeactivate: [unsavedChangesGuardLazy],
        loadComponent: () => import('./app/core/shell/project-shell.component').then(m => m.ProjectShellComponent),
        children: [
          // 默认视图（无后缀路径）
          { path: '', pathMatch: 'full', children: [] },
          // 文本视图模式
          { path: 'text', children: [] },
          // 流程图模式
          { path: 'flow', children: [] },
          // 定位到特定任务（深度链接）
          { path: 'task/:taskId', children: [] }
        ]
      }
    ]
  },
  
  // 密码重置回调页面 - 使用专门的组件处理 token
  // 注意：此路由故意不添加 authGuard，因为：
  // 1. 用户是通过邮箱链接跳转到此页面的，此时尚未登录
  // 2. Supabase 的密码重置 token 会通过 URL fragment 传递
  // 3. 该页面不涉及敏感数据，只用于设置新密码
  { 
    path: 'reset-password', 
    loadComponent: () => import('./app/shared/components/reset-password.component').then(m => m.ResetPasswordComponent)
  },
  
  // 致命错误页面
  { 
    path: 'error', 
    loadComponent: () => import('./app/shared/components/error-page.component').then(m => m.ErrorPageComponent)
  },
  
  // 404 页面
  { 
    path: 'not-found', 
    loadComponent: () => import('./app/shared/components/not-found.component').then(m => m.NotFoundComponent)
  },
  
  // 兜底路由 - 重定向到 404
  { path: '**', redirectTo: '/not-found' }
];
