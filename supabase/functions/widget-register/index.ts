import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import {
  buildWidgetClientCapabilitiesPatch,
  buildWidgetToken,
  consumeWidgetRateLimit,
  createServiceRoleClient,
  evaluateWidgetCapabilities,
  extractWidgetClientSurface,
  extractWidgetClientVersion,
  getClientIp,
  getCorsHeaders,
  jsonResponse,
  loadWidgetCapabilities,
  loadWidgetLimits,
  logWidgetEvent,
  mergeJsonObjects,
  normalizeWidgetPlatform,
  redactId,
  sha256Hex,
  toPublicWidgetCapabilities,
  verifyJwtUser,
  withPrivateNoStoreHeaders,
  type Json,
  type WidgetCapabilities,
  type WidgetPlatform,
} from '../_shared/widget-common.ts';

type WidgetRegisterAction = 'register' | 'rotate' | 'revoke' | 'revoke-all' | 'uninstall-instance';

interface WidgetInstancePayload {
  id: string;
  hostInstanceId: string;
  sizeBucket: string;
  configScope?: string;
  privacyMode?: string;
}

interface WidgetRegisterRequest {
  action?: WidgetRegisterAction;
  deviceId?: string;
  installationId?: string;
  deviceSecret?: string;
  platform?: WidgetPlatform;
  pushToken?: string | null;
  capabilities?: Json;
  instance?: WidgetInstancePayload | null;
}

interface WidgetDeviceRow {
  id: string;
  user_id: string;
  platform: WidgetPlatform;
  installation_id: string;
  secret_hash: string;
  token_hash?: string | null;
  push_token: string | null;
  push_token_updated_at?: string | null;
  capabilities: Json;
  binding_generation: number;
  revoked_at: string | null;
  expires_at: string;
  last_bound_user_hash: string;
}

const WIDGET_DEVICE_SELECT = 'id,user_id,platform,installation_id,secret_hash,token_hash,push_token,push_token_updated_at,capabilities,binding_generation,revoked_at,expires_at,last_bound_user_hash';

interface WidgetInstanceRow {
  id: string;
}

