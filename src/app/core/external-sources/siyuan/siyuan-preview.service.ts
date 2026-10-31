import { Injectable, inject } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import type { ExternalSourceLink, LocalSiyuanPreviewCache, SiyuanBlockPreview, SiyuanPreviewErrorCode, SiyuanPreviewResult } from '../external-source.model';
import { SiyuanDirectProvider } from './siyuan-direct-provider';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import {
  SiyuanProviderError,
  type SiyuanExtensionConfigProbeResult,
  type SiyuanExtensionConfigStatus,
  type SiyuanPreviewProvider,
  type SiyuanPushConfigInput,
  type SiyuanPushConfigResult,
} from './siyuan-provider.interface';

interface ActivePreviewRequest {
  ownerUserId: string;
  linkId: string;
  blockId: string;
  controller: AbortController;
  requestSeq: number;
  cacheGeneration: number;
}

@Injectable({ providedIn: 'root' })
export class SiyuanPreviewService {
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly extensionProvider = inject(SiyuanExtensionProvider);
  private readonly directProvider = inject(SiyuanDirectProvider);
  private readonly logger = inject(LoggerService).category('SiyuanPreview');
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);
  private activeRequest?: ActivePreviewRequest;
  private requestSeq = 0;
  private lastExtensionConfigIssuedAt = 0;
  private readonly inFlight = new Map<string, Promise<SiyuanPreviewResult>>();

  constructor() {
    this.sessionRuntimeReset.register('SiyuanPreviewService', () => this.resetSessionRuntime());
  }

  async diagnoseConnection(): Promise<{ ok: boolean; mode: 'extension-relay' | 'direct' | 'cache-only'; errorCode?: SiyuanPreviewErrorCode }> {
    const ownerUserId = this.cache.ownerId();
    const config = await this.cache.loadConfig(ownerUserId);
    if (!this.isOwnerCurrent(ownerUserId)) {
      return { ok: false, mode: config.runtimeMode, errorCode: 'not-configured' };
    }
    if (config.runtimeMode === 'cache-only') return { ok: true, mode: 'cache-only' };
    if (config.runtimeMode === 'direct') {
      if (!config.token) return { ok: false, mode: 'direct', errorCode: 'not-configured' };
      return await this.directProvider.isAvailable()
        ? { ok: true, mode: 'direct' }
        : { ok: false, mode: 'direct', errorCode: 'runtime-not-supported' };
    }
    const diagnosis = await this.extensionProvider.diagnoseConnection(ownerUserId);
    if (!this.isOwnerCurrent(ownerUserId)) {
      return { ok: false, mode: 'extension-relay', errorCode: 'not-configured' };
    }
    if (diagnosis.ok) return { ok: true, mode: 'extension-relay' };
    return { ok: false, mode: 'extension-relay', errorCode: diagnosis.errorCode ?? 'unknown' };
  }

  /**
   * relay 模式专用：把 baseUrl/token 单向写入扩展。
   * 其它模式直接返回 runtime-not-supported，避免把 token 误推到错误的通道。
   */
  async pushExtensionConfig(input: SiyuanPushConfigInput): Promise<SiyuanPushConfigResult> {
    const configIssuedAt = this.nextExtensionConfigIssuedAt();
    const ownerUserId = this.cache.ownerId();
    const config = await this.cache.loadConfig(ownerUserId);
    if (!this.isOwnerCurrent(ownerUserId)) {
      return { ok: false, errorCode: 'not-configured' };
    }
    if (config.runtimeMode !== 'extension-relay') {
      return { ok: false, errorCode: 'runtime-not-supported' };
    }
    const result = await this.extensionProvider.pushConfig(input, ownerUserId, configIssuedAt);
    return this.isOwnerCurrent(ownerUserId)
      ? result
      : { ok: false, errorCode: 'not-configured' };
  }

  /**
   * relay 模式专用：读取扩展中已保存的配置状态。
   * 返回 null 表示扩展不支持该消息（旧扩展）或不可用，UI 应据此提示用户更新扩展。
   * 其它模式始终返回 null。
   */
  async getExtensionConfigStatus(): Promise<SiyuanExtensionConfigStatus | null> {
    const ownerUserId = this.cache.ownerId();
    const config = await this.cache.loadConfig(ownerUserId);
    if (!this.isOwnerCurrent(ownerUserId)) return null;
    if (config.runtimeMode !== 'extension-relay') return null;
    const status = await this.extensionProvider.getConfigStatus(ownerUserId);
    return this.isOwnerCurrent(ownerUserId) ? status : null;
  }

  async probeExtensionConfigStatus(): Promise<SiyuanExtensionConfigProbeResult> {
    const ownerUserId = this.cache.ownerId();
    const config = await this.cache.loadConfig(ownerUserId);
    if (!this.isOwnerCurrent(ownerUserId)) return { kind: 'unavailable' };
    if (config.runtimeMode !== 'extension-relay') return { kind: 'unavailable' };
    const result = await this.extensionProvider.probeConfigStatus(ownerUserId);
    return this.isOwnerCurrent(ownerUserId) ? result : { kind: 'unavailable' };
  }

  async preview(link: ExternalSourceLink, options?: { forceRefresh?: boolean }): Promise<SiyuanPreviewResult> {
    const ownerUserId = this.cache.ownerId();
    const requestSeq = this.requestSeq;
    const cacheGeneration = this.cache.previewGeneration(link.id, ownerUserId);
    const cached = await this.cache.getPreview(link.id, link.targetId, ownerUserId);
    if (!this.isOwnerCurrent(ownerUserId)
      || this.requestSeq !== requestSeq
      || this.cache.previewGeneration(link.id, ownerUserId) !== cacheGeneration) {
      return { status: 'loading' };
    }
    if (cached && !options?.forceRefresh) {
      const stale = Date.now() - new Date(cached.fetchedAt).getTime() > SIYUAN_CONFIG.CACHE_STALE_MS;
      // 只在缓存过期时触发后台刷新，遵守 CACHE_STALE_MS 预算并避免每次悬停都打 API。
      if (stale) {
        void this.refreshDeduped(link, undefined, false, ownerUserId, cacheGeneration).catch(error => {
          this.logger.debug('后台刷新思源预览失败，继续使用本机缓存', {
            linkId: link.id,
            blockId: link.targetId,
            message: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
      return { status: 'ready', preview: cached, stale, origin: 'cache' };
    }
    return this.refreshDeduped(
      link,
      cached ?? undefined,
      options?.forceRefresh === true,
      ownerUserId,
      cacheGeneration,
    );
  }

  abortActive(): void {
    this.requestSeq += 1;
    this.activeRequest?.controller.abort();
    this.activeRequest = undefined;
  }

  private refreshDeduped(
    link: ExternalSourceLink,
    fallback: LocalSiyuanPreviewCache | undefined,
    forceRefresh: boolean,
    ownerUserId: string,
    cacheGeneration: number,
  ): Promise<SiyuanPreviewResult> {
    const key = this.previewRequestKey(link, forceRefresh, ownerUserId, cacheGeneration);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = this.refresh(link, fallback, ownerUserId, cacheGeneration).finally(() => {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, request);
    return request;
  }

  async refresh(
    link: ExternalSourceLink,
    fallback?: LocalSiyuanPreviewCache,
    ownerUserId = this.cache.ownerId(),
    cacheGeneration = this.cache.previewGeneration(link.id, ownerUserId),
  ): Promise<SiyuanPreviewResult> {
    if (!this.isOwnerCurrent(ownerUserId)
      || this.cache.previewGeneration(link.id, ownerUserId) !== cacheGeneration) {
      return { status: 'loading' };
    }
    const { controller, requestSeq } = this.beginPreviewRequest(link, ownerUserId, cacheGeneration);

    try {
      const provider = await this.selectProvider(ownerUserId);
      if (!this.isOwnerCurrent(ownerUserId)) {
        return { status: 'loading' };
      }
      if (!provider) {
        return fallback
          ? { status: 'cache-only', preview: fallback, errorCode: 'extension-unavailable', stale: true, origin: 'cache' }
          : { status: 'error', errorCode: 'extension-unavailable' };
      }
      const preview = await this.getProviderPreview(provider, link.targetId, controller.signal, ownerUserId);
      if (!this.isCurrent(link, controller, requestSeq, preview.blockId, ownerUserId)) {
        return this.isOwnerCurrent(ownerUserId) && fallback
          ? { status: 'cache-only', preview: fallback, stale: true, origin: 'cache' }
          : { status: 'loading' };
      }
      const cache: LocalSiyuanPreviewCache = {
        ...preview,
        linkId: link.id,
        fetchedAt: new Date().toISOString(),
        fetchStatus: 'ready',
      };
      const saved = await this.cache.savePreview(cache, ownerUserId, cacheGeneration);
      if (!saved || !this.isCurrent(link, controller, requestSeq, preview.blockId, ownerUserId)) {
        return { status: 'loading' };
      }
      return { status: 'ready', preview: cache, origin: 'network' };
    } catch (error) {
      if (!this.isRequestCurrent(link, controller, requestSeq, ownerUserId)) {
        return { status: 'loading' };
      }
      const errorCode = error instanceof SiyuanProviderError ? error.code : 'unknown';
      return fallback
        ? { status: 'cache-only', preview: fallback, errorCode, stale: true, origin: 'cache' }
        : { status: 'error', errorCode };
    }
  }

  private beginPreviewRequest(
    link: ExternalSourceLink,
    ownerUserId: string,
    cacheGeneration: number,
  ): Pick<ActivePreviewRequest, 'controller' | 'requestSeq'> {
    const requestSeq = this.requestSeq;
    this.activeRequest?.controller.abort();
    const controller = new AbortController();
    this.activeRequest = {
      ownerUserId,
      linkId: link.id,
      blockId: link.targetId,
      controller,
      requestSeq,
      cacheGeneration,
    };
    return { controller, requestSeq };
  }

  private async selectProvider(ownerUserId: string): Promise<SiyuanPreviewProvider | null> {
    const config = await this.cache.loadConfig(ownerUserId);
    if (config.runtimeMode === 'cache-only') return null;
    if (config.runtimeMode === 'direct') return await this.directProvider.isAvailable() ? this.directProvider : null;
    // 显式选择 extension-relay 的用户可能正是为了避免 token 落到 direct 模式的 fetch 流量里，
    // 因此扩展不可用时不再静默 fallback；直接告知扩展不可用，让用户在设置里改 runtimeMode。
    return await this.extensionProvider.isAvailable() ? this.extensionProvider : null;
  }

  private getProviderPreview(
    provider: SiyuanPreviewProvider,
    blockId: string,
    signal: AbortSignal,
    ownerUserId: string,
  ): Promise<SiyuanBlockPreview> {
    return provider === this.extensionProvider
      ? this.extensionProvider.getBlockPreview(blockId, signal, ownerUserId)
      : provider.getBlockPreview(blockId, signal);
  }

  private nextExtensionConfigIssuedAt(): number {
    this.lastExtensionConfigIssuedAt = Math.max(Date.now(), this.lastExtensionConfigIssuedAt + 1);
    return this.lastExtensionConfigIssuedAt;
  }

  private previewRequestKey(
    link: ExternalSourceLink,
    forceRefresh: boolean,
    ownerUserId: string,
    cacheGeneration: number,
  ): string {
    return `${ownerUserId}:${link.id}:${link.targetId}:${cacheGeneration}:${forceRefresh ? 'force' : 'normal'}`;
  }

  private isCurrent(
    link: ExternalSourceLink,
    controller: AbortController,
    requestSeq: number,
    blockId: string,
    ownerUserId: string,
  ): boolean {
    return this.isRequestCurrent(link, controller, requestSeq, ownerUserId)
      && blockId === link.targetId;
  }

  private isRequestCurrent(
    link: ExternalSourceLink,
    controller: AbortController,
    requestSeq: number,
    ownerUserId: string,
  ): boolean {
    return this.isOwnerCurrent(ownerUserId)
      && this.activeRequest?.ownerUserId === ownerUserId
      && this.activeRequest.linkId === link.id
      && this.activeRequest.blockId === link.targetId
      && this.activeRequest.controller === controller
      && this.activeRequest.requestSeq === requestSeq
      && this.cache.previewGeneration(link.id, ownerUserId) === this.activeRequest.cacheGeneration;
  }

  private isOwnerCurrent(ownerUserId: string): boolean {
    return this.cache.ownerId() === ownerUserId;
  }

  private resetSessionRuntime(): void {
    this.abortActive();
    this.inFlight.clear();
  }
}
