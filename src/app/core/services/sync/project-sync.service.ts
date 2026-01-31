/**
 * ProjectSyncService - 项目同步服务
 * 
 * 职责：
 * - 项目推送到云端 (pushProject)
 * - 项目拉取 (pullProjects, loadFullProject)
 * - 项目删除 (deleteProjectFromCloud)
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 7 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { RetryQueueService } from './retry-queue.service';
import { Project } from '../../../../models';
import { ProjectRow } from '../../../../models/supabase-types';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError, EnhancedError } from '../../../../utils/supabase-error';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

@Injectable({
  providedIn: 'root'
})
export class ProjectSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncState = inject(SyncStateService);
  private readonly retryQueue = inject(RetryQueueService);
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
  }
  
  /**
   * 推送项目到云端
   */
  async pushProject(project: Project, fromRetryQueue = false): Promise<boolean> {
    if (this.syncState.isSessionExpired()) {
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.retryQueue.add('project', 'upsert', project);
      }
      return false;
    }
    
    try {
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        this.syncState.setSessionExpired(true);
        this.toast.warning('登录已过期', '请重新登录');
        return false;
      }
      
      await this.throttle.execute(
        `push-project:${project.id}`,
        async () => {
          const { error } = await client
            .from('projects')
            .upsert({
              id: project.id,
              owner_id: userId,
              title: project.name,
              description: project.description,
              version: project.version || 1,
              updated_at: project.updatedAt || nowISO(),
              migrated_to_v2: true
            });
          
          if (error) throw supabaseErrorToError(error);
        },
        { priority: 'high', retries: 2 }
      );
      
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      if (enhanced.errorType === 'VersionConflictError') {
        throw new PermanentFailureError('Version conflict', enhanced, { projectId: project.id });
      }
      
      this.logger.error('推送项目失败', enhanced);
      
      if (enhanced.isRetryable && !fromRetryQueue) {
        this.retryQueue.add('project', 'upsert', project);
      }
      return false;
    }
  }
  
  /**
   * 拉取项目列表
   */
  async pullProjects(since?: string): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      let query = client
        .from('projects')
        .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS);
      
      if (since) {
        query = query.gt('updated_at', since);
      }
      
      const { data, error } = await query;
      
      if (error) throw supabaseErrorToError(error);
      
      return (data || []).map(row => this.rowToProject(row as ProjectRow));
    } catch (e) {
      this.logger.error('拉取项目失败', e);
      return [];
    }
  }
  
  /**
   * 删除云端项目
   */
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      const { error } = await client
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('owner_id', userId);
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('删除项目失败', e);
      return false;
    }
  }
  
  /**
   * 数据库行转换为 Project 模型
   */
  private rowToProject(row: ProjectRow | Partial<ProjectRow>): Project {
    return {
      id: row.id || '',
      name: row.title || '',
      description: row.description || '',
      createdDate: row.created_date || '',
      updatedAt: row.updated_at || undefined,
      version: row.version || 1,
      tasks: [],
      connections: []
    };
  }
}
