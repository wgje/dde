import { inject } from '@angular/core';
import { CanActivateFn, Router, ActivatedRouteSnapshot } from '@angular/router';
import { StoreService } from '../store.service';
import { ToastService } from '../toast.service';

/**
 * 项目存在性守卫
 * 检查访问的项目是否存在，防止访问无效项目 ID
 */
export const projectExistsGuard: CanActivateFn = (route: ActivatedRouteSnapshot, state) => {
  const store = inject(StoreService);
  const router = inject(Router);
  const toast = inject(ToastService);
  
  const projectId = route.params['projectId'];
  
  // 如果没有项目 ID 参数，允许访问（可能是项目列表页）
  if (!projectId) {
    return true;
  }
  
  // 检查项目是否存在
  const projects = store.projects();
  const projectExists = projects.some(p => p.id === projectId);
  
  if (projectExists) {
    return true;
  }
  
  // 项目不存在，检查是否正在加载
  if (store.isLoadingRemote()) {
    // 正在加载远程数据，允许访问（可能稍后会加载到）
    // 实际显示会在数据加载完成后处理
    return true;
  }
  
  // 项目确实不存在，重定向到项目列表并显示提示
  toast.error('项目不存在', '请求的项目可能已被删除或您没有访问权限');
  
  void router.navigate(['/projects']);
  return false;
};

/**
 * 项目权限守卫（预留）
 * 用于未来的多用户/团队功能
 */
export const projectAccessGuard: CanActivateFn = (route: ActivatedRouteSnapshot, state) => {
  // 当前版本项目仅属于当前用户
  // 未来可以扩展为检查项目的 owner_id 和协作者列表
  return projectExistsGuard(route, state);
};
