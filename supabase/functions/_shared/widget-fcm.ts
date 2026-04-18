// ============================================================
// Widget FCM (Firebase Cloud Messaging) HTTP v1 客户端
// ----------------------------------------------------------------
// 用于 widget-notify Edge Function 的 Android Widget 推送。
// - 使用 Service Account JSON (FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY)
//   通过 RS256 签名 JWT 换取 OAuth2 access token。
// - 缓存 access token 到进程内存（TTL < 55 分钟）。
// - 调用 https://fcm.googleapis.com/v1/projects/{PROJECT_ID}/messages:send。
// - 对失败的设备 token（UNREGISTERED / INVALID_ARGUMENT 涉及 token），
//   返回专用错误码，供调用方把 push_token 置空 / 吊销设备。
// ============================================================

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SEND_URL_PREFIX = 'https://fcm.googleapis.com/v1/projects/';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ACCESS_TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 提前 5 分钟过期

export type FcmPushFailureReason =
  | 'unregistered'
  | 'invalid-token'
  | 'provider-quota-exceeded'
  | 'provider-unavailable'
  | 'provider-error';

export interface FcmPushResult {
  ok: boolean;
  failure?: FcmPushFailureReason;
  statusCode?: number;
  messageName?: string;
  errorStatus?: string;
}

interface AccessTokenCache {
  token: string;
  expiresAtMs: number;
}

let accessTokenCache: AccessTokenCache | null = null;

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export function loadFcmServiceAccount(): FcmServiceAccount | null {
  const projectId = Deno.env.get('FCM_PROJECT_ID')?.trim();
  const clientEmail = Deno.env.get('FCM_CLIENT_EMAIL')?.trim();
  const privateKey = Deno.env.get('FCM_PRIVATE_KEY')?.trim();
  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }
  // 允许传入 `\n` 转义（Supabase Secret 常见用法），统一为真实换行。
  return {
    projectId,
    clientEmail,
    privateKey: privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(new TextEncoder().encode(value));
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const normalized = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importServiceAccountPrivateKey(privateKey: string): Promise<CryptoKey> {
  const keyBytes = pemToPkcs8Bytes(privateKey);
  return await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signRs256(key: CryptoKey, data: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(data),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function fetchFreshAccessToken(account: FcmServiceAccount): Promise<AccessTokenCache> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claim))}`;
  const key = await importServiceAccountPrivateKey(account.privateKey);
  const signature = await signRs256(key, unsigned);
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FCM OAuth token exchange failed (${response.status}): ${text.slice(0, 256)}`);
  }

  const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  const token = typeof json.access_token === 'string' ? json.access_token : null;
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
  if (!token || !expiresIn) {
    throw new Error('FCM OAuth response missing access_token / expires_in');
  }

  return {
    token,
    expiresAtMs: Date.now() + expiresIn * 1000 - ACCESS_TOKEN_SAFETY_MARGIN_MS,
  };
}

export async function getFcmAccessToken(account: FcmServiceAccount): Promise<string> {
  const now = Date.now();
  if (accessTokenCache && accessTokenCache.expiresAtMs > now) {
    return accessTokenCache.token;
  }
  accessTokenCache = await fetchFreshAccessToken(account);
  return accessTokenCache.token;
}

function classifyFcmErrorStatus(statusCode: number, errorStatus: string | null): FcmPushFailureReason {
  if (statusCode === 404 || errorStatus === 'NOT_FOUND' || errorStatus === 'UNREGISTERED') {
    return 'unregistered';
  }
  if (statusCode === 400 || errorStatus === 'INVALID_ARGUMENT') {
    return 'invalid-token';
  }
  if (statusCode === 429 || errorStatus === 'QUOTA_EXCEEDED' || errorStatus === 'RESOURCE_EXHAUSTED') {
    return 'provider-quota-exceeded';
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return 'provider-unavailable';
  }
  return 'provider-error';
}

export interface FcmDataPushInput {
  account: FcmServiceAccount;
  accessToken: string;
  deviceToken: string;
  data: Record<string, string>;
}

/**
 * 发送一条 data-only 推送（无 notification payload，避免系统托盘干扰）。
 * 所有 value 必须为字符串，FCM v1 约束。
 */
export async function sendFcmDataPush(input: FcmDataPushInput): Promise<FcmPushResult> {
  const url = `${FCM_SEND_URL_PREFIX}${input.account.projectId}/messages:send`;
  const body = {
    message: {
      token: input.deviceToken,
      data: input.data,
      android: {
        priority: 'HIGH',
        ttl: '300s',
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (_err) {
    return { ok: false, failure: 'provider-unavailable' };
  }

  if (response.ok) {
    const json = (await response.json().catch(() => null)) as { name?: unknown } | null;
    return {
      ok: true,
      statusCode: response.status,
      messageName: json && typeof json.name === 'string' ? json.name : undefined,
    };
  }

  let errorStatus: string | null = null;
  try {
    const errJson = (await response.json()) as { error?: { status?: unknown } };
    if (errJson?.error && typeof errJson.error.status === 'string') {
      errorStatus = errJson.error.status;
    }
  } catch (_err) {
    // 忽略解析失败
  }

  return {
    ok: false,
    statusCode: response.status,
    errorStatus: errorStatus ?? undefined,
    failure: classifyFcmErrorStatus(response.status, errorStatus),
  };
}

/**
 * 单元测试钩子：清空内存缓存。
 */
export function resetFcmAccessTokenCacheForTests(): void {
  accessTokenCache = null;
}
