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
  key: string;
  ownerUserId: string;
  linkId: string;
  blockId: string;
  controller: AbortController;
  requestSeq: number;
  lifecycleGeneration: number;
  cacheGeneration: number;
  subscribers: Set<PreviewRequestSubscriber>;
  retainWithoutSubscribers: boolean;
  promise: Promise<SiyuanPreviewResult>;
  settled: boolean;
}

interface PreviewRequestSubscriber {
  id: symbol;
  ownerUserId: string;
  lifecycleGeneration: number;
  cancelled: boolean;
  settled: boolean;
  flight?: ActivePreviewRequest;
  cancellationPromise: Promise<SiyuanPreviewResult>;
  resolveCancellation(result: SiyuanPreviewResult): void;
}

export type SiyuanPreviewPromise = Promise<SiyuanPreviewResult> & {
  cancel?: () => void;
};

@Injectable({ providedIn: 'root' })
export class SiyuanPreviewService {
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly extensionProvider = inject(SiyuanExtensionProvider);
  private readonly directProvider = inject(SiyuanDirectProvider);
  private readonly logger = inject(LoggerService).category('SiyuanPreview');
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);
  private requestSeq = 0;
  private lifecycleGeneration = 0;
  private lastExtensionConfigIssuedAt = 0;
  private readonly inFlight = new Map<string, ActivePreviewRequest>();
  private readonly subscribers = new Set<PreviewRequestSubscriber>();

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

  preview(link: ExternalSourceLink, options?: { forceRefresh?: boolean }): SiyuanPreviewPromise {
    const ownerUserId = this.cache.ownerId();
    let resolveCancellation!: (result: SiyuanPreviewResult) => void;
    const cancellationPromise = new Promise<SiyuanPreviewResult>(resolve => {
      resolveCancellation = resolve;
    });
    const subscriber: PreviewRequestSubscriber = {
      id: Symbol('siyuan-preview-subscriber'),
      ownerUserId,
      lifecycleGeneration: this.lifecycleGeneration,
      cancelled: false,
      settled: false,
      cancellationPromise,
      resolveCancellation,
    };
    this.subscribers.add(subscriber);
    const work = this.loadPreview(link, options, subscriber);
    const promise = Promise.race([work, cancellationPromise])
      .finally(() => this.finishSubscriber(subscriber));
    return Object.assign(promise, {
      cancel: () => this.cancelSubscriber(subscriber),
    });
  }

  private async loadPreview(
    link: ExternalSourceLink,
    options: { forceRefresh?: boolean } | undefined,
    subscriber: PreviewRequestSubscriber,
  ): Promise<SiyuanPreviewResult> {
    const { ownerUserId } = subscriber;
    const cacheGeneration = this.cache.previewGeneration(link.id, ownerUserId);
    const cached = await this.cache.getPreview(link.id, link.targetId, ownerUserId);
    if (!this.isSubscriberCurrent(subscriber)
      || this.cache.previewGeneration(link.id, ownerUserId) !== cacheGeneration) {
      return { status: 'loading' };
    }
    if (cached && !options?.forceRefresh) {
      const stale = Date.now() - new Date(cached.fetchedAt).getTime() > SIYUAN_CONFIG.CACHE_STALE_MS;
      // 只在缓存过期时触发后台刷新，遵守 CACHE_STALE_MS 预算并避免每次悬停都打 API。
      if (stale) {
        void this.refreshDeduped(link, undefined, false, ownerUserId, cacheGeneration, undefined, true).catch(error => {
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
      subscriber,
    );
  }

  abortActive(): void {
    this.lifecycleGeneration += 1;
    for (const subscriber of [...this.subscribers]) {
      this.cancelSubscriber(subscriber);
    }
    for (const flight of [...this.inFlight.values()]) {
      this.abortFlight(flight);
    }
  }

  private refreshDeduped(
    link: ExternalSourceLink,
    fallback: LocalSiyuanPreviewCache | undefined,
    forceRefresh: boolean,
    ownerUserId: string,
    cacheGeneration: number,
    subscriber?: PreviewRequestSubscriber,
    retainWithoutSubscribers = false,
  ): Promise<SiyuanPreviewResult> {
    const key = this.previewRequestKey(link, forceRefresh, ownerUserId, cacheGeneration);
    let flight = this.inFlight.get(key);
    if (!flight) {
      flight = {
        key,
        ownerUserId,
        linkId: link.id,
        blockId: link.targetId,
        controller: new AbortController(),
        requestSeq: ++this.requestSeq,
        lifecycleGeneration: this.lifecycleGeneration,
        cacheGeneration,
        subscribers: new Set(),
        retainWithoutSubscribers,
        promise: Promise.resolve({ status: 'loading' }),
        settled: false,
      };
      this.inFlight.set(key, flight);
      const currentFlight = flight;
      flight.promise = this.executeRefresh(link, fallback, currentFlight).finally(() => {
        this.finishFlight(currentFlight);
      });
    } else if (retainWithoutSubscribers) {
      flight.retainWithoutSubscribers = true;
    }

    if (subscriber && this.isSubscriberCurrent(subscriber)) {
      flight.subscribers.add(subscriber);
      subscriber.flight = flight;
    }
    return flight.promise;
  }

  refresh(
    link: ExternalSourceLink,
    fallback?: LocalSiyuanPreviewCache,
    ownerUserId = this.cache.ownerId(),
    cacheGeneration = this.cache.previewGeneration(link.id, ownerUserId),
  ): Promise<SiyuanPreviewResult> {
    return this.refreshDeduped(link, fallback, true, ownerUserId, cacheGeneration, undefined, true);
  }

  private async executeRefresh(
    link: ExternalSourceLink,
    fallback: LocalSiyuanPreviewCache | undefined,
    flight: ActivePreviewRequest,
  ): Promise<SiyuanPreviewResult> {
    if (!this.isRequestCurrent(link, flight)) return { status: 'loading' };
    try {
      const provider = await this.selectProvider(flight.ownerUserId);
      if (!this.isRequestCurrent(link, flight)) return { status: 'loading' };
      if (!provider) {
        return fallback
          ? { status: 'cache-only', preview: fallback, errorCode: 'extension-unavailable', stale: true, origin: 'cache' }
          : { status: 'error', errorCode: 'extension-unavailable' };
      }
      const preview = await this.getProviderPreview(provider, link.targetId, flight.controller.signal, flight.ownerUserId);
      if (!this.isRequestCurrent(link, flight)) return { status: 'loading' };
      if (preview.blockId !== link.targetId) {
        return fallback
          ? { status: 'cache-only', preview: fallback, stale: true, origin: 'cache' }
          : { status: 'loading' };
      }
      const cache: LocalSiyuanPreviewCache = {
        ...preview,
        linkId: link.id,
        fetchedAt: new Date().toISOString(),
        fetchStatus: 'ready',
      };
      const saved = await this.cache.savePreview(cache, flight.ownerUserId, flight.cacheGeneration);
      if (!saved || !this.isRequestCurrent(link, flight)) {
        return { status: 'loading' };
      }
      return { status: 'ready', preview: cache, origin: 'network' };
    } catch (error) {
      if (!this.isRequestCurrent(link, flight)) {
        return { status: 'loading' };
      }
      const errorCode = error instanceof SiyuanProviderError ? error.code : 'unknown';
      return fallback
        ? { status: 'cache-only', preview: fallback, errorCode, stale: true, origin: 'cache' }
        : { status: 'error', errorCode };
    }
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

  private isRequestCurrent(link: ExternalSourceLink, flight: ActivePreviewRequest): boolean {
    return !flight.controller.signal.aborted
      && this.inFlight.get(flight.key) === flight
      && flight.lifecycleGeneration === this.lifecycleGeneration
      && this.isOwnerCurrent(flight.ownerUserId)
      && flight.linkId === link.id
      && flight.blockId === link.targetId
      && this.cache.previewGeneration(link.id, flight.ownerUserId) === flight.cacheGeneration;
  }

  private isSubscriberCurrent(subscriber: PreviewRequestSubscriber): boolean {
    return !subscriber.cancelled
      && !subscriber.settled
      && subscriber.lifecycleGeneration === this.lifecycleGeneration
      && this.isOwnerCurrent(subscriber.ownerUserId);
  }

  private cancelSubscriber(subscriber: PreviewRequestSubscriber): void {
    if (subscriber.cancelled || subscriber.settled) return;
    subscriber.cancelled = true;
    subscriber.settled = true;
    this.subscribers.delete(subscriber);
    subscriber.resolveCancellation({ status: 'loading' });
    this.detachSubscriber(subscriber);
  }

  private finishSubscriber(subscriber: PreviewRequestSubscriber): void {
    if (subscriber.cancelled || subscriber.settled) return;
    subscriber.settled = true;
    this.subscribers.delete(subscriber);
    this.detachSubscriber(subscriber);
  }

  private detachSubscriber(subscriber: PreviewRequestSubscriber): void {
    const flight = subscriber.flight;
    subscriber.flight = undefined;
    if (!flight) return;
    flight.subscribers.delete(subscriber);
    if (!flight.settled && !flight.retainWithoutSubscribers && flight.subscribers.size === 0) {
      this.abortFlight(flight);
    }
  }

  private abortFlight(flight: ActivePreviewRequest): void {
    if (flight.settled) return;
    if (this.inFlight.get(flight.key) === flight) this.inFlight.delete(flight.key);
    flight.controller.abort();
  }

  private finishFlight(flight: ActivePreviewRequest): void {
    flight.settled = true;
    if (this.inFlight.get(flight.key) === flight) this.inFlight.delete(flight.key);
    for (const subscriber of flight.subscribers) {
      if (subscriber.flight === flight) subscriber.flight = undefined;
    }
    flight.subscribers.clear();
  }

  private isOwnerCurrent(ownerUserId: string): boolean {
    return this.cache.ownerId() === ownerUserId;
  }

  private resetSessionRuntime(): void {
    this.abortActive();
  }
}
