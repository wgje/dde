/**
 * 路由守卫导出
 */
export { 
  requireAuthGuard, 
  isLocalModeEnabled, 
  enableLocalMode, 
  disableLocalMode,
  getDataIsolationId 
} from './auth.guard';
export { projectExistsGuard } from './project.guard';

// 路由离开保护
export {
  UnsavedChangesGuard,
  BeforeUnloadGuardService,
  ProjectSwitchGuardService,
  ROUTE_LEAVE_PROTECTION_CONFIG,
  type CanLeave,
} from './unsaved-changes.guard';
