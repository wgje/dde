import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import {
  createServiceRoleClient,
  getBearerToken,
  getCorsHeaders,
  isUuidLike,
  jsonResponse,
  parseWidgetToken,
  redactId,
  sha256Hex,
  withPrivateNoStoreHeaders,
} from '../_shared/widget-common.ts';
import { promoteSecondaryTaskToC2 } from './focus-reorder.ts';

interface WidgetDeviceRow {
  id: string;
  user_id: string;
  secret_hash: string;
  token_hash: string | null;
  binding_generation: number;
  revoked_at: string | null;
  expires_at: string;
}

interface FocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  session_state: unknown;
  updated_at: string;
}

interface RequestBody {
  action?: string;
  taskId?: string;
}

type SupabaseAdminClient = ReturnType<typeof createServiceRoleClient>;

const WIDGET_DEVICE_SELECT = 'id,user_id,secret_hash,token_hash,binding_generation,revoked_at,expires_at';
const FOCUS_SESSION_SELECT = 'id,user_id,started_at,ended_at,session_state,updated_at';

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

async function loadLatestActiveFocusSession(
  client: SupabaseAdminClient,
  userId: string,
): Promise<FocusSessionRow | null> {
  const result = await client
    .from('focus_sessions')
    .select(FOCUS_SESSION_SELECT)
    .eq('user_id', userId)
    .is('ended_at', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    throw new Error(`load focus session failed: ${result.error.message}`);
  }
  return result.data as FocusSessionRow | null;
}

async function handleRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get('Origin'), 'POST, OPTIONS');
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

  if (body.action !== 'promote-secondary') {
    return errorResponse(responseHeaders, 400, 'INVALID_ACTION', "action must be 'promote-secondary'");
  }
  if (!isUuidLike(body.taskId)) {
    return errorResponse(responseHeaders, 400, 'INVALID_TASK_ID', 'taskId must be a UUID');
  }

  const client = createServiceRoleClient();
  let device: WidgetDeviceRow | null = null;
  try {
    device = await loadDevice(client, token);
  } catch (error) {
    console.error('[widget-focus-action] load device failed', error);
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

  let session: FocusSessionRow | null = null;
  try {
    session = await loadLatestActiveFocusSession(client, device.user_id);
  } catch (error) {
    console.error('[widget-focus-action] load focus session failed', error);
    return errorResponse(responseHeaders, 500, 'FOCUS_SESSION_LOOKUP_FAILED', 'Failed to load focus session');
  }
  if (!session) {
    return errorResponse(responseHeaders, 404, 'ACTIVE_FOCUS_SESSION_NOT_FOUND', 'No active focus session found');
  }

  const nowIso = new Date().toISOString();
  const reorder = promoteSecondaryTaskToC2(session.session_state, body.taskId, nowIso);
  if (!reorder.ok) {
    const status = reorder.code === 'SECONDARY_TASK_NOT_FOUND' ? 404 : 409;
    return errorResponse(responseHeaders, status, reorder.code, reorder.error);
  }

  const update = await client
    .from('focus_sessions')
    .update({
      session_state: reorder.snapshot,
      updated_at: nowIso,
    })
    .eq('id', session.id)
    .eq('user_id', device.user_id)
    .eq('updated_at', session.updated_at)
    .is('ended_at', null)
    .select('id,updated_at')
    .maybeSingle();

  if (update.error) {
    console.error('[widget-focus-action] update failed', update.error);
    return errorResponse(responseHeaders, 500, 'UPDATE_FAILED', 'Failed to update focus session');
  }
  if (!update.data) {
    return errorResponse(responseHeaders, 409, 'FOCUS_SESSION_CHANGED', 'Focus session changed before update');
  }

  console.log('[widget-focus-action]', JSON.stringify({
    event: 'widget_focus_promote_secondary_success',
    deviceId: redactId(device.id),
    userId: redactId(device.user_id),
    sessionId: redactId(session.id),
    taskId: redactId(body.taskId),
    mainTaskId: redactId(reorder.mainTaskId),
    comboCount: reorder.comboSelectIds.length,
    backupCount: reorder.backupIds.length,
    updatedAt: update.data.updated_at,
  }));

  return jsonResponse(
    {
      ok: true,
      action: body.action,
      taskId: body.taskId,
      mainTaskId: reorder.mainTaskId,
      comboSelectIds: reorder.comboSelectIds,
      backupIds: reorder.backupIds,
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
    console.error('[widget-focus-action] unhandled', error);
    const corsHeaders = getCorsHeaders(req.headers.get('Origin'), 'POST, OPTIONS');
    const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);
    return errorResponse(responseHeaders, 500, 'INTERNAL_ERROR', 'Unexpected error');
  }
});
