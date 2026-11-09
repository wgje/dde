type SupabaseConfigurationLogger = {
  error: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
};

export interface SupabaseConfigurationValidationResult {
  blocked: boolean;
  configurationError: string | null;
  offlineMode: boolean;
}

const SENSITIVE_KEY_PATTERNS = ['service_role', 'secret', 'private', 'admin'];

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  if (!segment) return null;

  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = normalized.length % 4;
  const padded = paddingLength === 0 ? normalized : `${normalized}${'='.repeat(4 - paddingLength)}`;

  try {
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null; // eslint-disable-line no-restricted-syntax -- JWT payload 解析失败等同无效 token
  }
}

function extractSupabaseProjectRefFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const hostname = new URL(url).hostname;
    if (!hostname.endsWith('.supabase.co')) {
      return null;
    }

    return hostname.split('.')[0] || null;
  } catch {
    // URL 解析失败时无法提取 project ref
  }
  return null;
}

function extractLegacyAnonProjectRef(key: string): string | null {
  if (!key) return null;

  const parts = key.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const payload = decodeBase64UrlJson(parts[1]);
  return typeof payload?.['ref'] === 'string' ? payload['ref'] : null;
}

function isPlaceholderConfig(value: string): boolean {
  return !value || value === 'YOUR_SUPABASE_URL' || value === 'YOUR_SUPABASE_ANON_KEY';
}

export function resolveSupabaseStorageKey(supabaseUrl: string): string | null {
  if (!supabaseUrl) return null;

  try {
    return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  } catch {
    return null; // eslint-disable-line no-restricted-syntax -- URL 解析失败时 auth token key 不可用
  }
}

export function isSensitiveSupabaseAnonKey(key: string, logger?: SupabaseConfigurationLogger): boolean {
  if (!key) return false;

  const parts = key.split('.');
  if (parts.length === 3) {
    const payload = decodeBase64UrlJson(parts[1]);
    const role = typeof payload?.['role'] === 'string' ? payload['role'] : null;

    if (role === 'anon') {
      return false;
    }

    if (role) {
      logger?.error('检测到非匿名角色密钥，已阻止使用', { role });
      return true;
    }
  }

  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some(pattern => lowerKey.includes(pattern));
}

export function validateSupabaseConfiguration(
  supabaseUrl: string,
  supabaseAnonKey: string,
  production: boolean,
  logger: SupabaseConfigurationLogger,
): SupabaseConfigurationValidationResult {
  if (isPlaceholderConfig(supabaseUrl) || isPlaceholderConfig(supabaseAnonKey)) {
    const message = 'Supabase 环境变量未配置。请运行 npm run config 或手动配置 .env.local 文件。';
    if (production) {
      logger.error('[CRITICAL] 环境变量未配置', message);
      return { blocked: true, configurationError: message, offlineMode: false };
    }

    logger.info('开发环境离线模式已启用', message);
    return { blocked: true, configurationError: null, offlineMode: true };
  }

  if (isSensitiveSupabaseAnonKey(supabaseAnonKey, logger)) {
    const message = '安全配置错误：请使用公开的 ANON_KEY 而非 SERVICE_ROLE_KEY';
    logger.error('[SECURITY] 检测到敏感密钥！前端不应使用 SERVICE_ROLE_KEY，请使用 ANON_KEY。');
    return { blocked: true, configurationError: message, offlineMode: true };
  }

  const urlProjectRef = extractSupabaseProjectRefFromUrl(supabaseUrl);
  const legacyKeyProjectRef = extractLegacyAnonProjectRef(supabaseAnonKey);
  if (urlProjectRef && legacyKeyProjectRef && urlProjectRef !== legacyKeyProjectRef) {
    const message = `Supabase 配置错误：URL 指向项目 ${urlProjectRef}，但 ANON_KEY 属于项目 ${legacyKeyProjectRef}。请保持 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY 来自同一项目。`;
    logger.error('[CRITICAL] Supabase URL / ANON_KEY 项目不一致', {
      urlProjectRef,
      legacyKeyProjectRef,
    });
    return { blocked: true, configurationError: message, offlineMode: true };
  }

  return { blocked: false, configurationError: null, offlineMode: false };
}
