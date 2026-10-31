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
 * - `sync_upsert_project(payload)` / `sync_delete_project(payload)` —— project 写入/删除；
 * - `sync_delete_tasks(payload)` —— task 批量软删或 purge。
 *
 * 返回 `status`：`applied` / `idempotent-replay` / `remote-newer` /
 * `client-version-rejected` / `quarantined` / `unauthorized`。调用方按 status 走不同重试策略：
 * - `remote-newer` —— 必须先 pull+merge 再重新发起，**不能**简单重试；
 * - `client-version-rejected` —— 旧前端必须停止 flush 并提示更新；
 * - 网络错误 —— 调用方走原有 RetryQueue + circuit breaker 路径。
 *
 * Feature flag：`NG_APP_SYNC_RPC_ENABLED` (`environment.syncRpcEnabled`)。默认 false。
 * task / connection / blackbox push 路径在 flag 开启后通过本服务写入；默认 false 保持现有 PostgREST 路径。
 * 对已迁移环境，调用方可先执行 `checkProtocol()` 做能力探测，探测成功后会自动开启 RPC 写入。
 */

import { Injectable, inject, computed, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { environment } from '../environments/environment';
import type { Task, Connection, BlackBoxEntry, Project, UserPreferences } from '../models';
import type { FocusSessionRecord, RoutineCompletionMutation, RoutineTask } from '../models/parking-dock';
import { assertSyncOperationId } from '../utils/sync-operation-id';

export type SyncRpcStatus =
  | 'applied'
  | 'idempotent-replay'
  | 'remote-newer'
  | 'deleted-remote-newer'
  | 'client-version-rejected'
  | 'tombstoned'
  | 'quarantined'
  | 'unauthorized';

export interface SyncRpcResult {
  status: SyncRpcStatus;
  reason?: string;
  /** 服务端写入判定，保留用于 replay / last-write explain。 */
  decision?: string;
  /** 服务端确认的幂等 operation_id；null 表示服务端未能关联写入操作。 */
  operationId?: string | null;
  /** 服务端判定本次写入涉及的实体字段。 */
  changedFields?: string[];
  /** 服务端隔离记录 ID；null 表示没有对应隔离记录。 */
  quarantineId?: string | null;
  /** 服务端写入审计记录 ID；null 表示没有对应审计记录。 */
  auditId?: string | null;
  /** 服务端无法验证写入来源时为 true。 */
  originUnverified?: boolean;
  /** 当前请求 payload 的服务端摘要。 */
  payloadDigest?: string | null;
  /** 写入前服务端 payload 的摘要。 */
  existingPayloadDigest?: string | null;
  /** 幂等重放记录中的 payload 摘要。 */
  replayPayloadDigest?: string | null;
  /** `remote-newer` 时返回服务端当前 updated_at —— 调用方据此触发 pull。 */
  remoteUpdatedAt?: string;
  /** `applied` / `idempotent-replay` 时服务端写入后的 updated_at（若 RPC 返回）。 */
  serverUpdatedAt?: string;
  /** `client-version-rejected` 时返回服务端要求的最小 protocol。 */
  minProtocolVersion?: number;
  /** `applied` / `idempotent-replay` 时返回的实体 ID。 */
  entityId?: string;
  /** 服务端判定 payload 陈旧并保留了远端权威状态。 */
  stalePayload?: boolean;
  /** delete/batch RPC 返回的影响行数。 */
  affectedCount?: number;
  /** 任务 purge 时服务端返回、客户端后续异步清理的附件路径。 */
  attachmentPaths?: string[];
  /**
   * `sync_delete_tasks` 返回：服务端发现 existing.updated_at > base + 1s 而拒绝删除的 task id 列表。
   * 调用方应把这些 id 重排入 RetryQueue（走 pull+merge 路径），避免用陈旧 delete 覆盖远端最新状态。
   */
  skippedIds?: string[];
  raw: unknown;
}

export interface SyncProtocolInfo {
  minProtocolVersion: number;
  deploymentEpoch: number;
}

export type TaskWriteIntent =
  | 'task_full_upsert'
  | 'task_text_update'
  | 'task_structure_update'
  | 'task_soft_delete'
  | 'task_attachment_update';

interface SyncRpcEnvironmentSlice {
  syncRpcEnabled?: boolean;
  syncProtocolVersion?: number;
  deploymentEpoch?: number;
  deploymentTarget?: string;
  sentryRelease?: string;
  canonicalOrigin?: string;
}

@Injectable({ providedIn: 'root' })
export class SyncRpcClientService {
  private readonly logger = inject(LoggerService).category('SyncRpc');
  private readonly supabase = inject(SupabaseClientService);

  /** 当前客户端 protocol 版本（来自 environment，未配置时默认 1）。 */
  private readonly clientProtocolVersion = signal<number>(this.readClientProtocolVersion());

  /** 当前客户端 deployment epoch（来自 environment，未配置时默认 0）。 */
  private readonly clientDeploymentEpoch = signal<number>(this.readDeploymentEpoch());

  /** Feature flag（环境标志）。 */
  private readonly featureEnabled = signal<boolean>(this.readFeatureFlag());

  /** protocol 探测结果缓存；undefined 表示尚未探测（或上次为瞬时失败，可再探）。 */
  private protocolProbeResult: SyncProtocolInfo | null | undefined;

  /** in-flight protocol 探测去重。 */
  private protocolProbePromise: Promise<SyncProtocolInfo | null> | null = null;

  /**
   * 瞬时探测失败（网络/超时/无客户端）时间戳。
   * 弱网下一次失败不能被当成"服务端没有该 RPC"缓存整个会话——
   * 那会让 task 写入路径永远 blocked；只做短冷却，之后允许重探。
   */
  private protocolProbeTransientFailureAtMs: number | null = null;

  /** 瞬时探测失败后的再探测冷却窗口（避免每次写入都探测一次）。 */
  private static readonly PROTOCOL_PROBE_RETRY_COOLDOWN_MS = 60_000;

  /** 上次拉到的服务端 protocol 信息（启动时探测一次）。 */
  private readonly serverProtocol = signal<SyncProtocolInfo | null>(null);

  /** 客户端是否被服务端拒绝（min_protocol_version > clientProtocolVersion）。 */
  readonly isClientRejected = computed<boolean>(() => {
    const server = this.serverProtocol();
    if (server == null) return false;
    return server.minProtocolVersion > this.clientProtocolVersion()
      || server.deploymentEpoch > this.clientDeploymentEpoch();
  });

  readonly isFeatureEnabled = computed<boolean>(() => this.featureEnabled());

  /**
   * 启动探测：拉取服务端 minProtocolVersion / deploymentEpoch。
   *
   * - 失败时不抛错（保持向后兼容），仅记录 logger.warn；
   * - 服务端拒绝时调用方应停止 cloud push 并显示更新提示。
   */
  async checkProtocol(): Promise<SyncProtocolInfo | null> {
    if (this.protocolProbeResult !== undefined) {
      return this.protocolProbeResult;
    }

    if (this.isWithinProtocolProbeRetryCooldown()) {
      return null;
    }

    if (this.protocolProbePromise) {
      return this.protocolProbePromise;
    }

    this.protocolProbePromise = this.checkProtocolInternal();
    return this.protocolProbePromise;
  }

  private isWithinProtocolProbeRetryCooldown(): boolean {
    return this.protocolProbeTransientFailureAtMs !== null
      && Date.now() - this.protocolProbeTransientFailureAtMs
        < SyncRpcClientService.PROTOCOL_PROBE_RETRY_COOLDOWN_MS;
  }

  private recordTransientProtocolProbeFailure(message: string): void {
    this.protocolProbeTransientFailureAtMs = Date.now();
    this.logger.warn(
      `sync_check_protocol_transient_failure: ${message}（瞬时失败不缓存，冷却后允许重探）`,
    );
  }

  /** 服务端确定性"没有该 RPC"的错误码：PGRST202（schema cache 未找到函数）/ 42883（undefined_function）。 */
  private isDeterministicProtocolProbeError(error: { code?: unknown }): boolean {
    return error.code === 'PGRST202' || error.code === '42883';
  }

  private async checkProtocolInternal(): Promise<SyncProtocolInfo | null> {
    try {
      const client = await this.supabase.clientAsync();
      if (client == null) {
        this.recordTransientProtocolProbeFailure('supabase client unavailable');
        return null;
      }
      const { data, error } = await client.rpc('sync_check_protocol' as never);
      if (error) {
        if (this.isDeterministicProtocolProbeError(error)) {
          this.logger.warn(`sync_check_protocol_failed: ${error.message}`);
          this.protocolProbeResult = null;
          return null;
        }
        this.recordTransientProtocolProbeFailure(error.message);
        return null;
      }
      const parsed = this.parseProtocolInfo(data);
      if (parsed) {
        this.serverProtocol.set(parsed);
        const accepted = parsed.minProtocolVersion <= this.clientProtocolVersion()
          && parsed.deploymentEpoch <= this.clientDeploymentEpoch();
        if (!this.featureEnabled() && accepted) {
          this.featureEnabled.set(true);
          this.logger.info(
            `sync_rpc_auto_enabled: server_min=${parsed.minProtocolVersion}, client=${this.clientProtocolVersion()}, server_epoch=${parsed.deploymentEpoch}, client_epoch=${this.clientDeploymentEpoch()}`,
          );
        }
        if (!accepted) {
          this.logger.info(
            `sync_protocol_rejected: server_min=${parsed.minProtocolVersion}, client=${this.clientProtocolVersion()}, server_epoch=${parsed.deploymentEpoch}, client_epoch=${this.clientDeploymentEpoch()}`,
          );
        }
      }
      this.protocolProbeResult = parsed;
      this.protocolProbeTransientFailureAtMs = null;
      return parsed;
    } catch (err) {
      // 抛异常 = 网络/超时类瞬时失败，不缓存整个会话；冷却后允许重探。
      // 启动探测失败不应阻塞应用启动；返回 null 让调用方按未探测处理。
      this.recordTransientProtocolProbeFailure((err as Error)?.message ?? String(err));
      // eslint-disable-next-line no-restricted-syntax
      return null;
    } finally {
      this.protocolProbePromise = null;
    }
  }

  /** 客户端 task upsert RPC 包装。abortSignal 来自 throttle 超时 abort（终止幽灵写入）。 */
  async upsertTask(params: {
    operationId: string;
    task: Task;
    projectId?: string;
    baseUpdatedAt: string | null;
    writeIntent?: TaskWriteIntent;
    abortSignal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_task', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      task: this.serializeTask(params.task, params.projectId, params.writeIntent),
      ...this.buildAuditFields(),
    }, params.abortSignal, params.isCurrent);
  }

  /** 客户端 connection upsert RPC 包装。 */
  async upsertConnection(params: {
    operationId: string;
    connection: Connection;
    projectId?: string;
    baseUpdatedAt: string | null;
    abortSignal?: AbortSignal;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_connection', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      connection: this.serializeConnection(params.connection, params.projectId),
      ...this.buildAuditFields(),
    }, params.abortSignal);
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

  /** 客户端 project upsert RPC 包装。 */
  async upsertProject(params: {
    operationId: string;
    project: Project;
    ownerId: string;
    baseUpdatedAt: string | null;
    abortSignal?: AbortSignal;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_project', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      project: this.serializeProject(params.project, params.ownerId),
      ...this.buildAuditFields(),
    }, params.abortSignal);
  }

  /** 客户端 user_preferences upsert RPC 包装。 */
  async upsertUserPreferences(params: {
    operationId: string;
    userId: string;
    baseUpdatedAt: string | null;
    preferences: Partial<UserPreferences>;
    abortSignal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_user_preferences', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      user_id: params.userId,
      preferences: this.serializeUserPreferences(params.preferences),
      ...this.buildAuditFields(),
    }, params.abortSignal, params.isCurrent);
  }

  /** 客户端 focus session upsert RPC 包装。 */
  async upsertFocusSession(params: {
    operationId: string;
    record: FocusSessionRecord;
    abortSignal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_focus_session', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      focus_session: this.serializeFocusSession(params.record),
      ...this.buildAuditFields(),
    }, params.abortSignal, params.isCurrent);
  }

  /** 客户端 routine task upsert RPC 包装。 */
  async upsertRoutineTask(params: {
    operationId: string;
    userId: string;
    task: RoutineTask;
    abortSignal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_upsert_routine_task', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      user_id: params.userId,
      routine_task: this.serializeRoutineTask(params.task),
      ...this.buildAuditFields(),
    }, params.abortSignal, params.isCurrent);
  }

  /** 客户端 routine completion increment RPC 包装。 */
  async incrementRoutineCompletion(params: {
    operationId: string;
    mutation: RoutineCompletionMutation;
    abortSignal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_increment_routine_completion', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      user_id: params.mutation.userId,
      routine_completion: this.serializeRoutineCompletion(params.mutation),
      ...this.buildAuditFields(),
    }, params.abortSignal, params.isCurrent);
  }

  /** 客户端 project delete RPC 包装。 */
  async deleteProject(params: {
    operationId: string;
    projectId: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult> {
    return this.invokeRpc('sync_delete_project', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      project_id: params.projectId,
      ...this.buildAuditFields(),
    });
  }

  /** 客户端 task batch delete / purge RPC 包装。 */
  async deleteTasks(params: {
    operationId: string;
    projectId: string;
    taskIds: string[];
    baseUpdatedAt: string | null;
    deleteMode?: 'soft' | 'purge';
    /**
     * 可选：每个 task 在本地的 `updated_at` 快照。服务端用它做 stale-write 判定
     * （existing.updated_at > base + 1s 即跳过该 task 并写入 `skipped_ids`）。
     * null 表示缺少可靠基线；服务端必须跳过该 task，避免无保护删除。
     */
    baseUpdatedAtMap?: Record<string, string | null | undefined>;
    abortSignal?: AbortSignal;
  }): Promise<SyncRpcResult> {
    const baseMap = this.buildBaseUpdatedAtMap(params.taskIds, params.baseUpdatedAtMap);
    return this.invokeRpc('sync_delete_tasks', {
      operation_id: params.operationId,
      protocol_version: this.clientProtocolVersion(),
      base_updated_at: params.baseUpdatedAt,
      project_id: params.projectId,
      task_ids: params.taskIds,
      delete_mode: params.deleteMode ?? 'purge',
      ...(baseMap ? { base_updated_at_map: baseMap } : {}),
      ...this.buildAuditFields(),
    }, params.abortSignal);
  }

  /**
   * 仅保留 `task_ids` 范围内的条目；null 表示客户端知道该 task 缺少可靠基线。
   * 服务端必须把缺失基线视为 skipped，避免退化为无保护删除。
   */
  private buildBaseUpdatedAtMap(
    taskIds: string[],
    map: Record<string, string | null | undefined> | undefined,
  ): Record<string, string | null> | null {
    if (!map) return null;
    const filtered: Record<string, string | null> = {};
    let count = 0;
    for (const id of taskIds) {
      const value = map[id];
      if (typeof value === 'string' && value.length > 0) {
        filtered[id] = value;
        count++;
      } else if (value === null) {
        filtered[id] = null;
        count++;
      }
    }
    return count > 0 ? filtered : null;
  }

  // ---------------- internals ----------------

  private async invokeRpc(
    name: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<SyncRpcResult> {
    assertSyncOperationId(payload['operation_id']);
    if (isCurrent && !isCurrent()) return this.replayFenceStaleResult();
    const client = await this.supabase.clientAsync();
    if (isCurrent && !isCurrent()) return this.replayFenceStaleResult();
    if (client == null) {
      return {
        status: 'unauthorized',
        reason: 'supabase_client_unavailable',
        raw: null,
      };
    }
    if (isCurrent && !isCurrent()) return this.replayFenceStaleResult();
    const rpcBuilder = client.rpc(name as never, { payload } as never);
    if (signal && typeof (rpcBuilder as { abortSignal?: unknown }).abortSignal !== 'function') {
      throw new Error(`${name} RPC builder does not support abortSignal`);
    }
    const abortableBuilder = signal
      ? (rpcBuilder as unknown as { abortSignal: (signal: AbortSignal) => typeof rpcBuilder }).abortSignal(signal)
      : rpcBuilder;
    const { data, error } = await abortableBuilder;
    if (isCurrent && !isCurrent()) return this.replayFenceStaleResult();
    if (error) {
      // 网络/服务端错误：保持原始错误向上抛，调用方走 RetryQueue 路径。
      throw error;
    }
    return this.parseRpcResult(data);
  }

  private replayFenceStaleResult(): SyncRpcResult {
    return {
      status: 'unauthorized',
      reason: 'replay_fence_stale',
      raw: null,
    };
  }

  private parseRpcResult(raw: unknown): SyncRpcResult {
    const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const status = this.parseStatus(obj['status']);
    const result: SyncRpcResult = { status, raw, ...this.parseRpcDiagnostics(obj) };
    if (typeof obj['reason'] === 'string') result.reason = obj['reason'] as string;
    if (typeof obj['remote_updated_at'] === 'string') result.remoteUpdatedAt = obj['remote_updated_at'] as string;
    if (typeof obj['updated_at'] === 'string') result.serverUpdatedAt = obj['updated_at'] as string;
    if (typeof obj['minProtocolVersion'] === 'number') result.minProtocolVersion = obj['minProtocolVersion'] as number;
    if (typeof obj['stale_payload'] === 'boolean') result.stalePayload = obj['stale_payload'] as boolean;
    if (typeof obj['task_id'] === 'string') result.entityId = obj['task_id'] as string;
    else if (typeof obj['connection_id'] === 'string') result.entityId = obj['connection_id'] as string;
    else if (typeof obj['entry_id'] === 'string') result.entityId = obj['entry_id'] as string;
    else if (typeof obj['project_id'] === 'string') result.entityId = obj['project_id'] as string;
    else if (typeof obj['user_id'] === 'string') result.entityId = obj['user_id'] as string;
    else if (typeof obj['focus_session_id'] === 'string') result.entityId = obj['focus_session_id'] as string;
    else if (typeof obj['routine_task_id'] === 'string') result.entityId = obj['routine_task_id'] as string;
    else if (typeof obj['routine_completion_id'] === 'string') result.entityId = obj['routine_completion_id'] as string;
    if (typeof obj['deleted_count'] === 'number') result.affectedCount = obj['deleted_count'] as number;
    if (Array.isArray(obj['attachment_paths'])) {
      result.attachmentPaths = obj['attachment_paths'].filter((value): value is string => typeof value === 'string');
    }
    if (Array.isArray(obj['skipped_ids'])) {
      result.skippedIds = obj['skipped_ids'].filter((value): value is string => typeof value === 'string');
    }
    return result;
  }

  private parseRpcDiagnostics(obj: Record<string, unknown>): Partial<SyncRpcResult> {
    const diagnostics: Partial<SyncRpcResult> = {};
    if (typeof obj['decision'] === 'string') diagnostics.decision = obj['decision'];
    if (typeof obj['operation_id'] === 'string' || obj['operation_id'] === null) diagnostics.operationId = obj['operation_id'];
    if (Array.isArray(obj['changed_fields'])) {
      diagnostics.changedFields = obj['changed_fields'].filter((value): value is string => typeof value === 'string');
    }
    if (typeof obj['quarantine_id'] === 'string' || obj['quarantine_id'] === null) diagnostics.quarantineId = obj['quarantine_id'];
    if (typeof obj['audit_id'] === 'string' || obj['audit_id'] === null) diagnostics.auditId = obj['audit_id'];
    if (typeof obj['origin_unverified'] === 'boolean') diagnostics.originUnverified = obj['origin_unverified'];
    if (typeof obj['payload_digest'] === 'string' || obj['payload_digest'] === null) diagnostics.payloadDigest = obj['payload_digest'];
    if (typeof obj['existing_payload_digest'] === 'string' || obj['existing_payload_digest'] === null) diagnostics.existingPayloadDigest = obj['existing_payload_digest'];
    if (typeof obj['replay_payload_digest'] === 'string' || obj['replay_payload_digest'] === null) diagnostics.replayPayloadDigest = obj['replay_payload_digest'];
    return diagnostics;
  }

  private parseStatus(raw: unknown): SyncRpcStatus {
    const known: SyncRpcStatus[] = [
      'applied',
      'idempotent-replay',
      'remote-newer',
      'deleted-remote-newer',
      'client-version-rejected',
      'tombstoned',
      'quarantined',
      'unauthorized',
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

  private serializeTask(task: Task, projectId?: string, writeIntent?: TaskWriteIntent): Record<string, unknown> {
    // 仅传递服务端关心的字段，避免泄漏额外内部状态。
    const taskWithProject = task as Task & { projectId?: string; updatedAt?: string | null };
    const serialized: Record<string, unknown> = {
      ...this.serializeTaskIdentity(task, taskWithProject, projectId),
      ...this.serializeTaskStructure(task),
      ...this.serializeTaskPlanning(task),
      ...this.serializeTaskLifecycle(task, taskWithProject),
      ...this.serializeTaskCollections(task),
    };
    if (writeIntent) {
      serialized['write_intent'] = writeIntent;
      serialized['writeIntent'] = writeIntent;
    }
    return serialized;
  }

  private serializeTaskIdentity(
    task: Task,
    taskWithProject: Task & { projectId?: string },
    projectId?: string,
  ): Record<string, unknown> {
    return {
      id: task.id,
      project_id: projectId ?? taskWithProject.projectId,
      title: task.title,
      content: task.content ?? '',
    };
  }

  private serializeTaskStructure(task: Task): Record<string, unknown> {
    return {
      stage: task.stage ?? null,
      parent_id: task.parentId ?? null,
      parentId: task.parentId ?? null,
      order: task.order ?? 0,
      rank: task.rank ?? 10000,
      status: task.status ?? 'active',
      x: (task as unknown as { x?: number }).x ?? null,
      y: (task as unknown as { y?: number }).y ?? null,
      short_id: task.shortId ?? null,
      shortId: task.shortId ?? null,
    };
  }

  private serializeTaskPlanning(task: Task): Record<string, unknown> {
    return {
      priority: task.priority ?? null,
      due_date: task.dueDate ?? null,
      dueDate: task.dueDate ?? null,
      expected_minutes: task.expected_minutes ?? null,
      expectedMinutes: task.expected_minutes ?? null,
      cognitive_load: task.cognitive_load ?? null,
      cognitiveLoad: task.cognitive_load ?? null,
      wait_minutes: task.wait_minutes ?? null,
      waitMinutes: task.wait_minutes ?? null,
    };
  }

  private serializeTaskLifecycle(
    task: Task,
    taskWithProject: Task & { updatedAt?: string | null },
  ): Record<string, unknown> {
    return {
      completed_at: task.completedAt ?? null,
      completedAt: task.completedAt ?? null,
      updated_at: taskWithProject.updatedAt ?? null,
      deleted_at: task.deletedAt ?? null,
      deletedAt: task.deletedAt ?? null,
    };
  }

  private serializeTaskCollections(task: Task): Record<string, unknown> {
    return {
      tags: task.tags ?? [],
      attachments: task.attachments ?? [],
      parking_meta: task.parkingMeta ?? null,
      parkingMeta: task.parkingMeta ?? null,
      attention_meta: task.attentionMeta ?? null,
      attentionMeta: task.attentionMeta ?? null,
    };
  }

  private serializeConnection(conn: Connection, projectId?: string): Record<string, unknown> {
    const aliased = conn as Connection & {
      projectId?: string;
      sourceId?: string;
      targetId?: string;
      from?: string;
      to?: string;
      updatedAt?: string | null;
    };
    return {
      id: conn.id,
      project_id: projectId ?? aliased.projectId,
      source_id: aliased.sourceId ?? conn.source ?? aliased.from,
      target_id: aliased.targetId ?? conn.target ?? aliased.to,
      title: conn.title ?? null,
      description: conn.description ?? null,
      updated_at: aliased.updatedAt ?? null,
      deleted_at: conn.deletedAt ?? null,
    };
  }

  private serializeBlackboxEntry(entry: BlackBoxEntry): Record<string, unknown> {
    const content = (entry as unknown as { content?: unknown }).content;
    if (typeof content !== 'string') {
      throw new Error('BlackBox entry content is missing');
    }

    return {
      id: entry.id,
      project_id: entry.projectId,
      user_id: entry.userId,
      content,
      date: entry.date,
      created_at: (entry as unknown as { createdAt?: string }).createdAt ?? null,
      updated_at: entry.updatedAt,
      completed_at: entry.completedAt ?? null,
      completedAt: entry.completedAt ?? null,
      is_read: entry.isRead,
      is_completed: entry.isCompleted,
      is_archived: entry.isArchived,
      snooze_until: entry.snoozeUntil ?? null,
      snooze_count: entry.snoozeCount ?? 0,
      deleted_at: (entry as unknown as { deletedAt?: string }).deletedAt ?? null,
      focus_meta: entry.focusMeta ?? null,
    };
  }

  private serializeProject(project: Project, ownerId: string): Record<string, unknown> {
    const projectWithTimestamp = project as Project & { updatedAt?: string | null };
    return {
      id: project.id,
      owner_id: ownerId,
      title: project.name,
      description: project.description ?? null,
      version: project.version ?? 1,
      migrated_to_v2: true,
      updated_at: projectWithTimestamp.updatedAt ?? null,
      deleted_at: project.deletedAt ?? null,
    };
  }

  private serializeUserPreferences(preferences: Partial<UserPreferences>): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};
    if (preferences.theme !== undefined) serialized['theme'] = preferences.theme;
    if (preferences.layoutDirection !== undefined) serialized['layout_direction'] = preferences.layoutDirection;
    if (preferences.floatingWindowPref !== undefined) serialized['floating_window_pref'] = preferences.floatingWindowPref;
    if (preferences.colorMode !== undefined) serialized['color_mode'] = preferences.colorMode;
    if (preferences.autoResolveConflicts !== undefined) serialized['auto_resolve_conflicts'] = preferences.autoResolveConflicts;
    if (preferences.localBackupEnabled !== undefined) serialized['local_backup_enabled'] = preferences.localBackupEnabled;
    if (preferences.localBackupIntervalMs !== undefined) serialized['local_backup_interval_ms'] = preferences.localBackupIntervalMs;
    if (preferences.lastBackupProofAt !== undefined) serialized['last_backup_proof_at'] = preferences.lastBackupProofAt;
    if (preferences.focusPreferences !== undefined) serialized['focus_preferences'] = preferences.focusPreferences;
    return serialized;
  }

  private serializeFocusSession(record: FocusSessionRecord): Record<string, unknown> {
    return {
      id: record.id,
      user_id: record.userId,
      started_at: record.startedAt,
      ended_at: record.endedAt,
      session_state: record.snapshot,
      updated_at: record.updatedAt,
    };
  }

  private serializeRoutineTask(task: RoutineTask): Record<string, unknown> {
    return {
      id: task.routineId,
      title: task.title,
      max_times_per_day: task.maxTimesPerDay,
      is_enabled: task.isEnabled,
      updated_at: task.updatedAt ?? null,
    };
  }

  private serializeRoutineCompletion(mutation: RoutineCompletionMutation): Record<string, unknown> {
    return {
      id: mutation.completionId,
      routine_id: mutation.routineId,
      date_key: mutation.dateKey,
    };
  }

  private buildAuditFields(): Record<string, unknown> {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    return {
      client_git_sha: env.sentryRelease ?? null,
      client_origin: env.canonicalOrigin ?? (typeof location !== 'undefined' ? location.origin : null),
      deployment_epoch: typeof env.deploymentEpoch === 'number' ? env.deploymentEpoch : 0,
      deployment_target: env.deploymentTarget ?? null,
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

  private readDeploymentEpoch(): number {
    const env = environment as unknown as SyncRpcEnvironmentSlice;
    const value = env.deploymentEpoch;
    if (typeof value === 'number' && value >= 0) return value;
    return 0;
  }
}
