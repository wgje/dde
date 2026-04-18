import { Injectable, VERSION, inject } from '@angular/core';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import { environment } from '../environments/environment';
import {
  ErrorCodes,
  extractErrorMessage,
  failure,
  humanizeErrorMessage,
  success,
  type OperationError,
  type Result,
} from '../utils/result';
import type { AndroidWidgetBootstrapRequest } from '../utils/startup-entry-intent';
import { withTimeout } from '../utils/timeout';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';

export interface WidgetRevokeAllResult {
  revokedCount: number;
}

export interface WidgetRegisterResult {
  deviceId: string;
  bindingGeneration: number;
  expiresAt: string;
  widgetToken: string;
  instanceId: string | null;
}

export interface AndroidWidgetBootstrapCallbackResult extends WidgetRegisterResult {
  callbackUrl: string;
  callbackIntentUrl: string;
}

/** IndexedDB 常量，与 widget-runtime.js 保持一致 */
const WIDGET_DB_NAME = 'nanoflow-widget';
const WIDGET_DB_STORE = 'config';
const WIDGET_TOKEN_KEY = 'widget-token';
const WIDGET_CONFIG_KEY = 'widget-config';
const WIDGET_INSTANCE_STATE_KEY = 'widget-instance-state';

interface WidgetRuntimeInstanceBinding {
  instanceId: string;
  hostInstanceId: string;
  sizeBucket: string;
  observedAt: string;
}

interface WidgetRuntimePendingInstance {
  hostInstanceId: string;
  sizeBucket: string;
  observedAt: string;
}

interface WidgetRuntimeInstanceState {
  instances: Record<string, WidgetRuntimePendingInstance>;
}

interface WidgetRuntimeConfig {
  supabaseUrl: string;
  clientVersion?: string | null;
  clientSurface?: string | null;
  deviceId?: string | null;
  installationId?: string | null;
  deviceSecret?: string | null;
  instanceBindings?: Record<string, WidgetRuntimeInstanceBinding>;
}

@Injectable({ providedIn: 'root' })
export class WidgetBindingService {
  private readonly logger = inject(LoggerService).category('WidgetBinding');
  private readonly supabase = inject(SupabaseClientService);

