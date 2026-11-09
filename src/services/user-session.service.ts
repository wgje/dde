/** UserSessionService - 用户会话管理：登录/登出清理、项目切换、数据加载 */
import { Injectable } from '@angular/core';
import { UserSessionLayer6 } from './user-session-layer-6.service';

@Injectable({
  providedIn: 'root'
})
export class UserSessionService extends UserSessionLayer6 {}
