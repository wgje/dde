import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.93.2';

/**
 * widget-black-box-action
 *
 * 小组件大门 1-tap 已读/完成按钮的服务端入口。
 *
 * 设计口径（2026-04-22）：
 * - 小组件侧用 widget token 作 Authorization: Bearer，本入口用与 widget-summary 相同的
 *   token_hash / secret_hash 二段校验一次性认证。为避免跨函数 shared 依赖在部署期的解析
 *   问题，这里把需要的 5 个最小辅助函数全部内联，保持单文件可部署。
 * - 验证通过后只调用 service-role RPC；RPC 在同一事务内锁定设备绑定、查收据并更新
 *   `black_box_entries`。带 operationId 的重试返回首次 canonical response，不刷新
 *   `updated_at` / cooldown / `completed_at`；无 operationId 请求保留旧的非幂等行为。
 * - 响应只返回 `{ ok: true, entryId, action }`，由小组件侧做乐观缓存 + 下一次
 *   widget-summary 回环校正。失败时返回 `{ ok: false, code, error }`，小组件侧
 *   可选择回退到深链方案。
 */

interface WidgetDeviceRow {
  id: string;
  user_id: string;
  secret_hash: string;
  token_hash: string | null;
  binding_generation: number;
  revoked_at: string | null;
  expires_at: string;
}

interface WidgetTokenPayload {
  deviceId: string;
  bindingGeneration: number;
  secret: string;
}

interface RequestBody {
  entryId?: string;
  action?: string;
  operationId?: string;
  originBindingGeneration?: number;
}

type ActionKind = 'read' | 'complete';

const WIDGET_DEVICE_SELECT = 'id,user_id,secret_hash,token_hash,binding_generation,revoked_at,expires_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const ALLOWED_ORIGINS: string[] = (() => {
  const envOrigins = Deno.env.get('ALLOWED_ORIGINS');
  if (typeof envOrigins === 'string' && envOrigins.length > 0) {
    return envOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  return [
    'https://dde-eight.vercel.app',
    'https://nanoflow.app',
    'https://nanoflow.pages.dev',  // Cloudflare canonical writable origin
    'http://localhost:3020',
    'http://localhost:4200',
    'http://localhost:5173',
  ];
})();
const VERCEL_PREVIEW_PREFIX = 'dde-';
const ALLOW_PREVIEW_ORIGINS = Deno.env.get('ALLOW_PREVIEW_ORIGINS') === 'true';

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Pragma': 'no-cache',
  'Vary': 'Origin, Authorization',
} as const;
const MAX_WIDGET_REQUEST_BODY_BYTES = 1024 * 1024;

// ---- 内联辅助（与 _shared/widget-common.ts 的同名实现等价）----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function getCorsHeaders(origin: string | null): Record<string, string> {
  let isAllowed = false;
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      isAllowed = true;
    } else {
      try {
        const parsed = new URL(origin);
        // Vercel 预览
        if (ALLOW_PREVIEW_ORIGINS
          && parsed.protocol === 'https:'
          && parsed.hostname.startsWith(VERCEL_PREVIEW_PREFIX)
          && parsed.hostname.endsWith('.vercel.app')) {
          isAllowed = true;
        }
        // Cloudflare Pages PR preview：*.nanoflow.pages.dev
        if (!isAllowed && ALLOW_PREVIEW_ORIGINS && parsed.protocol === 'https:'
          && parsed.hostname.endsWith('.nanoflow.pages.dev')) {
          isAllowed = true;
        }
      } catch {
        isAllowed = false;
      }
    }
  }
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function withPrivateNoStoreHeaders(corsHeaders: Record<string, string>): Record<string, string> {
  return { ...corsHeaders, ...PRIVATE_NO_STORE_HEADERS };
}

