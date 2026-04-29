/**
 * SyncRpcClientService - 同步写入保护 RPC 客户端封装
 *
 * 计划 §6.4 / §16.26：服务端写入保护（CAS + idempotency + protocol fence）的客户端入口。
 *
 * 服务端契约见 supabase/migrations/20260429080000_sync_write_protection_rpcs.sql：
 * - `sync_check_protocol()` —— 启动时获取最小 protocol；
 * - `sync_upsert_task(payload)` —— task 写入；
 * - `sync_upsert_connection(payload)` —— connection 写入；
 * - `sync_upsert_blackbox_entry(payload)` —— blackbox 写入。
 *
 * 返回 `status`：`applied` / `idempotent-replay` / `remote-newer` /
 * `client-version-rejected` / `unauthorized`。调用方按 status 走不同重试策略：
 * - `remote-newer` —— 必须先 pull+merge 再重新发起，**不能**简单重试；
 * - `client-version-rejected` —— 旧前端必须停止 flush 并提示更新；
 * - 网络错误 —— 调用方走原有 RetryQueue + circuit breaker 路径。
 *
 * Feature flag：`NG_APP_SYNC_RPC_ENABLED` (`environment.syncRpcEnabled`)。默认 false。
 * 本服务**只暴露 API**；调用方在 flag 开启后再切换 push 路径，由独立 PR 完成。
 */

