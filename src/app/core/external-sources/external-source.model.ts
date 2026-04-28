export type ExternalSourceRole = 'context' | 'spec' | 'reference' | 'evidence' | 'next-action';
export type ExternalSourceType = 'siyuan-block';

export interface ExternalSourceLink {
  id: string;
  taskId: string;
  sourceType: ExternalSourceType;
  targetId: string;
  uri: string;
  label?: string;
  hpath?: string;
  role?: ExternalSourceRole;
  sortOrder: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SiyuanPreviewErrorCode =
  | 'not-configured'
  | 'runtime-not-supported'
  | 'extension-unavailable'
  | 'kernel-unreachable'
  | 'token-invalid'
  | 'block-not-found'
  | 'render-blocked'
  | 'unknown';

export interface SiyuanChildBlockPreview {
  id: string;
  content: string;
  type: string;
}

export interface SiyuanBlockPreview {
  blockId: string;
  hpath?: string;
  plainText?: string;
  kramdown?: string;
  excerpt?: string;
  sourceUpdatedAt?: string;
  childBlocks?: SiyuanChildBlockPreview[];
  truncated: boolean;
}

export interface LocalSiyuanPreviewCache extends SiyuanBlockPreview {
  linkId: string;
  fetchedAt: string;
  fetchStatus: 'idle' | 'loading' | 'ready' | 'error';
  errorCode?: SiyuanPreviewErrorCode;
}

export type SiyuanRuntimeMode = 'extension-relay' | 'direct' | 'cache-only';
export type SiyuanPreviewStrategy = 'excerpt-first';
export type SiyuanAutoRefresh = 'on-hover' | 'manual';

export interface SiyuanLocalConfig {
  runtimeMode: SiyuanRuntimeMode;
  baseUrl: string;
  token?: string;
  previewStrategy: SiyuanPreviewStrategy;
  autoRefresh: SiyuanAutoRefresh;
}

export interface SiyuanPreviewResult {
  status: 'loading' | 'ready' | 'cache-only' | 'error';
  preview?: LocalSiyuanPreviewCache;
  errorCode?: SiyuanPreviewErrorCode;
  stale?: boolean;
}
