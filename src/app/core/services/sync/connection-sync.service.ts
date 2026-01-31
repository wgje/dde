/**
 * ConnectionSyncService - 连接同步服务
 * 
 * 职责：
 * - 连接推送到云端 (pushConnection)
 * - 连接拉取 (pullConnections)
 * - 连接删除 (deleteConnectionFromCloud)
 * - 连接墓碑管理
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 7 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { RetryQueueService } from './retry-queue.service';
import { Connection } from '../../../../models';
import { ConnectionRow } from '../../../../models/supabase-types';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { FIELD_SELECT_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class ConnectionSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncState = inject(SyncStateService);
  private readonly tombstone = inject(TombstoneService);
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
   * 推送连接到云端
   */
  async pushConnection(
    connection: Connection,
    projectId: string,
    fromRetryQueue = false
  ): Promise<boolean> {
    if (this.syncState.isSessionExpired()) {
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.retryQueue.add('connection', 'upsert', { id: connection.id });
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
        `push-connection:${connection.id}`,
        async () => {
          const { error } = await client
            .from('task_connections')
            .upsert({
              id: connection.id,
              project_id: projectId,
              source_id: connection.source,
              target_id: connection.target,
              title: connection.title || null,
              description: connection.description || null,
              updated_at: nowISO()
            });
          
          if (error) throw supabaseErrorToError(error);
        },
        { priority: 'normal', retries: 2 }
      );
      
      return true;
    } catch (e) {
      this.logger.error('推送连接失败', e);
      
      if (!fromRetryQueue) {
        this.retryQueue.add('connection', 'upsert', { id: connection.id });
      }
      return false;
    }
  }
  
  /**
   * 拉取连接列表
   */
  async pullConnections(projectId: string): Promise<Connection[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      const { data, error } = await client
        .from('task_connections')
        .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
        .eq('project_id', projectId)
        .is('deleted_at', null);
      
      if (error) throw supabaseErrorToError(error);
      
      // 过滤墓碑
      const tombstoneIds = await this.getConnectionTombstoneIds(projectId);
      const filtered = (data || []).filter(
        row => !tombstoneIds.has(row.id)
      );
      
      return filtered.map(row => this.rowToConnection(row as ConnectionRow));
    } catch (e) {
      this.logger.error('拉取连接失败', e);
      return [];
    }
  }
  
  /**
   * 删除云端连接
   */
  async deleteConnectionFromCloud(connectionId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      const { error } = await client
        .from('task_connections')
        .update({ deleted_at: nowISO() })
        .eq('id', connectionId);
      
      if (error) throw supabaseErrorToError(error);
      
      // 添加墓碑记录
      this.tombstone.recordConnectionDeletion(connectionId, Date.now());
      
      return true;
    } catch (e) {
      this.logger.error('删除连接失败', e);
      return false;
    }
  }
  
  /**
   * 批量软删除连接
   */
  async softDeleteConnectionsBatch(connectionIds: string[]): Promise<boolean> {
    if (connectionIds.length === 0) return true;
    
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      const { error } = await client
        .from('task_connections')
        .update({ deleted_at: nowISO() })
        .in('id', connectionIds);
      
      if (error) throw supabaseErrorToError(error);
      
      // 添加墓碑记录
      const now = Date.now();
      for (const id of connectionIds) {
        this.tombstone.recordConnectionDeletion(id, now);
      }
      
      return true;
    } catch (e) {
      this.logger.error('批量删除连接失败', e);
      return false;
    }
  }
  
  /**
   * 获取连接墓碑 ID 集合
   */
  private async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    const tombstones = this.tombstone.getConnectionTombstones();
    return new Set(tombstones.map(t => t.id));
  }
  
  /**
   * 数据库行转换为 Connection 模型
   */
  private rowToConnection(row: ConnectionRow | Partial<ConnectionRow>): Connection {
    return {
      id: row.id || '',
      source: row.source_id || '',
      target: row.target_id || '',
      title: row.title || undefined,
      description: row.description || undefined
    };
  }
}