  async revokeAllBindings(): Promise<Result<WidgetRevokeAllResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return success({ revokedCount: 0 });
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪，无法吊销 Widget 绑定');
      }

      const { data, error } = await withTimeout(
        client.functions.invoke('widget-register', {
          body: { action: 'revoke-all' },
        }),
        {
          timeout: TIMEOUT_CONFIG.QUICK,
          timeoutMessage: 'Widget revoke-all 超时',
        },
      );

      if (error) {
        const message = humanizeErrorMessage(error.message ?? 'Widget revoke-all 调用失败');
        this.logger.warn('Widget revoke-all 调用失败', { message });
        return failure(ErrorCodes.OPERATION_FAILED, message);
      }

      // 吊销后清理 SW 侧的 widget token
      await this.clearWidgetTokenFromDb().catch(() => {});

      const revokedCount = this.extractRevokedCount(data);
      // OBS-11: widget_account_switch_cleanup — 记录 Web 端登出/换号清理结果
      this.logger.info('[WidgetTelemetry] widget_account_switch_cleanup', {
        surface: 'web',
        revokedCount,
      });
      return success({ revokedCount });
    } catch (error) {
      const message = humanizeErrorMessage(extractErrorMessage(error));
      this.logger.warn('Widget revoke-all 异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  /**
   * 注册 Widget 设备绑定并将 token 写入 IndexedDB 供 SW 读取
   */
  async registerDevice(params: {
    deviceId: string;
    installationId: string;
    deviceSecret: string;
    platform: string;
    pushToken?: string | null;
    clientVersion?: string | null;
    clientSurface?: string | null;
    instance?: { id: string; hostInstanceId: string; sizeBucket: string };
    persistRuntimeBinding?: boolean;
  }): Promise<Result<WidgetRegisterResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(ErrorCodes.OPERATION_FAILED, 'Supabase 未配置');
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪');
      }

      const clientVersion = this.normalizeOptionalText(params.clientVersion)
        ?? (params.platform === 'android-widget' ? null : this.resolveWidgetClientVersion());
      const clientSurface = this.normalizeOptionalText(params.clientSurface, 128)
        ?? (params.platform === 'android-widget'
          ? (clientVersion ? 'android-host' : null)
          : 'web-app');
      const capabilities = clientVersion || clientSurface
        ? {
            clientContext: {
              clientVersion,
              clientSurface,
            },
          }
        : undefined;

      const { data, error } = await withTimeout(
        client.functions.invoke('widget-register', {
          body: {
            action: 'register',
            deviceId: params.deviceId,
            installationId: params.installationId,
            deviceSecret: params.deviceSecret,
            platform: params.platform,
            pushToken: params.pushToken,
            ...(capabilities ? { capabilities } : {}),
            instance: params.instance ?? null,
          },
        }),
        {
          timeout: TIMEOUT_CONFIG.STANDARD,
          timeoutMessage: 'Widget register 超时',
        },
      );

      if (error) {
        const message = humanizeErrorMessage(error.message ?? 'Widget register 调用失败');
        this.logger.warn('Widget register 调用失败', { message });
        return failure(ErrorCodes.OPERATION_FAILED, message);
      }

      const response = data as Record<string, unknown> | null;
      if (!response || typeof response.widgetToken !== 'string') {
        return failure(ErrorCodes.OPERATION_FAILED, 'Widget register 响应格式异常');
      }

      if (params.persistRuntimeBinding !== false) {
        // 将 widget token 写入 IndexedDB 供 SW 读取
        await this.writeWidgetTokenToDb(response.widgetToken as string);
        // 将 Supabase URL 写入 IndexedDB 供 SW 构造请求
        const existingRuntimeConfig = await this.readWidgetConfigFromDb();
        await this.writeWidgetConfigToDb({
          ...(existingRuntimeConfig ?? {}),
          supabaseUrl: environment.supabaseUrl,
          clientVersion,
          clientSurface,
        });

        // 通知 SW 刷新 widget
        this.notifySwRefresh();
      }

      const result: WidgetRegisterResult = {
        deviceId: response.deviceId as string,
        bindingGeneration: response.bindingGeneration as number,
        expiresAt: response.expiresAt as string,
        widgetToken: response.widgetToken as string,
        instanceId: response.instance
          ? (response.instance as { id: string }).id
          : null,
      };

      return success(result);
    } catch (error) {
      const message = humanizeErrorMessage(extractErrorMessage(error));
      this.logger.warn('Widget register 异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  async syncWindowsPwaBindings(): Promise<Result<{ registeredCount: number }, OperationError>> {
    if (typeof window === 'undefined' || typeof indexedDB === 'undefined' || typeof crypto === 'undefined') {
      return success({ registeredCount: 0 });
    }

    if (!this.supabase.isConfigured) {
      return success({ registeredCount: 0 });
    }

    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request(
        'nanoflow-widget-binding-sync',
        { ifAvailable: true },
        async (lock): Promise<Result<{ registeredCount: number }, OperationError>> => {
          if (!lock) {
            return success({ registeredCount: 0 });
          }

          return this.syncWindowsPwaBindingsLocked();
        },
      );
    }

    return this.syncWindowsPwaBindingsLocked();
  }

  private async syncWindowsPwaBindingsLocked(): Promise<Result<{ registeredCount: number }, OperationError>> {
    if (typeof crypto === 'undefined') {
      return success({ registeredCount: 0 });
    }

    try {
      const pendingState = await this.readPendingWidgetInstanceStateFromDb();
      const pendingInstances = Object.values(pendingState.instances);

      const existingRuntimeConfig = await this.readWidgetConfigFromDb();
      const clientVersion = this.resolveWidgetClientVersion();
      const previousClientVersion = this.normalizeOptionalText(existingRuntimeConfig?.clientVersion ?? null);
      const instanceBindings = this.normalizeWidgetInstanceBindings(existingRuntimeConfig?.instanceBindings);
      const activeHostInstanceIds = new Set(pendingInstances.map(instance => instance.hostInstanceId));
      const removedBindings = Object.values(instanceBindings)
        .filter(binding => !activeHostInstanceIds.has(binding.hostInstanceId));
      let removedCount = 0;

      for (const removedBinding of removedBindings) {
        const uninstallResult = await this.uninstallWidgetInstance({
          deviceId: this.normalizeUuidLike(existingRuntimeConfig?.deviceId),
          installationId: this.normalizeUuidLike(existingRuntimeConfig?.installationId),
          platform: 'windows-pwa',
          instance: removedBinding,
        });

        if (!uninstallResult.ok) {
          this.logger.warn('Windows Widget 实例卸载同步失败', {
            code: uninstallResult.error.code,
            message: uninstallResult.error.message,
            hostInstanceId: removedBinding.hostInstanceId,
          });
          continue;
        }

        if (uninstallResult.value !== true) {
          this.logger.warn('Windows Widget 实例卸载未获服务端确认', {
            hostInstanceId: removedBinding.hostInstanceId,
            instanceId: removedBinding.instanceId,
          });
          continue;
        }

        delete instanceBindings[removedBinding.hostInstanceId];
        removedCount += 1;
      }

      if (pendingInstances.length === 0) {
        if (removedCount > 0) {
          await this.clearWidgetTokenFromDb().catch(() => {});
        }
        return success({ registeredCount: 0 });
      }

      const runtimeConfig: WidgetRuntimeConfig = {
        supabaseUrl: environment.supabaseUrl,
        clientVersion,
        clientSurface: 'windows-pwa',
        deviceId: this.normalizeUuidLike(existingRuntimeConfig?.deviceId) ?? crypto.randomUUID(),
        installationId: this.normalizeUuidLike(existingRuntimeConfig?.installationId) ?? crypto.randomUUID(),
        deviceSecret: this.normalizeDeviceSecret(existingRuntimeConfig?.deviceSecret) ?? this.createWidgetDeviceSecret(),
        instanceBindings,
      };

      let lastRegisterResult: WidgetRegisterResult | null = null;
      let firstFailure: OperationError | null = null;
      let registeredCount = 0;

      for (const pendingInstance of pendingInstances) {
        const existingBinding = instanceBindings[pendingInstance.hostInstanceId];
        const requiresSync = !existingBinding
          || existingBinding.sizeBucket !== pendingInstance.sizeBucket
          || previousClientVersion !== clientVersion;

        if (!requiresSync) {
          continue;
        }

        const requestedInstanceId = existingBinding?.instanceId ?? crypto.randomUUID();
        const registerResult = await this.registerDevice({
          deviceId: runtimeConfig.deviceId,
          installationId: runtimeConfig.installationId,
          deviceSecret: runtimeConfig.deviceSecret,
          platform: 'windows-pwa',
          clientVersion,
          clientSurface: 'windows-pwa',
          instance: {
            id: requestedInstanceId,
            hostInstanceId: pendingInstance.hostInstanceId,
            sizeBucket: pendingInstance.sizeBucket,
          },
          persistRuntimeBinding: false,
        });

        if (!registerResult.ok) {
          firstFailure ??= registerResult.error;
          this.logger.warn('Windows Widget 绑定同步失败', {
            code: registerResult.error.code,
            message: registerResult.error.message,
            hostInstanceId: pendingInstance.hostInstanceId,
          });
          continue;
        }

        lastRegisterResult = registerResult.value;
        registeredCount += 1;
        instanceBindings[pendingInstance.hostInstanceId] = {
          instanceId: registerResult.value.instanceId ?? requestedInstanceId,
          hostInstanceId: pendingInstance.hostInstanceId,
          sizeBucket: pendingInstance.sizeBucket,
          observedAt: pendingInstance.observedAt,
        };
      }

      runtimeConfig.instanceBindings = this.pickActiveInstanceBindings(instanceBindings, pendingInstances);

      if (!lastRegisterResult) {
        if (removedCount > 0) {
          await this.writeWidgetConfigToDb(runtimeConfig);
        }
        if (firstFailure) {
          return failure(firstFailure.code, firstFailure.message);
        }
        return success({ registeredCount: 0 });
      }

      await this.writeWidgetTokenToDb(lastRegisterResult.widgetToken);
      await this.writeWidgetConfigToDb(runtimeConfig);
      this.notifySwRefresh();
      return success({ registeredCount });
    } catch (error) {
      const message = humanizeErrorMessage(extractErrorMessage(error));
      this.logger.warn('Windows Widget 绑定同步异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  async completeAndroidBootstrap(
    request: AndroidWidgetBootstrapRequest,
  ): Promise<Result<AndroidWidgetBootstrapCallbackResult, OperationError>> {
    const registerResult = await this.registerDevice({
      deviceId: request.deviceId,
      installationId: request.installationId,
      deviceSecret: request.deviceSecret,
      platform: 'android-widget',
      pushToken: request.pendingPushToken,
      clientVersion: request.clientVersion,
      clientSurface: request.clientVersion ? 'android-host' : null,
      instance: {
        id: request.instanceId,
        hostInstanceId: request.hostInstanceId,
        sizeBucket: request.sizeBucket,
      },
      persistRuntimeBinding: false,
    });

    if (!registerResult.ok) {
      return registerResult;
    }

    const callbackUrls = this.buildAndroidBootstrapCallbackUrls(request, registerResult.value);
    if (!callbackUrls) {
      return failure(ErrorCodes.OPERATION_FAILED, 'Android Widget bootstrap 回调地址无效');
    }

    return success({
      ...registerResult.value,
      ...callbackUrls,
    });
  }

  private extractRevokedCount(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 0;
    }

    const revokedCount = (value as { revokedCount?: unknown }).revokedCount;
    return typeof revokedCount === 'number' && Number.isFinite(revokedCount)
      ? Math.max(0, Math.trunc(revokedCount))
      : 0;
  }

  private buildAndroidBootstrapCallbackUrls(
    request: AndroidWidgetBootstrapRequest,
    registerResult: WidgetRegisterResult,
  ): { callbackUrl: string; callbackIntentUrl: string } | null {
    try {
      const callbackBaseUrl = new URL(request.callbackUri);
      const callbackParams = new URLSearchParams({
        widgetToken: registerResult.widgetToken,
        widgetInstallationId: request.installationId,
        widgetDeviceId: registerResult.deviceId,
        widgetSupabaseUrl: environment.supabaseUrl,
        bindingGeneration: String(registerResult.bindingGeneration),
        expiresAt: registerResult.expiresAt,
        widgetInstanceId: registerResult.instanceId ?? request.instanceId,
        widgetHostInstanceId: request.hostInstanceId,
        widgetBootstrapNonce: request.bootstrapNonce,
      });
      const callbackUrl = new URL(callbackBaseUrl.toString());
      callbackUrl.hash = callbackParams.toString();
      return {
        callbackUrl: callbackUrl.toString(),
        callbackIntentUrl: this.buildAndroidBootstrapIntentUrl(callbackBaseUrl, callbackParams),
      };
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- 回调 URL 构造失败时无法继续回跳，返回 null 交由上层失败处理
    }
  }

  private buildAndroidBootstrapIntentUrl(
    callbackBaseUrl: URL,
    callbackParams: URLSearchParams,
  ): string {
    const callbackScheme = callbackBaseUrl.protocol.replace(/:$/, '');
    const callbackPath = callbackBaseUrl.pathname && callbackBaseUrl.pathname !== '/'
      ? callbackBaseUrl.pathname
      : '';
    const queryString = callbackParams.toString();
    return `intent://${callbackBaseUrl.host}${callbackPath}${queryString ? `?${queryString}` : ''}#Intent;scheme=${callbackScheme};end`;
  }

  private async uninstallWidgetInstance(params: {
    deviceId: string | null;
    installationId: string | null;
    platform: string;
    instance: WidgetRuntimeInstanceBinding;
  }): Promise<Result<boolean, OperationError>> {
    if (!params.deviceId || !params.installationId) {
      return success(false);
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪');
      }

      const { data, error } = await withTimeout(
        client.functions.invoke('widget-register', {
          body: {
            action: 'uninstall-instance',
            deviceId: params.deviceId,
            installationId: params.installationId,
            platform: params.platform,
            instance: {
              id: params.instance.instanceId,
              hostInstanceId: params.instance.hostInstanceId,
              sizeBucket: params.instance.sizeBucket,
            },
          },
        }),
        {
          timeout: TIMEOUT_CONFIG.STANDARD,
          timeoutMessage: 'Widget instance uninstall 超时',
        },
      );

      if (error) {
        const message = humanizeErrorMessage(error.message ?? 'Widget instance uninstall 调用失败');
        return failure(ErrorCodes.OPERATION_FAILED, message);
      }

      const record = data as { uninstalled?: unknown } | null;
      return success(record?.uninstalled === true);
    } catch (error) {
      const message = humanizeErrorMessage(extractErrorMessage(error));
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  // === IndexedDB 辅助：与 widget-runtime.js 共享同一 DB ===

  private openWidgetDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(WIDGET_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WIDGET_DB_STORE)) {
          db.createObjectStore(WIDGET_DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async readFromDb(key: string): Promise<unknown> {
    const db = await this.openWidgetDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WIDGET_DB_STORE, 'readonly');
      const store = tx.objectStore(WIDGET_DB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async writeToDb(key: string, value: unknown): Promise<void> {
    const db = await this.openWidgetDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WIDGET_DB_STORE, 'readwrite');
      const store = tx.objectStore(WIDGET_DB_STORE);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async deleteFromDb(key: string): Promise<void> {
    const db = await this.openWidgetDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WIDGET_DB_STORE, 'readwrite');
      const store = tx.objectStore(WIDGET_DB_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private writeWidgetTokenToDb(token: string): Promise<void> {
    return this.writeToDb(WIDGET_TOKEN_KEY, token);
  }

  private writeWidgetConfigToDb(config: WidgetRuntimeConfig): Promise<void> {
    return this.writeToDb(WIDGET_CONFIG_KEY, config);
  }

  private async readWidgetConfigFromDb(): Promise<WidgetRuntimeConfig | null> {
    const config = await this.readFromDb(WIDGET_CONFIG_KEY).catch(() => null);
    return this.normalizeWidgetRuntimeConfig(config);
  }

  private async readPendingWidgetInstanceStateFromDb(): Promise<WidgetRuntimeInstanceState> {
    const raw = await this.readFromDb(WIDGET_INSTANCE_STATE_KEY).catch(() => null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { instances: {} };
    }

    const record = raw as Record<string, unknown>;
    return {
      instances: this.normalizePendingWidgetInstances(record.instances),
    };
  }

  private normalizeOptionalText(value: string | null | undefined, maxLength = 256): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
  }

  private normalizeUuidLike(value: string | null | undefined): string | null {
    const trimmed = this.normalizeOptionalText(value, 64);
    return trimmed && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
      ? trimmed
      : null;
  }

  private normalizeDeviceSecret(value: string | null | undefined): string | null {
    const trimmed = this.normalizeOptionalText(value, 256);
    return trimmed && trimmed.length >= 16 ? trimmed : null;
  }

  private createWidgetDeviceSecret(): string {
    return `${crypto.randomUUID()}${crypto.randomUUID()}`;
  }

  private normalizeWidgetRuntimeConfig(value: unknown): WidgetRuntimeConfig | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const supabaseUrl = this.normalizeOptionalText(typeof record.supabaseUrl === 'string' ? record.supabaseUrl : null, 2048)
      ?? environment.supabaseUrl;
    if (!supabaseUrl) {
      return null;
    }

    return {
      supabaseUrl,
      clientVersion: this.normalizeOptionalText(typeof record.clientVersion === 'string' ? record.clientVersion : null),
      clientSurface: this.normalizeOptionalText(typeof record.clientSurface === 'string' ? record.clientSurface : null, 128),
      deviceId: this.normalizeUuidLike(typeof record.deviceId === 'string' ? record.deviceId : null),
      installationId: this.normalizeUuidLike(typeof record.installationId === 'string' ? record.installationId : null),
      deviceSecret: this.normalizeDeviceSecret(typeof record.deviceSecret === 'string' ? record.deviceSecret : null),
      instanceBindings: this.normalizeWidgetInstanceBindings(record.instanceBindings),
    };
  }

  private normalizeWidgetInstanceBindings(value: unknown): Record<string, WidgetRuntimeInstanceBinding> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const bindings: Record<string, WidgetRuntimeInstanceBinding> = {};
    for (const [key, rawBinding] of Object.entries(value as Record<string, unknown>)) {
      if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) {
        continue;
      }

      const record = rawBinding as Record<string, unknown>;
      const hostInstanceId = this.normalizeOptionalText(
        typeof record.hostInstanceId === 'string' ? record.hostInstanceId : key,
        128,
      );
      const instanceId = this.normalizeUuidLike(typeof record.instanceId === 'string' ? record.instanceId : null);
      const sizeBucket = this.normalizeOptionalText(typeof record.sizeBucket === 'string' ? record.sizeBucket : null, 32);
      const observedAt = this.normalizeOptionalText(typeof record.observedAt === 'string' ? record.observedAt : null, 64)
        ?? new Date(0).toISOString();
      if (!hostInstanceId || !instanceId || !sizeBucket) {
        continue;
      }

      bindings[hostInstanceId] = {
        instanceId,
        hostInstanceId,
        sizeBucket,
        observedAt,
      };
    }

    return bindings;
  }

  private normalizePendingWidgetInstances(value: unknown): Record<string, WidgetRuntimePendingInstance> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const instances: Record<string, WidgetRuntimePendingInstance> = {};
    for (const [key, rawInstance] of Object.entries(value as Record<string, unknown>)) {
      if (!rawInstance || typeof rawInstance !== 'object' || Array.isArray(rawInstance)) {
        continue;
      }

      const record = rawInstance as Record<string, unknown>;
      const hostInstanceId = this.normalizeOptionalText(
        typeof record.hostInstanceId === 'string' ? record.hostInstanceId : key,
        128,
      );
      const sizeBucket = this.normalizeOptionalText(typeof record.sizeBucket === 'string' ? record.sizeBucket : null, 32);
      const observedAt = this.normalizeOptionalText(
        typeof record.lastSeenAt === 'string'
          ? record.lastSeenAt
          : typeof record.observedAt === 'string'
            ? record.observedAt
            : typeof record.installedAt === 'string'
              ? record.installedAt
              : null,
        64,
      ) ?? new Date(0).toISOString();
      if (!hostInstanceId || !sizeBucket) {
        continue;
      }

      instances[hostInstanceId] = {
        hostInstanceId,
        sizeBucket,
        observedAt,
      };
    }

    return instances;
  }

  private pickActiveInstanceBindings(
    bindings: Record<string, WidgetRuntimeInstanceBinding>,
    pendingInstances: WidgetRuntimePendingInstance[],
  ): Record<string, WidgetRuntimeInstanceBinding> {
    const activeHostInstanceIds = new Set(pendingInstances.map(instance => instance.hostInstanceId));
    return Object.fromEntries(
      Object.entries(bindings).filter(([hostInstanceId]) => activeHostInstanceIds.has(hostInstanceId)),
    );
  }

  private resolveWidgetClientVersion(): string {
    try {
      const entryUrl = new URL(import.meta.url, window.location.href);
      return `${VERSION.full}:${entryUrl.pathname}${entryUrl.search}`;
    } catch {
      return `${VERSION.full}:runtime-unknown`;
    }
  }

  private async clearWidgetTokenFromDb(): Promise<void> {
    await this.deleteFromDb(WIDGET_TOKEN_KEY).catch(() => {});
    await this.deleteFromDb(WIDGET_CONFIG_KEY).catch(() => {});
  }

  /** 通知 SW 刷新所有 Widget 实例 */
  private notifySwRefresh(): void {
    if (!navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage({ type: 'WIDGET_REFRESH' });
  }
}

