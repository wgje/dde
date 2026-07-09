import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { LoggerService } from '../../../../services/logger.service';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { supabaseErrorToError } from '../../../../utils/supabase-error';

export interface ProjectHead {
  id: string;
  updatedAt: string;
  version: number;
}

export interface AccessibleProjectProbe {
  projectId: string;
  accessible: boolean;
  watermark: string | null;
}

export interface ResumeRecoveryProbe {
  activeProjectId: string | null;
  activeAccessible: boolean;
  activeWatermark: string | null;
  projectsWatermark: string | null;
  blackboxWatermark: string | null;
  serverNow: string | null;
}

export type ProjectSyncProbeClientProvider = () => Promise<SupabaseClient | null>;
export type ProjectSyncProbeAuthRetryHandler = <T>(context: string, fn: () => Promise<T>) => Promise<T>;

export interface ProjectSyncProbeDependencies {
  getClient: ProjectSyncProbeClientProvider;
  withAuthRetry: ProjectSyncProbeAuthRetryHandler;
}

@Injectable({ providedIn: 'root' })
export class ProjectSyncProbeService {
  private readonly logger = inject(LoggerService).category('ProjectData');

  async getProjectSyncWatermark(
    projectId: string,
    dependencies: ProjectSyncProbeDependencies,
  ): Promise<string | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      return null;
    }

    const client = await dependencies.getClient();
    if (!client) return null;

    try {
      return await dependencies.withAuthRetry('getProjectSyncWatermark', async () => {
        const { data, error } = await client.rpc('get_project_sync_watermark', {
          p_project_id: projectId,
        });

        if (error) {
          throw supabaseErrorToError(error);
        }

        return this.readRpcString(data);
      });
    } catch (error) {
      if (this.isSuspended(error)) {
        return null;
      }
      this.logger.warn('获取项目同步水位失败', {
        projectId,
        error: supabaseErrorToError(error).message,
      });
      // eslint-disable-next-line no-restricted-syntax -- 水位 RPC 失败时降级为慢路拉取，由调用方决定后续策略
      return null;
    }
  }

  async getUserProjectsWatermark(
    dependencies: ProjectSyncProbeDependencies,
  ): Promise<string | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      return null;
    }

    const client = await dependencies.getClient();
    if (!client) return null;

    try {
      return await dependencies.withAuthRetry('getUserProjectsWatermark', async () => {
        const { data, error } = await client.rpc('get_user_projects_watermark');
        if (error) {
          throw supabaseErrorToError(error);
        }

        return this.readRpcString(data);
      });
    } catch (error) {
      if (this.isSuspended(error)) {
        return null;
      }
      this.logger.warn('获取用户项目域同步水位失败', {
        error: supabaseErrorToError(error).message,
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时降级为全量拉取（null 触发 fallback）
      return null;
    }
  }

  async listProjectHeadsSince(
    watermark: string | null,
    dependencies: ProjectSyncProbeDependencies,
  ): Promise<ProjectHead[]> {
    if (isBrowserNetworkSuspendedWindow()) {
      return [];
    }

    const client = await dependencies.getClient();
    if (!client) return [];

    try {
      return await dependencies.withAuthRetry('listProjectHeadsSince', async () => {
        const { data, error } = await client.rpc('list_project_heads_since', {
          p_since: watermark,
        });
        if (error) {
          throw supabaseErrorToError(error);
        }

        const rows = Array.isArray(data) ? data : [];
        return rows
          .map((row) => this.toProjectHead(row))
          .filter((row): row is ProjectHead => row !== null);
      });
    } catch (error) {
      if (this.isSuspended(error)) {
        return [];
      }
      this.logger.warn('拉取项目头信息失败', {
        watermark,
        error: supabaseErrorToError(error).message,
      });
      return [];
    }
  }

  async getAccessibleProjectProbe(
    projectId: string,
    dependencies: ProjectSyncProbeDependencies,
  ): Promise<AccessibleProjectProbe | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      return null;
    }

    const client = await dependencies.getClient();
    if (!client) return null;

    try {
      return await dependencies.withAuthRetry('getAccessibleProjectProbe', async () => {
        const { data, error } = await client.rpc('get_accessible_project_probe', {
          p_project_id: projectId,
        });
        if (error) {
          throw supabaseErrorToError(error);
        }

        const row = Array.isArray(data) ? data[0] : data;
        const record = this.asRecord(row);
        if (!record) return null;

        return {
          projectId: String(record['project_id'] ?? projectId),
          accessible: Boolean(record['accessible']),
          watermark: record['watermark'] ? String(record['watermark']) : null,
        };
      });
    } catch (error) {
      if (this.isSuspended(error)) {
        return null;
      }
      this.logger.warn('获取项目访问探测失败', {
        projectId,
        error: supabaseErrorToError(error).message,
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时返回 null 触发调用方降级逻辑
      return null;
    }
  }

  async getBlackBoxSyncWatermark(
    dependencies: ProjectSyncProbeDependencies,
  ): Promise<string | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      return null;
    }

    const client = await dependencies.getClient();
    if (!client) return null;

    try {
      return await dependencies.withAuthRetry('getBlackBoxSyncWatermark', async () => {
        const { data, error } = await client.rpc('get_black_box_sync_watermark');
        if (error) {
          throw supabaseErrorToError(error);
        }

        return this.readRpcString(data);
      });
    } catch (error) {
      if (this.isSuspended(error)) {
        return null;
      }
      this.logger.warn('获取黑匣子同步水位失败', {
        error: supabaseErrorToError(error).message,
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时降级为明细拉取（null 触发 fallback）
      return null;
    }
  }

  async getResumeRecoveryProbe(
    projectId: string | undefined,
    dependencies: ProjectSyncProbeDependencies,
  ): Promise<ResumeRecoveryProbe | null> {
    if (isBrowserNetworkSuspendedWindow()) {
      return null;
    }

    const client = await dependencies.getClient();
    if (!client) return null;

    try {
      return await dependencies.withAuthRetry('getResumeRecoveryProbe', async () => {
        const { data, error } = await client.rpc('get_resume_recovery_probe', {
          p_project_id: projectId ?? null,
        });
        if (error) {
          throw supabaseErrorToError(error);
        }

        const row = Array.isArray(data) ? data[0] : data;
        const record = this.asRecord(row);
        if (!record) return null;

        return {
          activeProjectId: record['active_project_id'] ? String(record['active_project_id']) : null,
          activeAccessible: Boolean(record['active_accessible']),
          activeWatermark: record['active_watermark'] ? String(record['active_watermark']) : null,
          projectsWatermark: record['projects_watermark'] ? String(record['projects_watermark']) : null,
          blackboxWatermark: record['blackbox_watermark'] ? String(record['blackbox_watermark']) : null,
          serverNow: record['server_now'] ? String(record['server_now']) : null,
        };
      });
    } catch (error) {
      if (this.isSuspended(error)) {
        return null;
      }
      this.logger.warn('恢复链路聚合探测失败，降级为分步探测', {
        projectId,
        error: supabaseErrorToError(error).message,
      });
      // eslint-disable-next-line no-restricted-syntax -- 聚合 RPC 失败时降级为分步探测（null 触发调用方 fallback）
      return null;
    }
  }

  private readRpcString(data: unknown): string | null {
    if (typeof data === 'string') {
      return data;
    }

    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
      return data[0];
    }

    return null;
  }

  private toProjectHead(row: unknown): ProjectHead | null {
    const record = this.asRecord(row);
    if (!record) return null;

    const head = {
      id: String(record['project_id'] ?? ''),
      updatedAt: String(record['updated_at'] ?? ''),
      version: Number(record['version'] ?? 1),
    };

    return head.id && head.updatedAt ? head : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object'
      ? value as Record<string, unknown>
      : null;
  }

  private isSuspended(error: unknown): boolean {
    return isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow();
  }
}
