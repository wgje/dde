import type { SiyuanBlockPreview, SiyuanPreviewErrorCode } from '../external-source.model';

export interface SiyuanPreviewProvider {
  readonly mode: 'extension-relay' | 'direct' | 'cache-only';
  isAvailable(): Promise<boolean>;
  getBlockPreview(blockId: string, signal?: AbortSignal): Promise<SiyuanBlockPreview>;
}

export class SiyuanProviderError extends Error {
  constructor(readonly code: SiyuanPreviewErrorCode, message?: string) {
    super(message ?? code);
  }
}
