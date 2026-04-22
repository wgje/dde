import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

/**
 * widget-black-box-action
 *
 * 小组件大门 1-tap 已读/完成按钮的服务端入口。
 *
 * 设计口径（2026-04-22）：
 * - 小组件侧用 widget token 作 Authorization: Bearer，本入口用与 widget-summary 相同的
 *   token_hash / secret_hash 二段校验一次性认证。为避免跨函数 shared 依赖在部署期的解析
 *   问题，这里把需要的 5 个最小辅助函数全部内联，保持单文件可部署。
 * - 验证通过后以 service-role client 直接 PATCH `black_box_entries` 行的
 *   `is_read` 或 `is_completed` 字段；BEFORE UPDATE 触发器会盖章权威 `updated_at`，
 *   LWW 同步把变更广播到其它端（网页 / TWA）。
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
}

type ActionKind = 'read' | 'complete';

const WIDGET_DEVICE_SELECT = 'id,user_id,secret_hash,token_hash,binding_generation,revoked_at,expires_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const ALLOWED_ORIGINS: string[] = (() => {
  const envOrigins = Deno.env.get('ALLOWED_ORIGINS');
  if (envOrigins) {
    return envOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  return [
    'https://dde-eight.vercel.app',
    'https://nanoflow.app',
    'http://localhost:3020',
    'http://localhost:4200',
    'http://localhost:5173',
  ];
})();
const VERCEL_PREVIEW_PREFIX = 'dde-';

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Pragma': 'no-cache',
  'Vary': 'Origin, Authorization',
} as const;

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
        isAllowed = parsed.hostname.startsWith(VERCEL_PREVIEW_PREFIX)
          && parsed.hostname.endsWith('.vercel.app');
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

function redactId(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value.length <= 8 ? value : `${value.slice(0, 8)}...`;
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

type SupabaseAdminClient = ReturnType<typeof createClient>;

function createServiceRoleClient(): SupabaseAdminClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service role environment is not configured');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
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
  if (byHash.data) return byHash.data as WidgetDeviceRow;

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
  const row = byId.data as WidgetDeviceRow | null;
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
    body = (await req.json()) as RequestBody;
  } catch {
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

  // 2026-04-22 语义强化：
  //   * `read`  → 设 `is_read=true` 并把 `snooze_until` 推到「明天」。
  //     schema 里 snooze_until 是 `date` 粒度；widget_summary_wave1 的过滤是
  //     `date < p_today AND (snooze_until IS NULL OR snooze_until <= p_today)`。
  //     令 snooze_until = 明天（UTC），今天 p_today=今天，
  //     `明天 <= 今天` = false → 当天隐藏；次日 p_today 前进，条目重新浮出，
  //     对齐用户需求「过一段时间大门会再次出现 / 间歇式反复」。
  //   * `complete` → 设 `is_completed=true`。Web 端 strata-view（项目历史回顾）
  //     会拉取 is_completed=true 条目，RPC gate 口径会过滤掉它，对齐需求
  //     「选择了完成则黑匣子对应条目会被放置于'项目历史回顾'板块」。
  const nowMs = Date.now();
  const tomorrowIsoDate = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const patch: Record<string, unknown> = action === 'read'
    ? { is_read: true, snooze_until: tomorrowIsoDate }
    : { is_completed: true };

  const update = await client
    .from('black_box_entries')
    .update(patch)
    .eq('id', entryId)
    .eq('user_id', device.user_id)
    .is('deleted_at', null)
    .select('id,is_read,is_completed,snooze_until,updated_at')
    .maybeSingle();

  if (update.error) {
    console.error('[widget-black-box-action] update failed', update.error);
    return errorResponse(responseHeaders, 500, 'UPDATE_FAILED', 'Failed to update black box entry');
  }
  if (!update.data) {
    return errorResponse(responseHeaders, 404, 'ENTRY_NOT_FOUND', 'Black box entry not found for user');
  }

  console.log('[widget-black-box-action]', JSON.stringify({
    event: 'widget_black_box_action_success',
    action,
    deviceId: redactId(device.id),
    userId: redactId(device.user_id),
    entryId: redactId(entryId),
    snoozeUntil: update.data.snooze_until ?? null,
    updatedAt: update.data.updated_at,
  }));

  return jsonResponse(
    {
      ok: true,
      entryId,
      action,
      isRead: update.data.is_read,
      isCompleted: update.data.is_completed,
      snoozeUntil: update.data.snooze_until ?? null,
      updatedAt: update.data.updated_at,
    },
    responseHeaders,
    200,
  );
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