function jsonResponse(
  payload: unknown,
  corsHeaders: Record<string, string>,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

async function sha256Hex(value: string): Promise<string> {
  const payload = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(`Widget request body exceeds ${MAX_WIDGET_REQUEST_BODY_BYTES} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

function getContentLengthBytes(req: Request): number | null {
  const contentLength = req.headers.get('content-length');
  if (!contentLength) return null;

  const bytes = Number.parseInt(contentLength, 10);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

async function readRequestTextWithLimit(req: Request): Promise<string> {
  const contentLengthBytes = getContentLengthBytes(req);
  if (contentLengthBytes !== null && contentLengthBytes > MAX_WIDGET_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }

  if (!req.body) {
    return '';
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_WIDGET_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

async function readRequestJsonWithLimit<T>(req: Request): Promise<T> {
  return JSON.parse(await readRequestTextWithLimit(req)) as T;
}

function parseWidgetToken(token: string | null): WidgetTokenPayload | null {
  if (!token) return null;

  // 新格式（JSON opaque 载荷 base64url 编码）
  try {
    const decoded = base64UrlDecode(token);
    const parsed = JSON.parse(decoded) as unknown;
    if (isPlainObject(parsed)) {
      const deviceId = parsed.deviceId;
      const bindingGeneration = parsed.bindingGeneration;
      const secret = parsed.secret;
      if (
        isUuid(deviceId)
        && typeof bindingGeneration === 'number'
        && Number.isFinite(bindingGeneration)
        && bindingGeneration >= 1
        && typeof secret === 'string'
        && secret.length >= 16
      ) {
        return {
          deviceId,
          bindingGeneration: Math.trunc(bindingGeneration),
          secret,
        };
      }
    }
  } catch {
    // 落入传统冒号格式解析
  }

  // 传统 `deviceId:bindingGeneration:secret` 格式
  try {
    const decoded = base64UrlDecode(token);
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [deviceId, bgText, secret] = parts;
    if (!isUuid(deviceId)) return null;
    if (!/^\d+$/.test(bgText)) return null;
    if (!secret || secret.length < 16) return null;
    const bindingGeneration = Number(bgText);
    if (!Number.isFinite(bindingGeneration) || bindingGeneration < 1) return null;
    return { deviceId, bindingGeneration, secret };
  } catch {
    return null;
  }
}

type SupabaseErrorLike = { message: string; code?: string };

interface SupabaseQueryResult<TData = unknown> {
  data: TData | null;
  error: SupabaseErrorLike | null;
}

interface SupabaseQueryBuilder<TData = unknown> extends PromiseLike<SupabaseQueryResult<TData>> {
  select<TSelected = unknown[]>(columns: string): SupabaseQueryBuilder<TSelected>;
  eq(column: string, value: unknown): SupabaseQueryBuilder<TData>;
  maybeSingle<TRow = unknown>(): Promise<SupabaseQueryResult<TRow>>;
}

interface SupabaseAdminClient {
  from(table: string): SupabaseQueryBuilder;
  rpc<TData = unknown>(
    functionName: string,
    parameters: Record<string, unknown>,
  ): Promise<SupabaseQueryResult<TData>>;
}

interface WidgetBlackBoxActionRpcResult {
  ok: boolean;
  status?: number;
  code?: string;
  error?: string;
  entryId?: string;
  action?: ActionKind;
  isRead?: boolean | null;
  isCompleted?: boolean | null;
  completedAt?: string | null;
  snoozeUntil?: string | null;
  updatedAt?: string | null;
}

function createServiceRoleClient(): SupabaseAdminClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service role environment is not configured');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as SupabaseAdminClient;
}

function hasServiceRoleConfig(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function serviceNotConfiguredPayload(): { error: string; code: 'SERVICE_NOT_CONFIGURED' } {
  return {
    error: 'Supabase service configuration is not configured',
    code: 'SERVICE_NOT_CONFIGURED',
  };
}

// ---- 业务入口 ----

function errorResponse(
  headers: Record<string, string>,
  status: number,
  code: string,
  error: string,
): Response {
  return jsonResponse({ ok: false, code, error }, headers, status);
}

async function loadDevice(
  client: SupabaseAdminClient,
  rawToken: string,
): Promise<WidgetDeviceRow | null> {
  const tokenHash = await sha256Hex(rawToken);
  const byHash = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (byHash.error) {
    throw new Error(`load widget device by token_hash failed: ${byHash.error.message}`);
  }
  if (byHash.data) return byHash.data as unknown as WidgetDeviceRow;

  const parsed = parseWidgetToken(rawToken);
  if (!parsed) return null;

  const byId = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('id', parsed.deviceId)
    .maybeSingle();
  if (byId.error) {
    throw new Error(`load widget device by id failed: ${byId.error.message}`);
  }
  const row = byId.data as unknown as WidgetDeviceRow | null;
  if (!row) return null;
  if (row.token_hash) return null;

  if (row.binding_generation !== parsed.bindingGeneration) return null;
  const secretHash = await sha256Hex(parsed.secret);
  if (secretHash !== row.secret_hash) return null;
  return row;
}

async function handleRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get('Origin'));
  const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse(responseHeaders, 405, 'METHOD_NOT_ALLOWED', 'Only POST is supported');
  }

  const token = getBearerToken(req);
  if (!token) {
    return errorResponse(responseHeaders, 401, 'AUTH_REQUIRED', 'Missing widget bearer token');
  }

  let body: RequestBody;
  try {
    body = await readRequestJsonWithLimit<RequestBody>(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(responseHeaders, 413, 'REQUEST_BODY_TOO_LARGE', 'Request body too large');
    }

    return errorResponse(responseHeaders, 400, 'INVALID_BODY', 'Request body must be valid JSON');
  }

  const entryId = body.entryId;
  const rawAction = body.action;
  if (!isUuid(entryId)) {
    return errorResponse(responseHeaders, 400, 'INVALID_ENTRY_ID', 'entryId must be a UUID');
  }
  if (rawAction !== 'read' && rawAction !== 'complete') {
    return errorResponse(responseHeaders, 400, 'INVALID_ACTION', "action must be 'read' or 'complete'");
  }
  const action: ActionKind = rawAction;
  const operationId = body.operationId ?? null;
  if (operationId !== null && !isUuid(operationId)) {
    return errorResponse(responseHeaders, 400, 'INVALID_OPERATION_ID', 'operationId must be a UUID');
  }
  const requestedOriginBindingGeneration = body.originBindingGeneration;
  if (operationId !== null && (
    typeof requestedOriginBindingGeneration !== 'number'
    || !Number.isInteger(requestedOriginBindingGeneration)
    || requestedOriginBindingGeneration < 1
  )) {
    return errorResponse(
      responseHeaders,
      400,
      'INVALID_BINDING_GENERATION',
      'originBindingGeneration must be a positive integer when operationId is provided',
    );
  }

  if (!hasServiceRoleConfig()) {
    return jsonResponse({ ok: false, ...serviceNotConfiguredPayload() }, responseHeaders, 503);
  }

  const client = createServiceRoleClient();

  let device: WidgetDeviceRow | null = null;
  try {
    device = await loadDevice(client, token);
  } catch (error) {
    console.error('[widget-black-box-action] load device failed', error);
    return errorResponse(responseHeaders, 500, 'DEVICE_LOOKUP_FAILED', 'Failed to verify widget token');
  }

  if (!device) {
    return errorResponse(responseHeaders, 401, 'TOKEN_INVALID', 'Widget token is invalid');
  }
  if (device.revoked_at) {
    return errorResponse(responseHeaders, 401, 'DEVICE_REVOKED', 'Widget binding has been revoked');
  }
  if (new Date(device.expires_at).getTime() <= Date.now()) {
    return errorResponse(responseHeaders, 401, 'TOKEN_EXPIRED', 'Widget token has expired');
  }

  const originBindingGeneration = operationId === null
    ? device.binding_generation
    : requestedOriginBindingGeneration!;
  const rpcResult = await client.rpc<WidgetBlackBoxActionRpcResult>('apply_widget_black_box_action', {
    p_user_id: device.user_id,
    p_device_id: device.id,
    p_entry_id: entryId,
    p_action: action,
    p_origin_binding_generation: originBindingGeneration,
    p_operation_id: operationId,
  });

  if (rpcResult.error) {
    console.error('[widget-black-box-action] action RPC failed', rpcResult.error);
    return errorResponse(responseHeaders, 500, 'ACTION_RPC_FAILED', 'Failed to apply black box action');
  }

  const result = rpcResult.data;
  if (!result || typeof result.ok !== 'boolean') {
    return errorResponse(responseHeaders, 500, 'INVALID_RPC_RESPONSE', 'Black box action RPC returned invalid data');
  }
  if (!result.ok) {
    const status = Number.isInteger(result.status) ? result.status! : 500;
    return errorResponse(
      responseHeaders,
      status,
      result.code ?? 'ACTION_REJECTED',
      result.error ?? 'Black box action was rejected',
    );
  }

  return jsonResponse(result, responseHeaders, 200);
}

Deno.serve(async (req) => {
  try {
    return await handleRequest(req);
  } catch (error) {
    console.error('[widget-black-box-action] unhandled', error);
    const corsHeaders = getCorsHeaders(req.headers.get('Origin'));
    const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);
    return errorResponse(responseHeaders, 500, 'INTERNAL_ERROR', 'Unexpected error');
  }
});
