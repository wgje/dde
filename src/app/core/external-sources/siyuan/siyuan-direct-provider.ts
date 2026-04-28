import { Injectable, inject } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import { isValidSiyuanBlockId } from './siyuan-link-parser';
import { mapSiyuanError, normalizePreview } from './siyuan-preview-utils';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview } from '../external-source.model';
import { SiyuanProviderError, type SiyuanPreviewProvider } from './siyuan-provider.interface';

interface SiyuanApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface KramdownData { kramdown?: string; }
interface HPathData { hPath?: string; }
interface AttrData { updated?: string; updatedAt?: string; }
interface ChildBlockData { id?: string; content?: string; markdown?: string; type?: string; }

export function isTrustedSiyuanDirectBaseUrl(baseUrl: string, pageLocation: Location | null = typeof location === 'undefined' ? null : location): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const originAllowed = (SIYUAN_CONFIG.ALLOWED_DIRECT_BASE_URLS as readonly string[]).includes(url.origin);
    if (!originAllowed) return false;
    if (!pageLocation) return true;
    const isLocalPage = pageLocation.hostname === 'localhost' || pageLocation.hostname === '127.0.0.1';
    return isLocalPage || pageLocation.protocol === 'file:';
  } catch {
    return false;
  }
}

@Injectable({ providedIn: 'root' })
export class SiyuanDirectProvider implements SiyuanPreviewProvider {
  readonly mode = 'direct' as const;
  private readonly cache = inject(ExternalSourceCacheService);

  async isAvailable(): Promise<boolean> {
    const config = await this.cache.loadConfig();
    return config.runtimeMode === 'direct' && isTrustedSiyuanDirectBaseUrl(config.baseUrl) && Boolean(config.token);
  }

  async getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview> {
    if (!isValidSiyuanBlockId(blockId)) throw new SiyuanProviderError('block-not-found');
    const config = await this.cache.loadConfig();
    if (config.runtimeMode !== 'direct' || !isTrustedSiyuanDirectBaseUrl(config.baseUrl)) {
      throw new SiyuanProviderError('runtime-not-supported');
    }
    if (!config.token) throw new SiyuanProviderError('not-configured');

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SIYUAN_CONFIG.PREVIEW_FETCH_TIMEOUT_MS);
    const abortListener = () => controller.abort();
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      const [kramdown, hpath, attrs, children] = await Promise.all([
        this.call<KramdownData>(config.baseUrl, config.token, '/api/block/getBlockKramdown', { id: blockId }, controller.signal),
        this.call<HPathData>(config.baseUrl, config.token, '/api/filetree/getHPathByID', { id: blockId }, controller.signal).catch(() => undefined),
        this.call<AttrData>(config.baseUrl, config.token, '/api/attr/getBlockAttrs', { id: blockId }, controller.signal).catch(() => undefined),
        this.call<ChildBlockData[]>(config.baseUrl, config.token, '/api/block/getChildBlocks', { id: blockId }, controller.signal).catch(() => []),
      ]);
      if (!kramdown) throw new SiyuanProviderError('block-not-found');
      return normalizePreview({
        blockId,
        hpath: hpath?.hPath,
        kramdown: kramdown.kramdown ?? '',
        sourceUpdatedAt: attrs?.updatedAt ?? attrs?.updated,
        childBlocks: this.mapChildren(children ?? []),
      });
    } catch (error) {
      if (error instanceof SiyuanProviderError) throw error;
      throw new SiyuanProviderError(mapSiyuanError(error));
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abortListener);
    }
  }

  private async call<T>(baseUrl: string, token: string, path: string, body: Record<string, string>, signal: AbortSignal): Promise<T | undefined> {
    const response = await fetch(new URL(path, baseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401 || response.status === 403) throw new SiyuanProviderError('token-invalid');
    if (!response.ok) throw new Error(`SiYuan API ${response.status}`);
    const json = await response.json() as SiyuanApiResponse<T>;
    if (json.code && json.code !== 0) throw new Error(json.msg ?? `SiYuan code ${json.code}`);
    return json.data;
  }

  private mapChildren(children: ChildBlockData[]): SiyuanChildBlockPreview[] {
    return children
      .filter(child => typeof child.id === 'string')
      .map(child => ({ id: child.id!, type: child.type ?? 'unknown', content: child.content ?? child.markdown ?? '' }));
  }
}
