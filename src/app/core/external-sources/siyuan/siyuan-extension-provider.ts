import { Injectable } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { createSyncOperationId } from '../../../../utils/sync-operation-id';
import { isValidSiyuanBlockId } from './siyuan-link-parser';
import { normalizePreview } from './siyuan-preview-utils';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview, SiyuanPreviewErrorCode } from '../external-source.model';
import {
  SiyuanProviderError,
  type SiyuanExtensionConfigProbeResult,
  type SiyuanExtensionConfigStatus,
  type SiyuanPreviewProvider,
  type SiyuanPushConfigInput,
  type SiyuanPushConfigResult,
} from './siyuan-provider.interface';

interface ExtensionResponsePayload {
  blockId?: unknown;
  title?: unknown;
  hpath?: unknown;
  plainText?: unknown;
  kramdown?: unknown;
  sourceUpdatedAt?: unknown;
  childBlocks?: unknown;
  truncated?: unknown;
  // set-config / get-config-status 共享 data 字段语义
  baseUrl?: unknown;
  hasToken?: unknown;
}

interface ExtensionMessage {
  type?: unknown;
  requestId?: unknown;
  ownerUserId?: unknown;
  ok?: unknown;
  data?: ExtensionResponsePayload;
  errorCode?: unknown;
}

type RelayRequestType =
  | 'nanoflow.siyuan.v3.get-preview'
  | 'nanoflow.siyuan.v3.test-connection'
  | 'nanoflow.siyuan.v3.set-config'
  | 'nanoflow.siyuan.v3.get-config-status';

type RelayResponseType =
  | 'nanoflow.siyuan.v3.preview-result'
  | 'nanoflow.siyuan.v3.test-connection-result'
  | 'nanoflow.siyuan.v3.set-config-result'
  | 'nanoflow.siyuan.v3.config-status-result';

const ALLOWED_ERROR_CODES: readonly SiyuanPreviewErrorCode[] = [
  'not-configured',
  'runtime-not-supported',
  'extension-unavailable',
  'kernel-unreachable',
  'token-invalid',
  'block-not-found',
  'render-blocked',
  'unknown',
];

