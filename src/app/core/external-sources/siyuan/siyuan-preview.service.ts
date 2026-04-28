import { Injectable, inject } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { LoggerService } from '../../../../services/logger.service';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import type { ExternalSourceLink, LocalSiyuanPreviewCache, SiyuanPreviewResult } from '../external-source.model';
import { SiyuanDirectProvider } from './siyuan-direct-provider';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import { SiyuanProviderError, type SiyuanPreviewProvider } from './siyuan-provider.interface';

interface ActivePreviewRequest {
  linkId: string;
  blockId: string;
  controller: AbortController;
  requestSeq: number;
}

@Injectable({ providedIn: 'root' })
export class SiyuanPreviewService {
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly extensionProvider = inject(SiyuanExtensionProvider);
  private readonly directProvider = inject(SiyuanDirectProvider);
  private readonly logger = inject(LoggerService).category('SiyuanPreview');
  private activeRequest?: ActivePreviewRequest;
  private requestSeq = 0;

  async preview(link: ExternalSourceLink, options?: { forceRefresh?: boolean }): Promise<SiyuanPreviewResult> {
    const cached = await this.cache.getPreview(link.id, link.targetId);
    if (cached && !options?.forceRefresh) {
      const stale = Date.now() - new Date(cached.fetchedAt).getTime() > SIYUAN_CONFIG.CACHE_STALE_MS;
      void this.refresh(link).catch(error => {
        this.logger.debug('后台刷新思源预览失败，继续使用本机缓存', {
          linkId: link.id,
          blockId: link.targetId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
      return { status: 'ready', preview: cached, stale };
    }
    return this.refresh(link, cached ?? undefined);
  }

  abortActive(): void {
    this.activeRequest?.controller.abort();
    this.activeRequest = undefined;
  }

  async refresh(link: ExternalSourceLink, fallback?: LocalSiyuanPreviewCache): Promise<SiyuanPreviewResult> {
    const requestSeq = ++this.requestSeq;
    this.activeRequest?.controller.abort();
    const controller = new AbortController();
    this.activeRequest = { linkId: link.id, blockId: link.targetId, controller, requestSeq };

    try {
      const provider = await this.selectProvider();
      if (!provider) {
        return fallback
          ? { status: 'cache-only', preview: fallback, errorCode: 'extension-unavailable', stale: true }
          : { status: 'error', errorCode: 'extension-unavailable' };
      }
      const preview = await provider.getBlockPreview(link.targetId, controller.signal);
      if (!this.isCurrent(link, controller, requestSeq, preview.blockId)) {
        return fallback ? { status: 'cache-only', preview: fallback, stale: true } : { status: 'loading' };
      }
      const cache: LocalSiyuanPreviewCache = {
        ...preview,
        linkId: link.id,
        fetchedAt: new Date().toISOString(),
        fetchStatus: 'ready',
      };
      await this.cache.savePreview(cache);
      return { status: 'ready', preview: cache };
    } catch (error) {
      const errorCode = error instanceof SiyuanProviderError ? error.code : 'unknown';
      return fallback
        ? { status: 'cache-only', preview: fallback, errorCode, stale: true }
        : { status: 'error', errorCode };
    }
  }

  private async selectProvider(): Promise<SiyuanPreviewProvider | null> {
    const config = await this.cache.loadConfig();
    if (config.runtimeMode === 'cache-only') return null;
    if (config.runtimeMode === 'direct') return await this.directProvider.isAvailable() ? this.directProvider : null;
    if (await this.extensionProvider.isAvailable()) return this.extensionProvider;
    return await this.directProvider.isAvailable() ? this.directProvider : null;
  }

  private isCurrent(link: ExternalSourceLink, controller: AbortController, requestSeq: number, blockId: string): boolean {
    return this.activeRequest?.linkId === link.id
      && this.activeRequest.blockId === link.targetId
      && this.activeRequest.controller === controller
      && this.activeRequest.requestSeq === requestSeq
      && blockId === link.targetId;
  }
}
