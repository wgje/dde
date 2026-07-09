import { Injectable, inject } from '@angular/core';
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
import {
  extractSupabaseFunctionErrorMessage,
  readSupabaseFunctionErrorStatus,
} from '../utils/supabase-functions-error';
import { withTimeout } from '../utils/timeout';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import {
  WidgetBindingOutboxStore,
  type WidgetBindingOutboxOperation,
} from './widget-binding-outbox.store';

const ANDROID_WIDGET_HOST_PACKAGE = 'app.nanoflow.twa';
/**
 * revoke-all 重试封顶：4xx 业务拒绝（401/408/429 除外）或达到上限的操作放弃重试。
 * 服务端 widget token 本身有 expiresAt 兜底，无限重放只会让每次重连 flush 永远失败
 */
const WIDGET_REVOKE_ALL_MAX_ATTEMPTS = 12;

export interface WidgetRevokeAllResult {
  revokedCount: number;
  syncStatus?: 'queued' | 'synced';
  operationId?: string;
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

@Injectable({ providedIn: 'root' })
export class WidgetBindingService {
  private readonly logger = inject(LoggerService).category('WidgetBinding');
  private readonly supabase = inject(SupabaseClientService);
  private readonly outbox = inject(WidgetBindingOutboxStore);

  async revokeAllBindings(): Promise<Result<WidgetRevokeAllResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return success({ revokedCount: 0 });
    }