function isUuidLike(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNonEmptyText(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function normalizeInstancePayload(value: unknown): WidgetInstancePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (!isUuidLike(record.id)) return null;
  if (!isNonEmptyText(record.hostInstanceId, 128)) return null;
  if (!isNonEmptyText(record.sizeBucket, 32)) return null;

  return {
    id: record.id,
    hostInstanceId: record.hostInstanceId.trim(),
    sizeBucket: record.sizeBucket.trim(),
    configScope: record.configScope === 'global-summary' ? 'global-summary' : 'global-summary',
    privacyMode: record.privacyMode === 'minimal' ? 'minimal' : 'minimal',
  };
}

function tokenNeedsRotation(
  existing: WidgetDeviceRow | null,
  userId: string,
  secretHash: string,
  action: WidgetRegisterAction,
): boolean {
  if (!existing) return false;
  if (action === 'rotate') return true;
  if (existing.user_id !== userId) return true;
  if (existing.secret_hash !== secretHash) return true;
  if (existing.revoked_at) return true;

  return new Date(existing.expires_at).getTime() <= Date.now();
}

function buildDisabledPayload(code: 'WIDGET_DISABLED' | 'WIDGET_INSTALL_DISABLED', capabilities: WidgetCapabilities) {
  return {
    code,
    error: code === 'WIDGET_INSTALL_DISABLED'
      ? 'Widget install is currently disabled'
      : 'Widget backend is currently disabled',
    capabilities,
  };
}

async function findDeviceByInstallation(
  client: ReturnType<typeof createServiceRoleClient>,
  platform: WidgetPlatform,
  installationId: string,
): Promise<WidgetDeviceRow | null> {
  const { data, error } = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('platform', platform)
    .eq('installation_id', installationId)
    .maybeSingle();

  if (error) throw new Error(`findDeviceByInstallation failed: ${error.message}`);
  return (data as WidgetDeviceRow | null) ?? null;
}

async function findDeviceById(
  client: ReturnType<typeof createServiceRoleClient>,
  deviceId: string,
): Promise<WidgetDeviceRow | null> {
  const { data, error } = await client
    .from('widget_devices')
    .select(WIDGET_DEVICE_SELECT)
    .eq('id', deviceId)
    .maybeSingle();

  if (error) throw new Error(`findDeviceById failed: ${error.message}`);
  return (data as WidgetDeviceRow | null) ?? null;
}

async function upsertWidgetInstance(
  client: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  platform: WidgetPlatform,
  deviceId: string,
  bindingGeneration: number,
  instance: WidgetInstancePayload,
): Promise<WidgetInstanceRow> {
  const now = new Date().toISOString();

  const { data, error } = await client
    .from('widget_instances')
    .upsert({
      id: instance.id,
      device_id: deviceId,
      user_id: userId,
      platform,
      host_instance_id: instance.hostInstanceId,
      size_bucket: instance.sizeBucket,
      config_scope: instance.configScope ?? 'global-summary',
      privacy_mode: instance.privacyMode ?? 'minimal',
      binding_generation: bindingGeneration,
      installed_at: now,
      last_seen_at: now,
      uninstalled_at: null,
      updated_at: now,
    }, { onConflict: 'device_id,host_instance_id' })
    .select('id')
    .single();

  if (error) {
    throw new Error(`upsert widget instance failed: ${error.message}`);
  }

  return data as WidgetInstanceRow;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin, 'POST, OPTIONS');
  const responseHeaders = withPrivateNoStoreHeaders(corsHeaders);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, responseHeaders, 405);
  }

  const auth = await verifyJwtUser(req);
  if (!auth) {
    logWidgetEvent('widget_register_failure', { code: 'AUTH_REQUIRED', status: 401 });
    return jsonResponse({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, responseHeaders, 401);
  }

  const client = createServiceRoleClient();
  const limits = await loadWidgetLimits(client);
  const userScopeKey = await sha256Hex(`widget-register-user:${auth.userId}`);
  const ipScopeKey = await sha256Hex(`widget-register-ip:${getClientIp(req)}`);

  for (const [scopeType, scopeKey, maxCalls] of [
    ['user', userScopeKey, limits.registerUserPerMinute],
    ['ip', ipScopeKey, limits.registerIpPerMinute],
  ] as const) {
    const rate = await consumeWidgetRateLimit(client, scopeType, scopeKey, maxCalls, limits.blockSeconds);
    if (!rate.allowed) {
      return jsonResponse({
        error: 'Too many widget registration requests',
        code: 'RATE_LIMITED',
        retryAfterSeconds: rate.retryAfterSeconds,
      }, responseHeaders, 429);
    }
  }

  let body: WidgetRegisterRequest;
  try {
    body = await req.json() as WidgetRegisterRequest;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, responseHeaders, 400);
  }

  const action: WidgetRegisterAction = body.action ?? 'register';
  if (action !== 'register' && action !== 'rotate' && action !== 'revoke' && action !== 'revoke-all' && action !== 'uninstall-instance') {
    return jsonResponse({ error: 'Unsupported action', code: 'INVALID_ACTION' }, responseHeaders, 400);
  }

  const capabilities = await loadWidgetCapabilities(client);

  if (action === 'revoke-all') {
    const now = new Date().toISOString();
    const { data, error } = await client
      .from('widget_devices')
      .update({
        revoked_at: now,
        revoke_reason: 'user-revoke-all',
        expires_at: now,
        push_token: null,
        push_token_updated_at: now,
        updated_at: now,
      })
      .eq('user_id', auth.userId)
      .is('revoked_at', null)
      .select('id');

    if (error) {
      logWidgetEvent('widget_register_failure', {
        userId: auth.userId,
        action: 'revoke-all',
        code: 'REVOKE_ALL_FAILED',
        status: 500,
      });
      return jsonResponse({ error: 'Failed to revoke widget devices', code: 'REVOKE_ALL_FAILED' }, responseHeaders, 500);
    }

    const revokedCount = Array.isArray(data) ? data.length : 0;
    logWidgetEvent('widget_account_switch_cleanup', {
      userId: auth.userId,
      action: 'revoke-all',
      extra: { revokedCount },
    });
    return jsonResponse({
      revokedCount,
      capabilities,
    }, responseHeaders, 200);
  }

  const platform = normalizeWidgetPlatform(body.platform);
  if (!platform) {
    return jsonResponse({ error: 'Invalid platform', code: 'INVALID_PLATFORM' }, responseHeaders, 400);
  }

  if (!isNonEmptyText(body.installationId, 128)) {
    return jsonResponse({ error: 'installationId is required', code: 'INSTALLATION_ID_REQUIRED' }, responseHeaders, 400);
  }

  const installationId = body.installationId.trim();
  const existingByInstallation = await findDeviceByInstallation(client, platform, installationId);
  const existingById = isUuidLike(body.deviceId)
    ? await findDeviceById(client, body.deviceId)
    : null;
  if (existingByInstallation && existingById && existingByInstallation.id !== existingById.id) {
    return jsonResponse({ error: 'deviceId does not match installationId', code: 'DEVICE_INSTALLATION_MISMATCH' }, responseHeaders, 409);
  }

  if (!existingByInstallation && existingById && existingById.user_id !== auth.userId) {
    return jsonResponse({ error: 'deviceId is already bound to another account', code: 'DEVICE_ALREADY_BOUND' }, responseHeaders, 409);
  }

  if (
    existingById
    && existingById.user_id === auth.userId
    && (existingById.installation_id !== installationId || existingById.platform !== platform)
  ) {
    return jsonResponse({ error: 'deviceId is already bound to another installation', code: 'DEVICE_INSTALLATION_CONFLICT' }, responseHeaders, 409);
  }

  const existing = existingByInstallation ?? existingById;
  const instance = normalizeInstancePayload(body.instance);
  if (body.instance && !instance) {
    return jsonResponse({ error: 'instance payload is invalid', code: 'INVALID_INSTANCE' }, responseHeaders, 400);
  }

  if (action === 'revoke') {
    if (!existing || existing.user_id !== auth.userId) {
      return jsonResponse({ revoked: false, capabilities }, responseHeaders, 200);
    }

    const now = new Date().toISOString();
    const { error } = await client
      .from('widget_devices')
      .update({
        revoked_at: now,
        revoke_reason: 'user-revoke',
        expires_at: now,
        push_token: null,
        push_token_updated_at: now,
        updated_at: now,
      })
      .eq('id', existing.id)
      .eq('user_id', auth.userId);

    if (error) {
      logWidgetEvent('widget_register_failure', {
        userId: auth.userId,
        deviceId: existing.id,
        action: 'revoke',
        code: 'REVOKE_FAILED',
        status: 500,
      });
      return jsonResponse({ error: 'Failed to revoke widget device', code: 'REVOKE_FAILED' }, responseHeaders, 500);
    }

    logWidgetEvent('widget_register_success', {
      userId: auth.userId,
      deviceId: existing.id,
      action: 'revoke',
    });
    return jsonResponse({
      revoked: true,
      deviceId: existing.id,
      capabilities,
    }, responseHeaders, 200);
  }

  if (action === 'uninstall-instance') {
    if (!existing || existing.user_id !== auth.userId) {
      return jsonResponse({ uninstalled: false, capabilities }, responseHeaders, 200);
    }

    if (!instance) {
      return jsonResponse({ error: 'instance payload is invalid', code: 'INVALID_INSTANCE' }, responseHeaders, 400);
    }

    const now = new Date().toISOString();
    const { data, error } = await client
      .from('widget_instances')
      .update({
        uninstalled_at: now,
        last_seen_at: now,
        updated_at: now,
      })
      .eq('id', instance.id)
      .eq('device_id', existing.id)
      .eq('user_id', auth.userId)
      .eq('platform', platform)
      .is('uninstalled_at', null)
      .select('id')
      .maybeSingle();

    if (error) {
      logWidgetEvent('widget_register_failure', {
        userId: auth.userId,
        deviceId: existing.id,
        instanceId: instance.id,
        platform,
        action,
        code: 'INSTANCE_UNINSTALL_FAILED',
        status: 500,
      });
      return jsonResponse({ error: 'Failed to uninstall widget instance', code: 'INSTANCE_UNINSTALL_FAILED' }, responseHeaders, 500);
    }

    const uninstalled = Boolean((data as WidgetInstanceRow | null)?.id);
    if (uninstalled) {
      logWidgetEvent('widget_instance_uninstall', {
        userId: auth.userId,
        deviceId: existing.id,
        instanceId: instance.id,
        platform,
        action,
      });
    }

    return jsonResponse({
      uninstalled,
      deviceId: existing.id,
      instanceId: uninstalled ? instance.id : null,
      capabilities,
    }, responseHeaders, 200);
  }

  if (!isUuidLike(body.deviceId)) {
    return jsonResponse({ error: 'deviceId must be a UUID', code: 'INVALID_DEVICE_ID' }, responseHeaders, 400);
  }
  if (!isNonEmptyText(body.deviceSecret, 128)) {
    return jsonResponse({ error: 'deviceSecret is required', code: 'DEVICE_SECRET_REQUIRED' }, responseHeaders, 400);
  }

  const deviceId = body.deviceId;
  const deviceSecret = body.deviceSecret.trim();
  if (deviceSecret.length < 16) {
    return jsonResponse({ error: 'deviceSecret must be at least 16 characters', code: 'DEVICE_SECRET_TOO_SHORT' }, responseHeaders, 400);
  }
  const secretHash = await sha256Hex(deviceSecret);

  if (existingByInstallation && existingByInstallation.user_id !== auth.userId) {
    const matchesExistingInstallation = existingByInstallation.id === deviceId
      && existingByInstallation.secret_hash === secretHash;
    if (!matchesExistingInstallation) {
      return jsonResponse({ error: 'installationId is already bound to another account', code: 'DEVICE_ALREADY_BOUND' }, responseHeaders, 409);
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const requestedClientVersion = extractWidgetClientVersion(body.capabilities ?? null);
  const requestedClientSurface = extractWidgetClientSurface(body.capabilities ?? null);
  const requestedCapabilities = mergeJsonObjects(
    body.capabilities ?? null,
    buildWidgetClientCapabilitiesPatch({
      platform,
      clientVersion: requestedClientVersion,
      clientSurface: requestedClientSurface,
      observedAt: nowIso,
    }),
  );
  const capabilityDecision = evaluateWidgetCapabilities(capabilities, {
    platform,
    installationId,
    deviceId,
    clientVersion: requestedClientVersion,
  });
  const publicCapabilities = toPublicWidgetCapabilities(capabilityDecision);
  if (!capabilityDecision.widgetEnabled || !capabilityDecision.installAllowed) {
    const disableCode = capabilityDecision.widgetEnabled ? 'WIDGET_INSTALL_DISABLED' : 'WIDGET_DISABLED';
    logWidgetEvent('widget_killswitch_applied', {
      userId: auth.userId,
      deviceId,
      platform,
      code: disableCode,
      reason: capabilityDecision.reason ?? 'widget-install-disabled',
      status: 503,
      extra: {
        clientVersion: capabilityDecision.clientVersion,
        matchedRuleIds: capabilityDecision.matchedRuleIds.join(','),
        rolloutBucket: capabilityDecision.rolloutBucket,
      },
    });
    logWidgetEvent('widget_register_failure', {
      userId: auth.userId,
      deviceId,
      platform,
      code: disableCode,
      reason: capabilityDecision.reason ?? 'widget-install-disabled',
      status: 503,
      extra: {
        clientVersion: capabilityDecision.clientVersion,
        matchedRuleIds: capabilityDecision.matchedRuleIds.join(','),
        rolloutBucket: capabilityDecision.rolloutBucket,
      },
    });
    return jsonResponse(buildDisabledPayload(disableCode, publicCapabilities), responseHeaders, 503);
  }

  const userHash = await sha256Hex(auth.userId);
  const needsRotation = tokenNeedsRotation(existing, auth.userId, secretHash, action);
  const bindingGeneration = existing
    ? (needsRotation ? existing.binding_generation + 1 : existing.binding_generation)
    : 1;
  const expiresAt = new Date(now.getTime() + (limits.tokenTtlDays * 24 * 60 * 60 * 1000)).toISOString();
  const canonicalDeviceId = existing?.id ?? deviceId;
  const widgetToken = buildWidgetToken({
    deviceId: canonicalDeviceId,
    bindingGeneration,
    secret: deviceSecret,
  });
  const tokenHash = await sha256Hex(widgetToken);
  const trimmedPushToken = typeof body.pushToken === 'string' ? body.pushToken.trim() : null;
  const deviceUpsert: Record<string, unknown> = {
    id: canonicalDeviceId,
    user_id: auth.userId,
    platform,
    installation_id: installationId,
    secret_hash: secretHash,
    token_hash: tokenHash,
    capabilities: mergeJsonObjects(existing?.capabilities, requestedCapabilities),
    binding_generation: bindingGeneration,
    last_seen_at: nowIso,
    revoked_at: null,
    revoke_reason: null,
    expires_at: expiresAt,
    last_bound_user_hash: userHash,
    updated_at: nowIso,
  };

  if (body.pushToken !== undefined) {
    deviceUpsert.push_token = trimmedPushToken;
    deviceUpsert.push_token_updated_at = nowIso;
  }

  const { error: upsertError } = await client
    .from('widget_devices')
    .upsert(deviceUpsert, { onConflict: 'id' });

  if (upsertError) {
    console.error('[WidgetRegister] upsert failed', {
      userId: redactId(auth.userId),
      platform,
      installationId: redactId(installationId),
      message: upsertError.message,
    });
    logWidgetEvent('widget_register_failure', {
      userId: auth.userId,
      deviceId: canonicalDeviceId,
      platform,
      action,
      code: 'REGISTER_FAILED',
      status: 500,
    });
    return jsonResponse({ error: 'Failed to register widget device', code: 'REGISTER_FAILED' }, responseHeaders, 500);
  }

  const instanceRow = instance
    ? await upsertWidgetInstance(client, auth.userId, platform, canonicalDeviceId, bindingGeneration, instance)
    : null;

  logWidgetEvent('widget_register_success', {
    userId: auth.userId,
    deviceId: canonicalDeviceId,
    platform,
    action,
    bindingGeneration,
  });
  if (instance && instanceRow) {
    logWidgetEvent('widget_instance_install', {
      userId: auth.userId,
      deviceId: canonicalDeviceId,
      instanceId: instanceRow.id,
      platform,
      bindingGeneration,
    });
  }

  return jsonResponse({
    deviceId: canonicalDeviceId,
    bindingGeneration,
    expiresAt,
    widgetToken,
    summaryPath: '/functions/v1/widget-summary',
    capabilities: publicCapabilities,
    instance: instanceRow ? { id: instanceRow.id } : null,
  }, responseHeaders, 200);
});
