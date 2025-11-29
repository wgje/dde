import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth.service';

/**
 * 认证路由守卫
 * 保护需要登录才能访问的路由
 * 
 * 注意：由于本应用支持"离线优先"模式，此守卫主要用于：
 * 1. 标识需要认证的路由
 * 2. 在特定场景下强制登录（如访问他人项目）
 */
export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  
  // 如果 Supabase 未配置，允许离线模式访问
  if (!authService.isConfigured) {
    return true;
  }
  
  // 检查是否有会话
  const userId = authService.currentUserId();
  if (userId) {
    return true;
  }
  
  // 检查是否正在检查会话状态
  const authState = authService.authState();
  if (authState.isCheckingSession) {
    // 等待会话检查完成（实际应用中可能需要更复杂的处理）
    return true;
  }
  
  // 未登录时的处理策略：
  // 1. 允许访问，但后续功能受限（离线模式）
  // 2. 或重定向到登录页面
  
  // 当前策略：允许离线访问，但记录警告
  console.warn('用户未登录，进入离线模式');
  return true;
};

/**
 * 强制登录守卫
 * 用于必须登录才能访问的功能（如导出、分享等）
 */
export const requireAuthGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  
  if (!authService.isConfigured) {
    // Supabase 未配置，不允许访问需要认证的功能
    void router.navigate(['/projects'], {
      queryParams: { authRequired: 'true' }
    });
    return false;
  }
  
  const userId = authService.currentUserId();
  if (userId) {
    return true;
  }
  
  // 未登录，重定向到项目页面并提示需要登录
  void router.navigate(['/projects'], {
    queryParams: { authRequired: 'true', returnUrl: state.url }
  });
  return false;
};