    try {
      const queuedOperation = await this.outbox.enqueueRevokeAll();
      const flushResult = await this.flushPendingRevokeAllBindings();
      if (flushResult.ok) {
        return success({
          ...flushResult.value,
          operationId: queuedOperation.operationId,
        });
      }

      // 永久失败（4xx 业务拒绝/重试封顶）时操作已被放弃，不能再向调用方谎报 queued
      const stillQueued = (await this.outbox.readPending())
        .some(operation => operation.operationId === queuedOperation.operationId);
      if (!stillQueued) {
        return flushResult;
      }

      this.logger.warn('Widget revoke-all 已入本地队列，等待后台同步', {
        operationId: queuedOperation.operationId,
        message: flushResult.error.message,
      });
      return success({
        revokedCount: 0,
        syncStatus: 'queued',
        operationId: queuedOperation.operationId,
      });
    } catch (error) {
      const message = humanizeErrorMessage(
        await extractSupabaseFunctionErrorMessage(error, extractErrorMessage(error)),
      );
      this.logger.warn('Widget revoke-all 本地队列写入失败', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  async flushPendingRevokeAllBindings(): Promise<Result<WidgetRevokeAllResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return success({ revokedCount: 0, syncStatus: 'synced' });
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪，无法吊销 Widget 绑定');
      }

      const operations = (await this.outbox.readPending())
        .filter(operation => operation.type === 'revoke-all');
      let revokedCount = 0;

      for (const operation of operations) {
        const { data, error } = await this.invokeRevokeAll(client, operation);
        if (error) {
          return this.handleRevokeAllInvokeError(operation, error);
        }

        revokedCount += this.extractRevokedCount(data);
        await this.outbox.delete(operation.operationId);
      }

      if (operations.length > 0) {
        // OBS-11: widget_account_switch_cleanup — 记录 Web 端登出/换号清理结果
        this.logger.info('[WidgetTelemetry] widget_account_switch_cleanup', {
          surface: 'web',
          revokedCount,
          operationCount: operations.length,
        });
      }
      return success({ revokedCount, syncStatus: 'synced' });
    } catch (error) {
      const message = humanizeErrorMessage(
        await extractSupabaseFunctionErrorMessage(error, extractErrorMessage(error)),
      );
      this.logger.warn('Widget revoke-all 异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  /**
   * 注册 Widget 设备绑定并返回宿主后续所需的只读 token / binding 元数据。
   */
  async registerDevice(params: {
    deviceId: string;
    installationId: string;
    deviceSecret: string;
    platform: string;
    pushToken?: string | null;
    clientVersion?: string | null;
    clientSurface?: string | null;
    expectedBindingGeneration?: number | null;
    persistRuntimeBinding?: boolean;
    instance?: { id: string; hostInstanceId: string; sizeBucket: string };
  }): Promise<Result<WidgetRegisterResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(ErrorCodes.OPERATION_FAILED, 'Supabase 未配置');
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 客户端未就绪');
      }

      const { data, error } = await this.invokeRegisterDevice(client, params);

      if (error) {
        const message = humanizeErrorMessage(
          await extractSupabaseFunctionErrorMessage(error, 'Widget register 调用失败'),
        );
        this.logger.warn('Widget register 调用失败', { message });
        return failure(ErrorCodes.OPERATION_FAILED, message);
      }

      const result = this.parseRegisterResponse(data);
      if (!result) {
        return failure(ErrorCodes.OPERATION_FAILED, 'Widget register 响应格式异常');
      }

      return success(result);
    } catch (error) {
      const message = humanizeErrorMessage(
        await extractSupabaseFunctionErrorMessage(error, extractErrorMessage(error)),
      );
      this.logger.warn('Widget register 异常', { message, error });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }
  }

  private async invokeRegisterDevice(
    client: { functions: { invoke: (name: string, options: { body: Record<string, unknown> }) => Promise<{ data: unknown; error: { message?: string } | null }> } },
    params: Parameters<WidgetBindingService['registerDevice']>[0],
  ): Promise<{ data: unknown; error: { message?: string } | null }> {
    return withTimeout(
      client.functions.invoke('widget-register', {
        body: this.buildRegisterPayload(params),
      }),
      {
        timeout: TIMEOUT_CONFIG.STANDARD,
        timeoutMessage: 'Widget register 超时',
      },
    );
  }

  private async invokeRevokeAll(
    client: { functions: { invoke: (name: string, options: { body: Record<string, unknown> }) => Promise<{ data: unknown; error: { message?: string } | null }> } },
    operation: WidgetBindingOutboxOperation,
  ): Promise<{ data: unknown; error: { message?: string } | null }> {
    return withTimeout(
      client.functions.invoke('widget-register', {
        body: {
          action: 'revoke-all',
          operationId: operation.operationId,
        },
      }),
      {
        timeout: TIMEOUT_CONFIG.QUICK,
        timeoutMessage: 'Widget revoke-all 超时',
      },
    );
  }

  private buildRegisterPayload(params: Parameters<WidgetBindingService['registerDevice']>[0]): Record<string, unknown> {
    const capabilities = this.buildRegisterCapabilities(params);
    return {
      action: 'register',
      deviceId: params.deviceId,
      installationId: params.installationId,
      deviceSecret: params.deviceSecret,
      platform: params.platform,
      pushToken: params.pushToken,
      ...(Number.isSafeInteger(params.expectedBindingGeneration) && Number(params.expectedBindingGeneration) > 0
        ? { expectedBindingGeneration: params.expectedBindingGeneration }
        : {}),
      ...(capabilities ? { capabilities } : {}),
      instance: params.instance ?? null,
    };
  }

  private buildRegisterCapabilities(params: Parameters<WidgetBindingService['registerDevice']>[0]): Record<string, unknown> | undefined {
    const clientVersion = this.normalizeOptionalText(params.clientVersion);
    const clientSurface = this.normalizeOptionalText(params.clientSurface, 128)
      ?? (params.platform === 'android-widget'
        ? (clientVersion ? 'android-host' : null)
        : 'web-app');

    return clientVersion || clientSurface
      ? {
          clientContext: {
            clientVersion,
            clientSurface,
          },
        }
      : undefined;
  }

  private parseRegisterResponse(data: unknown): WidgetRegisterResult | null {
    const response = data as Record<string, unknown> | null;
    if (!response || typeof response.widgetToken !== 'string') {
      return null;
    }

    return {
      deviceId: response.deviceId as string,
      bindingGeneration: response.bindingGeneration as number,
      expiresAt: response.expiresAt as string,
      widgetToken: response.widgetToken,
      instanceId: response.instance
        ? (response.instance as { id: string }).id
        : null,
    };
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
      persistRuntimeBinding: false,
      instance: {
        id: request.instanceId,
        hostInstanceId: request.hostInstanceId,
        sizeBucket: request.sizeBucket,
      },
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

  private async handleRevokeAllInvokeError(
    operation: WidgetBindingOutboxOperation,
    error: unknown,
  ): Promise<Result<WidgetRevokeAllResult, OperationError>> {
    const message = humanizeErrorMessage(
      await extractSupabaseFunctionErrorMessage(error, 'Widget revoke-all 调用失败'),
    );

    if (this.isPermanentRevokeAllFailure(operation, error)) {
      await this.outbox.delete(operation.operationId);
      this.logger.warn('Widget revoke-all 永久失败，已放弃重试', {
        operationId: operation.operationId,
        attemptCount: operation.attemptCount + 1,
        message,
      });
      return failure(ErrorCodes.OPERATION_FAILED, message);
    }

    await this.markRevokeAllAttempt(operation);
    this.logger.warn('Widget revoke-all 调用失败', {
      operationId: operation.operationId,
      message,
    });
    return failure(ErrorCodes.OPERATION_FAILED, message);
  }

  private isPermanentRevokeAllFailure(
    operation: WidgetBindingOutboxOperation,
    error: unknown,
  ): boolean {
    if (operation.attemptCount + 1 >= WIDGET_REVOKE_ALL_MAX_ATTEMPTS) {
      return true;
    }

    const status = readSupabaseFunctionErrorStatus(error);
    if (status === null) {
      return false;
    }

    return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
  }

  private async markRevokeAllAttempt(operation: WidgetBindingOutboxOperation): Promise<void> {
    try {
      await this.outbox.markAttempt(operation.operationId);
    } catch (error) {
      this.logger.warn('Widget revoke-all 重试计数写入失败', {
        operationId: operation.operationId,
        error,
      });
    }
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
      callbackUrl.search = callbackParams.toString();
      callbackUrl.hash = '';
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
    return `intent://${callbackBaseUrl.host}${callbackPath}${queryString ? `?${queryString}` : ''}#Intent;scheme=${callbackScheme};package=${ANDROID_WIDGET_HOST_PACKAGE};end`;
  }

  private normalizeOptionalText(value: string | null | undefined, maxLength = 256): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
  }

}
