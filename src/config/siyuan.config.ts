import { TIMEOUT_CONFIG } from './timeout.config';

export const SIYUAN_CONFIG = {
  MAX_PREVIEW_CHILDREN: 10,
  MAX_PREVIEW_CHARS: 1200,
  PREVIEW_FETCH_TIMEOUT_MS: TIMEOUT_CONFIG.QUICK,
  CACHE_STALE_MS: 86_400_000,
  MAX_PREVIEW_CACHE_ENTRIES: 200,
  HOVER_OPEN_DELAY_MS: 300,
  HOVER_CLOSE_GRACE_MS: 150,
  POPOVER_MAX_WIDTH_PX: 420,
  POPOVER_MAX_HEIGHT_PX: 360,
  DEFAULT_BASE_URL: 'http://127.0.0.1:6806',
  ALLOWED_DIRECT_BASE_URLS: ['http://127.0.0.1:6806', 'http://localhost:6806'] as readonly string[],
  MAX_LINK_ID_LENGTH: 64,
  MAX_URI_LENGTH: 128,
  MAX_LABEL_LENGTH: 256,
  MAX_HPATH_LENGTH: 1024,
  EXTENSION_PING_TIMEOUT_MS: 500,
  /** 思源锚点本机 pending 队列推送失败超过此次数则迁出到死信表。 */
  PENDING_MAX_RETRIES: 5,
} as const;

export const SIYUAN_ERROR_MESSAGES: Record<string, string> = {
  'not-configured': '当前设备未配置思源，仅可打开原块',
  'runtime-not-supported': '当前环境不支持实时预览',
  'extension-unavailable': '安装 NanoFlow 扩展后可实时预览',
  'kernel-unreachable': '未连接到思源，请确认思源已启动',
  'token-invalid': '思源授权失效，请重新配置',
  'block-not-found': '原块可能已删除或移动',
  'render-blocked': '预览内容包含不支持或不安全内容',
  unknown: '预览失败，可稍后重试',
};