@Injectable({ providedIn: 'root' })
export class SiyuanExtensionProvider implements SiyuanPreviewProvider {
  readonly mode = 'extension-relay' as const;

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    return this.pingExtension();
  }

  async diagnoseConnection(ownerUserId: string): Promise<{ ok: boolean; errorCode?: SiyuanPreviewErrorCode }> {
    if (typeof window === 'undefined') return { ok: false, errorCode: 'runtime-not-supported' };
    if (!this.isValidOwnerUserId(ownerUserId)) return { ok: false, errorCode: 'not-configured' };
    if (!await this.pingExtension()) return { ok: false, errorCode: 'extension-unavailable' };
    try {
      const response = await this.postConnectionTest(ownerUserId);
      if (response.ok === true) return { ok: true };
      return { ok: false, errorCode: this.readErrorCode(response.errorCode) };
    } catch (error) {
      if (error instanceof SiyuanProviderError) return { ok: false, errorCode: error.code };
      return { ok: false, errorCode: 'unknown' };
    }
  }

  async getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview>;
  async getBlockPreview(
    blockId: string,
    signal: AbortSignal | undefined,
    ownerUserId: string,
  ): Promise<SiyuanBlockPreview>;
  async getBlockPreview(
    blockId: string,
    signal?: AbortSignal,
    ownerUserId?: string,
  ): Promise<SiyuanBlockPreview> {
    if (!isValidSiyuanBlockId(blockId)) throw new SiyuanProviderError('block-not-found');
    if (typeof window === 'undefined') throw new SiyuanProviderError('runtime-not-supported');
    if (!this.isValidOwnerUserId(ownerUserId)) throw new SiyuanProviderError('not-configured');

    const response = await this.postRequest(blockId, signal, ownerUserId);
    if (!response.ok) {
      const code = this.readErrorCode(response.errorCode);
      throw new SiyuanProviderError(code);
    }

    const data = response.data;
    if (!data || data.blockId !== blockId) throw new SiyuanProviderError('unknown', 'Extension returned mismatched blockId');
    return normalizePreview({
      blockId,
      title: this.readBoundedString(data.title, SIYUAN_CONFIG.MAX_LABEL_LENGTH),
      hpath: this.readBoundedString(data.hpath, SIYUAN_CONFIG.MAX_HPATH_LENGTH),
      plainText: this.readBoundedString(data.plainText, SIYUAN_CONFIG.MAX_PREVIEW_CHARS * 2),
      kramdown: this.readBoundedString(data.kramdown, SIYUAN_CONFIG.MAX_PREVIEW_CHARS * 2),
      sourceUpdatedAt: this.readBoundedString(data.sourceUpdatedAt, 64),
      childBlocks: this.readChildBlocks(data.childBlocks),
      truncated: data.truncated === true,
    });
  }

  /**
   * 把 NanoFlow 设置页填写的 baseUrl/token 单向写入扩展 chrome.storage.local。
   * - 仅在 extension-relay 模式下被调用；
   * - token 在调用结束后由 UI 立即丢弃，不写入 NanoFlow IndexedDB；
   * - 旧扩展（不识别 set-config）会在 PREVIEW_FETCH_TIMEOUT_MS 后超时，归为 extension-unavailable，
   *   UI 层据此提示用户更新扩展。
   */
  async pushConfig(
    input: SiyuanPushConfigInput,
    ownerUserId: string,
    configIssuedAt: number,
  ): Promise<SiyuanPushConfigResult> {
    if (typeof window === 'undefined') return { ok: false, errorCode: 'runtime-not-supported' };
    if (!this.isValidOwnerUserId(ownerUserId)) return { ok: false, errorCode: 'not-configured' };
    if (!Number.isSafeInteger(configIssuedAt) || configIssuedAt <= 0) {
      return { ok: false, errorCode: 'not-configured' };
    }
    if (!await this.pingExtension()) return { ok: false, errorCode: 'extension-unavailable' };
    // payload 严格只携带 baseUrl/token；token === undefined 表示"保持现状"；token === '' 表示"清除"。
    const payload: Record<string, unknown> = { baseUrl: input.baseUrl };
    if (input.token !== undefined) payload.token = input.token;
    try {
      const response = await this.postRelayRequest({
        requestType: 'nanoflow.siyuan.v3.set-config',
        responseType: 'nanoflow.siyuan.v3.set-config-result',
        ownerUserId,
        configIssuedAt,
        payload,
      });
      if (response.ok === true) return { ok: true };
      return { ok: false, errorCode: this.readErrorCode(response.errorCode) };
    } catch (error) {
      if (error instanceof SiyuanProviderError) return { ok: false, errorCode: error.code };
      return { ok: false, errorCode: 'unknown' };
    }
  }

  /**
   * 读取扩展中已保存的配置状态：仅返回 baseUrl 与 hasToken。
   * - 旧扩展不识别该消息 → 超时 → 返回 null，UI 据此切换到"扩展版本过旧"提示。
   * - hasToken 仅为布尔，绝不回传 token 明文。
   */
  async getConfigStatus(ownerUserId: string): Promise<SiyuanExtensionConfigStatus | null> {
    const result = await this.probeConfigStatus(ownerUserId);
    return result.kind === 'ok' ? result.status : null;
  }

  async probeConfigStatus(ownerUserId: string): Promise<SiyuanExtensionConfigProbeResult> {
    if (typeof window === 'undefined') return { kind: 'unavailable' };
    if (!this.isValidOwnerUserId(ownerUserId)) return { kind: 'error', errorCode: 'not-configured' };
    if (!await this.pingExtension()) return { kind: 'unavailable' };
    try {
      const response = await this.postRelayRequest({
        requestType: 'nanoflow.siyuan.v3.get-config-status',
        responseType: 'nanoflow.siyuan.v3.config-status-result',
        ownerUserId,
      });
      if (response.ok !== true || !response.data) {
        return { kind: 'error', errorCode: this.readErrorCode(response.errorCode) };
      }
      const baseUrl = this.readBoundedString(response.data.baseUrl, SIYUAN_CONFIG.MAX_URI_LENGTH);
      return {
        kind: 'ok',
        status: {
          baseUrl,
          hasToken: response.data.hasToken === true,
        },
      };
    } catch (error) {
      if (error instanceof SiyuanProviderError) {
        if (error.code === 'extension-unavailable') {
          // ping 成功但 config-status 超时，多半是旧扩展尚未实现该页面配置通道。
          return { kind: 'unsupported' };
        }
        return { kind: 'error', errorCode: error.code };
      }
      return { kind: 'error', errorCode: 'unknown' };
    }
  }

  private async pingExtension(): Promise<boolean> {
    try {
      const requestId = createSyncOperationId();
      return await new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', listener);
          resolve(false);
        }, SIYUAN_CONFIG.EXTENSION_PING_TIMEOUT_MS);
        const listener = (event: MessageEvent<unknown>) => {
          if (!this.isTrustedWindowMessage(event)) return;
          const message = event.data as ExtensionMessage;
          if (message.requestId !== requestId) return;
          if (message.type === 'nanoflow.siyuan.pong') {
            window.clearTimeout(timer);
            window.removeEventListener('message', listener);
            resolve(message.ok === true);
            return;
          }
          // 兼容旧 content-script：runtime 异常时可能统一回 preview-result。
          if (message.type === 'nanoflow.siyuan.preview-result' && this.readErrorCode(message.errorCode) === 'extension-unavailable') {
            window.clearTimeout(timer);
            window.removeEventListener('message', listener);
            resolve(false);
          }
        };
        const cleanup = () => {
          window.clearTimeout(timer);
          window.removeEventListener('message', listener);
        };
        window.addEventListener('message', listener);
        try {
          window.postMessage({ type: 'nanoflow.siyuan.ping', requestId }, window.location.origin);
        } catch (error) {
          cleanup();
          throw error;
        }
      });
    } catch {
      return false;
    }
  }

  private postConnectionTest(ownerUserId: string, signal?: AbortSignal): Promise<ExtensionMessage> {
    return this.postRelayRequest({
      requestType: 'nanoflow.siyuan.v3.test-connection',
      responseType: 'nanoflow.siyuan.v3.test-connection-result',
      ownerUserId,
      signal,
    });
  }

  private postRequest(
    blockId: string,
    signal: AbortSignal | undefined,
    ownerUserId: string,
  ): Promise<ExtensionMessage> {
    return this.postRelayRequest({
      requestType: 'nanoflow.siyuan.v3.get-preview',
      responseType: 'nanoflow.siyuan.v3.preview-result',
      ownerUserId,
      payload: { blockId, includeChildren: true, maxChildren: SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN, maxChars: SIYUAN_CONFIG.MAX_PREVIEW_CHARS },
      signal,
    });
  }

  private postRelayRequest(args: {
    requestType: RelayRequestType;
    responseType: RelayResponseType;
    ownerUserId: string;
    configIssuedAt?: number;
    payload?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ExtensionMessage> {
    const { requestType, responseType, ownerUserId, configIssuedAt, payload, signal } = args;
    if (!this.isValidOwnerUserId(ownerUserId)) return Promise.reject(new SiyuanProviderError('not-configured'));
    const requestId = createSyncOperationId();
    return new Promise<ExtensionMessage>((resolve, reject) => {
      // 提前返回：调用方在我们准备 timer/listener 之前就已 abort，避免无谓的事件订阅。
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const cleanup = () => {
        window.clearTimeout(timer);
        window.removeEventListener('message', listener);
        signal?.removeEventListener('abort', abortListener);
      };
      const abortListener = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new SiyuanProviderError('extension-unavailable'));
      }, SIYUAN_CONFIG.PREVIEW_FETCH_TIMEOUT_MS);
      const listener = (event: MessageEvent<unknown>) => {
        if (!this.isTrustedWindowMessage(event)) return;
        const message = event.data as ExtensionMessage;
        if (message.type !== responseType || message.requestId !== requestId) return;
        if (message.ownerUserId !== ownerUserId) return;
        cleanup();
        resolve(message);
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      window.addEventListener('message', listener);
      const request: Record<string, unknown> = { type: requestType, requestId, ownerUserId };
      if (configIssuedAt !== undefined) request.configIssuedAt = configIssuedAt;
      if (payload) request.payload = payload;
      try {
        window.postMessage(request, window.location.origin);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private isTrustedWindowMessage(event: MessageEvent<unknown>): boolean {
    return event.source === window && event.origin === window.location.origin && typeof event.data === 'object' && event.data !== null;
  }

  private isValidOwnerUserId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128;
  }

  private readChildBlocks(value: unknown): SiyuanChildBlockPreview[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value
      .slice(0, SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN)
      .filter(item => typeof item?.id === 'string' && typeof item?.content === 'string' && typeof item?.type === 'string')
      .map(item => ({
        id: this.truncate(item.id, SIYUAN_CONFIG.MAX_LINK_ID_LENGTH),
        content: this.truncate(item.content, SIYUAN_CONFIG.MAX_PREVIEW_CHARS),
        type: this.truncate(item.type, 32),
      }));
  }

  private readErrorCode(value: unknown): SiyuanPreviewErrorCode {
    return ALLOWED_ERROR_CODES.includes(value as SiyuanPreviewErrorCode) ? value as SiyuanPreviewErrorCode : 'unknown';
  }

  private readBoundedString(value: unknown, maxLength: number): string | undefined {
    return typeof value === 'string' ? this.truncate(value, maxLength) : undefined;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
