import { Injectable } from '@angular/core';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { isValidSiyuanBlockId } from './siyuan-link-parser';
import { normalizePreview } from './siyuan-preview-utils';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview } from '../external-source.model';
import { SiyuanProviderError, type SiyuanPreviewProvider } from './siyuan-provider.interface';

interface ExtensionResponsePayload {
  blockId?: unknown;
  hpath?: unknown;
  plainText?: unknown;
  kramdown?: unknown;
  sourceUpdatedAt?: unknown;
  childBlocks?: unknown;
  truncated?: unknown;
}

interface ExtensionMessage {
  type?: unknown;
  requestId?: unknown;
  ok?: unknown;
  data?: ExtensionResponsePayload;
  errorCode?: unknown;
  errorMessage?: unknown;
}

@Injectable({ providedIn: 'root' })
export class SiyuanExtensionProvider implements SiyuanPreviewProvider {
  readonly mode = 'extension-relay' as const;

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    return this.pingExtension();
  }

  async getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview> {
    if (!isValidSiyuanBlockId(blockId)) throw new SiyuanProviderError('block-not-found');
    if (typeof window === 'undefined') throw new SiyuanProviderError('runtime-not-supported');

    const response = await this.postRequest(blockId, signal);
    if (!response.ok) {
      const code = typeof response.errorCode === 'string' ? response.errorCode : 'unknown';
      throw new SiyuanProviderError(code === 'extension-unavailable' ? code : 'unknown', String(response.errorMessage ?? code));
    }

    const data = response.data;
    if (!data || data.blockId !== blockId) throw new SiyuanProviderError('unknown', 'Extension returned mismatched blockId');
    return normalizePreview({
      blockId,
      hpath: typeof data.hpath === 'string' ? data.hpath : undefined,
      plainText: typeof data.plainText === 'string' ? data.plainText : undefined,
      kramdown: typeof data.kramdown === 'string' ? data.kramdown : undefined,
      sourceUpdatedAt: typeof data.sourceUpdatedAt === 'string' ? data.sourceUpdatedAt : undefined,
      childBlocks: this.readChildBlocks(data.childBlocks),
      truncated: data.truncated === true,
    });
  }

  private async pingExtension(): Promise<boolean> {
    try {
      const requestId = crypto.randomUUID();
      window.postMessage({ type: 'nanoflow.siyuan.ping', requestId }, window.location.origin);
      return await new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', listener);
          resolve(false);
        }, 500);
        const listener = (event: MessageEvent<unknown>) => {
          if (event.source !== window) return;
          const message = event.data as ExtensionMessage;
          if (message.type !== 'nanoflow.siyuan.pong' || message.requestId !== requestId) return;
          window.clearTimeout(timer);
          window.removeEventListener('message', listener);
          resolve(true);
        };
        window.addEventListener('message', listener);
      });
    } catch {
      return false;
    }
  }

  private postRequest(blockId: string, signal?: AbortSignal): Promise<ExtensionMessage> {
    const requestId = crypto.randomUUID();
    return new Promise<ExtensionMessage>((resolve, reject) => {
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
        if (event.source !== window) return;
        const message = event.data as ExtensionMessage;
        if (message.type !== 'nanoflow.siyuan.preview-result' || message.requestId !== requestId) return;
        cleanup();
        resolve(message);
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      window.addEventListener('message', listener);
      window.postMessage({
        type: 'nanoflow.siyuan.get-preview',
        requestId,
        payload: { blockId, includeChildren: true, maxChildren: SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN, maxChars: SIYUAN_CONFIG.MAX_PREVIEW_CHARS },
      }, window.location.origin);
    });
  }

  private readChildBlocks(value: unknown): SiyuanChildBlockPreview[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value
      .filter(item => typeof item?.id === 'string' && typeof item?.content === 'string' && typeof item?.type === 'string')
      .map(item => ({ id: item.id, content: item.content, type: item.type }));
  }
}