import { Injectable, inject, computed, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { environment } from '../environments/environment';
import type { Task, Connection, BlackBoxEntry } from '../models';

export type SyncRpcStatus =
  | 'applied'
  | 'idempotent-replay'
  | 'remote-newer'
  | 'client-version-rejected'
  | 'unauthorized';

export interface SyncRpcResult {
  status: SyncRpcStatus;
  reason?: string;
  /** `remote-newer` 时返回服务端当前 updated_at —— 调用方据此触发 pull。 */
  remoteUpdatedAt?: string;
  /** `client-version-rejected` 时返回服务端要求的最小 protocol。 */
  minProtocolVersion?: number;
  /** `applied` / `idempotent-replay` 时返回的实体 ID。 */
  entityId?: string;
  raw: unknown;
}

export interface SyncProtocolInfo {
  minProtocolVersion: number;
  deploymentEpoch: number;
}

interface SyncRpcEnvironmentSlice {
  syncRpcEnabled?: boolean;
  syncProtocolVersion?: number;
}

@Injectable({ providedIn: 'root' })
export class SyncRpcClientService {
  private readonly logger = inject(LoggerService).category('SyncRpc');
  private readonly supabase = inject(SupabaseClientService);

  /** 当前客户端 protocol 版本（来自 environment，未配置时默认 1）。 */
  private readonly clientProtocolVersion = signal<number>(this.readClientProtocolVersion());

  /** Feature flag（环境标志）。 */
  private readonly featureEnabled = signal<boolean>(this.readFeatureFlag());

  /** 上次拉到的服务端 protocol 信息（启动时探测一次）。 */
  private readonly serverProtocol = signal<SyncProtocolInfo | null>(null);

  /** 客户端是否被服务端拒绝（min_protocol_version > clientProtocolVersion）。 */
  readonly isClientRejected = computed<boolean>(() => {
    const server = this.serverProtocol();
    if (server == null) return false;
    return server.minProtocolVersion > this.clientProtocolVersion();
  });

  readonly isFeatureEnabled = computed<boolean>(() => this.featureEnabled());

  /**
   * 启动探测：拉取服务端 minProtocolVersion / deploymentEpoch。
   *
   * - 失败时不抛错（保持向后兼容），仅记录 logger.warn；
   * - 服务端拒绝时调用方应停止 cloud push 并显示更新提示。
   */
  async checkProtocol(): Promise<SyncProtocolInfo | null> {
    if (!this.featureEnabled()) return null;
    try {
      const client = await this.supabase.clientAsync();
      if (client == null) return null;
      const { data, error } = await client.rpc('sync_check_protocol' as never);
      if (error) {
        this.logger.warn(`sync_check_protocol_failed: ${error.message}`);
        return null;
      }
      const parsed = this.parseProtocolInfo(data);
      if (parsed) {
        this.serverProtocol.set(parsed);
        if (parsed.minProtocolVersion > this.clientProtocolVersion()) {
          this.logger.info(`sync_protocol_rejected: server_min=${parsed.minProtocolVersion}, client=${this.clientProtocolVersion()}`);
        }
      }
      return parsed;
    } catch (err) {
      this.logger.warn(`sync_check_protocol_threw: ${(err as Error)?.message ?? err}`);
      // 启动探测失败不应阻塞应用启动；返回 null 让调用方按未探测处理。
      // eslint-disable-next-line no-restricted-syntax
      return null;
    }
  }

  /** 客户端 task upsert RPC 包装。 */
  async upsertTask(params: {
    operationId: string;
    task: Task;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_task', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      task: this.serializeTask(params.task),
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 connection upsert RPC 包装。 */
  async upsertConnection(params: {
    operationId: string;
    connection: Connection;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_connection', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      connection: this.serializeConnection(params.connection),
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 blackbox entry upsert RPC 包装。 */
  async upsertBlackboxEntry(params: {
    operationId: string;
    entry: BlackBoxEntry;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_blackbox_entry', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      entry: this.serializeBlackboxEntry(params.entry),
      ...this.buildAuditFields(),
    });
  }

  // ---------------- internals ----------------

  private async invokeRpc(name: string, payload: Record<string, unknown>): Promise<SyncRpcResult> {
    const client = await this.supabase.clientAsync();
    if (client == null) {
      return {
        status: 'unauthorized',
        reason: 'supabase_client_unavailable',
        raw: null,
      };
    }
    const { data, error } = await client.rpc(name as never, { payload } as never);
    if (error) {
      // 网络/服务端错误：保持原始错误向上抛，调用方走 RetryQueue 路径。
      throw error;
    }
    return this.parseRpcResult(data);
  }

  private parseRpcResult(raw: unknown): SyncRpcResult {
    const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const status = this.parseStatus(obj['status']);
    const result: SyncRpcResult = { status, raw };
    if (typeof obj['reason'] === 'string') result.reason = obj['reason'] as string;
    if (typeof obj['remote_updated_at'] === 'string') result.remoteUpdatedAt = obj['remote_updated_at'] as string;
    if (typeof obj['minProtocolVersion'] === 'number') result.minProtocolVersion = obj['minProtocolVersion'] as number;
    if (typeof obj['task_id'] === 'string') result.entityId = obj['task_id'] as string;
    else if (typeof obj['connection_id'] === 'string') result.entityId = obj['connection_id'] as string;
    else if (typeof obj['entry_id'] === 'string') result.entityId = obj['entry_id'] as string;
    return result;
  }

  private parseStatus(raw: unknown): SyncRpcStatus {
    const known: SyncRpcStatus[] = [
      'applied', 'idempotent-replay', 'remote-newer', 'client-version-rejected', 'unauthorized',
    ];
    if (typeof raw === 'string' && (known as string[]).includes(raw)) {
      return raw as SyncRpcStatus;
    }
    return 'unauthorized';
  }

  private parseProtocolInfo(raw: unknown): SyncProtocolInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const min = obj['minProtocolVersion'];
    const epoch = obj['deploymentEpoch'];
    if (typeof min !== 'number') return null;
    return {
      minProtocolVersion: min,
      deploymentEpoch: typeof epoch === 'number' ? epoch : 0,
    };
  }

  private serializeTask(task: Task): Record<string, unknown> {
    // 仅传递服务端关心的字段，避免泄漏额外内部状态。
    return {
      id: task.id,
      project_id: task.projectId,
      content: task.content ?? '',
      stage: (task as unknown as { stage?: number }).stage ?? null,
      x: (task as unknown as { x?: number }).x ?? null,
      y: (task as unknown as { y?: number }).y ?? null,
      deleted_at: (task as unknown as { deletedAt?: string | null }).deletedAt ?? null,
    };
  }

  private serializeConnection(conn: Connection): Record<string, unknown> {
    return {
      id: conn.id,
      project_id: (conn as unknown as { projectId?: string }).projectId,
      source_id: (conn as unknown as { sourceId?: string; from?: string }).sourceId
        ?? (conn as unknown as { from?: string }).from,
      target_id: (conn as unknown as { targetId?: string; to?: string }).targetId
        ?? (conn as unknown as { to?: string }).to,
    };
  }

  private serializeBlackboxEntry(entry: BlackBoxEntry): Record<string, unknown> {
    return {
      id: entry.id,
      content: (entry as unknown as { content?: string }).content ?? '',
      created_at: (entry as unknown as { createdAt?: string }).createdAt ?? null,
      deleted_at: (entry as unknown as { deletedAt?: string }).deletedAt ?? null,
    };
  }

  private buildAuditFields(): Record<string, unknown> {
    const env = environment as unknown as { sentryRelease?: string; canonicalOrigin?: string };
    return {
      client_git_sha: env.sentryRelease ?? null,
      client_origin: env.canonicalOrigin ?? (typeof location !== 'undefined' ? location.origin : null),
    };
  }

  private readFeatureFlag(): boolean {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    return env.syncRpcEnabled === true;
  }

  private readClientProtocolVersion(): number {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    const v = env.syncProtocolVersion;
    if (typeof v === 'number' && v > 0) return v;
    return 1;
  }
}
