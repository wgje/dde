import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.93.2';

import { normalizeWidgetLimitNumber } from './widget-normalization.ts';

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type WidgetPlatform = 'android-widget';
export type WidgetRateLimitScope = 'device' | 'user' | 'ip';

export interface WidgetCapabilities {
  widgetEnabled: boolean;
  installAllowed: boolean;
  refreshAllowed: boolean;
  pushAllowed: boolean;
  reason: string | null;
}

export interface WidgetCapabilityRuleApply {
  widgetEnabled?: boolean;
  installAllowed?: boolean;
  refreshAllowed?: boolean;
  pushAllowed?: boolean;
  reason?: string | null;
}

export interface WidgetCapabilityRule {
  id: string;
  platforms: WidgetPlatform[];
  clientVersions: string[];
  clientVersionPrefixes: string[];
  bucketMin: number | null;
  bucketMax: number | null;
  apply: WidgetCapabilityRuleApply;
}

export interface WidgetCapabilityConfig extends WidgetCapabilities {
  rules: WidgetCapabilityRule[];
}

export interface WidgetCapabilityContext {
  platform: WidgetPlatform | null;
  installationId?: string | null;
  deviceId?: string | null;
  clientVersion?: string | null;
  supportsPush?: boolean | null;
}

export interface WidgetCapabilityDecision extends WidgetCapabilities {
  matchedRuleIds: string[];
  rolloutBucket: number | null;
  clientVersion: string | null;
}

export interface WidgetLimits {
  registerUserPerMinute: number;
  registerIpPerMinute: number;
  summaryDevicePerMinute: number;
  summaryUserPerMinute: number;
  summaryIpPerMinute: number;
  notifyUserPerMinute: number;
  notifyIpPerMinute: number;
  blockSeconds: number;
  tokenTtlDays: number;
  freshThresholdMinutes: number;
  agingThresholdMinutes: number;
}

export interface WidgetTokenPayload {
  deviceId: string;
  bindingGeneration: number;
  secret: string;
}

export interface WidgetRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingCalls: number;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const ALLOWED_ORIGINS: string[] = (() => {
  const envOrigins = Deno.env.get('ALLOWED_ORIGINS');
  if (envOrigins) {
    return envOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
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

export const DEFAULT_WIDGET_CAPABILITIES: WidgetCapabilityConfig = {
  widgetEnabled: true,
  installAllowed: true,
  refreshAllowed: true,
  pushAllowed: false,
  reason: null,
  rules: [],
};

export const DEFAULT_WIDGET_LIMITS: WidgetLimits = {
  registerUserPerMinute: 10,
  registerIpPerMinute: 20,
  summaryDevicePerMinute: 30,
  summaryUserPerMinute: 60,
  summaryIpPerMinute: 120,
  notifyUserPerMinute: 120,
  notifyIpPerMinute: 600,
  blockSeconds: 300,
  tokenTtlDays: 30,
  freshThresholdMinutes: 5,
  agingThresholdMinutes: 60,
};

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Pragma': 'no-cache',
  'Vary': 'Origin, Authorization',
} as const;

type SupabaseAdminClient = ReturnType<typeof createClient>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalText(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

function normalizeBucketValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.trunc(value);
  return normalized >= 0 && normalized <= 99 ? normalized : null;
}

function normalizeStringList(value: unknown, maxLength = 256): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => normalizeOptionalText(entry, maxLength))
      .filter((entry): entry is string => entry !== null),
  )];
}

function normalizePlatformList(value: unknown): WidgetPlatform[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => normalizeWidgetPlatform(entry))
      .filter((entry): entry is WidgetPlatform => entry !== null),
  )];
}

function normalizeCapabilityRuleApply(value: unknown): WidgetCapabilityRuleApply | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const apply: WidgetCapabilityRuleApply = {};

  if (typeof value.widgetEnabled === 'boolean') {
    apply.widgetEnabled = value.widgetEnabled;
  }
  if (typeof value.installAllowed === 'boolean') {
    apply.installAllowed = value.installAllowed;
  }
  if (typeof value.refreshAllowed === 'boolean') {
    apply.refreshAllowed = value.refreshAllowed;
  }
  if (typeof value.pushAllowed === 'boolean') {
    apply.pushAllowed = value.pushAllowed;
  }

  const reason = normalizeOptionalText(value.reason, 256);
  if (reason !== null || value.reason === null) {
    apply.reason = reason;
  }

  return Object.keys(apply).length > 0 ? apply : null;
}

function normalizeCapabilityRule(value: unknown, index: number): WidgetCapabilityRule | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const apply = normalizeCapabilityRuleApply(value.apply);
  if (!apply) {
    return null;
  }

  const bucketMin = normalizeBucketValue(value.bucketMin);
  const bucketMax = normalizeBucketValue(value.bucketMax);
  if (bucketMin !== null && bucketMax !== null && bucketMin > bucketMax) {
    return null;
  }

  const platformsProvided = Array.isArray(value.platforms) && value.platforms.length > 0;
  const platforms = normalizePlatformList(value.platforms);
  if (platformsProvided && platforms.length === 0) {
    return null;
  }

  return {
    id: normalizeOptionalText(value.id, 128) ?? `rule-${index + 1}`,
    platforms,
    clientVersions: normalizeStringList(value.clientVersions, 256),
    clientVersionPrefixes: normalizeStringList(value.clientVersionPrefixes, 128),
    bucketMin,
    bucketMax,
    apply,
  };
}

function normalizeCapabilityRules(value: unknown): WidgetCapabilityRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => normalizeCapabilityRule(entry, index))
    .filter((entry): entry is WidgetCapabilityRule => entry !== null);
}

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function normalizeCapabilities(value: unknown): WidgetCapabilityConfig {
  if (!isPlainObject(value)) {
    return DEFAULT_WIDGET_CAPABILITIES;
  }

  return {
    widgetEnabled: typeof value.widgetEnabled === 'boolean'
      ? value.widgetEnabled
      : DEFAULT_WIDGET_CAPABILITIES.widgetEnabled,
    installAllowed: typeof value.installAllowed === 'boolean'
      ? value.installAllowed
      : DEFAULT_WIDGET_CAPABILITIES.installAllowed,
    refreshAllowed: typeof value.refreshAllowed === 'boolean'
      ? value.refreshAllowed
      : DEFAULT_WIDGET_CAPABILITIES.refreshAllowed,
    pushAllowed: typeof value.pushAllowed === 'boolean'
      ? value.pushAllowed
      : DEFAULT_WIDGET_CAPABILITIES.pushAllowed,
    reason: normalizeOptionalText(value.reason, 256),
    rules: normalizeCapabilityRules(value.rules),
  };
}

function hashStringToBucket(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % 100;
}

function resolveRolloutBucket(input: WidgetCapabilityContext): number | null {
  const seed = normalizeOptionalText(input.installationId, 256)
    ?? normalizeOptionalText(input.deviceId, 256);

  return seed ? hashStringToBucket(seed) : null;
}

function matchesWidgetCapabilityRule(
  rule: WidgetCapabilityRule,
  context: WidgetCapabilityContext,
  rolloutBucket: number | null,
  clientVersion: string | null,
): boolean {
  if (rule.platforms.length > 0) {
    if (!context.platform || !rule.platforms.includes(context.platform)) {
      return false;
    }
  }

  if (rule.clientVersions.length > 0) {
    if (!clientVersion || !rule.clientVersions.includes(clientVersion)) {
      return false;
    }
  }

  if (rule.clientVersionPrefixes.length > 0) {
    if (!clientVersion || !rule.clientVersionPrefixes.some((prefix) => clientVersion.startsWith(prefix))) {
      return false;
    }
  }

  if (rule.bucketMin !== null || rule.bucketMax !== null) {
    if (rolloutBucket === null) {
      return false;
    }
    if (rule.bucketMin !== null && rolloutBucket < rule.bucketMin) {
      return false;
    }
    if (rule.bucketMax !== null && rolloutBucket > rule.bucketMax) {
      return false;
    }
  }

  return true;
}

export function evaluateWidgetCapabilities(
  config: WidgetCapabilityConfig,
  context: WidgetCapabilityContext,
): WidgetCapabilityDecision {
  const rolloutBucket = resolveRolloutBucket(context);
  const clientVersion = normalizeOptionalText(context.clientVersion, 256);

  const decision: WidgetCapabilityDecision = {
    widgetEnabled: config.widgetEnabled,
    installAllowed: config.installAllowed,
    refreshAllowed: config.refreshAllowed,
    pushAllowed: config.pushAllowed,
    reason: config.reason,
    matchedRuleIds: [],
    rolloutBucket,
    clientVersion,
  };

  for (const rule of config.rules) {
    if (!matchesWidgetCapabilityRule(rule, context, rolloutBucket, clientVersion)) {
      continue;
    }

    decision.matchedRuleIds.push(rule.id);
    if (typeof rule.apply.widgetEnabled === 'boolean') {
      decision.widgetEnabled = rule.apply.widgetEnabled;
    }
    if (typeof rule.apply.installAllowed === 'boolean') {
      decision.installAllowed = rule.apply.installAllowed;
    }
    if (typeof rule.apply.refreshAllowed === 'boolean') {
      decision.refreshAllowed = rule.apply.refreshAllowed;
    }
    if (typeof rule.apply.pushAllowed === 'boolean') {
      decision.pushAllowed = rule.apply.pushAllowed;
    }
    if (rule.apply.reason !== undefined) {
      decision.reason = rule.apply.reason ?? null;
    }
  }

  return decision;
}

export function toPublicWidgetCapabilities(value: WidgetCapabilities): WidgetCapabilities {
  return {
    widgetEnabled: value.widgetEnabled,
    installAllowed: value.installAllowed,
    refreshAllowed: value.refreshAllowed,
    pushAllowed: value.pushAllowed,
    reason: value.reason,
  };
}

export function extractWidgetClientVersion(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const directValue = normalizeOptionalText(value.clientVersion, 256);
  if (directValue) {
    return directValue;
  }

  const clientContext = isPlainObject(value.clientContext) ? value.clientContext : null;
  return normalizeOptionalText(clientContext?.clientVersion, 256);
}

export function extractWidgetClientSurface(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const directValue = normalizeOptionalText(value.clientSurface, 128);
  if (directValue) {
    return directValue;
  }

  const clientContext = isPlainObject(value.clientContext) ? value.clientContext : null;
  return normalizeOptionalText(clientContext?.clientSurface, 128);
}

export function extractWidgetPushSupport(value: unknown): boolean | null {
  if (!isPlainObject(value)) {
    return null;
  }

  if (typeof value.supportsPush === 'boolean') {
    return value.supportsPush;
  }

  const clientContext = isPlainObject(value.clientContext) ? value.clientContext : null;
  return typeof clientContext?.supportsPush === 'boolean'
    ? clientContext.supportsPush
    : null;
}

export function buildWidgetClientCapabilitiesPatch(input: {
  platform: WidgetPlatform;
  clientVersion?: string | null;
  clientSurface?: string | null;
  supportsPush?: boolean | null;
  observedAt?: string | null;
}): Json {
  const clientVersion = normalizeOptionalText(input.clientVersion, 256);
  const clientSurface = normalizeOptionalText(input.clientSurface, 128);
  const supportsPush = typeof input.supportsPush === 'boolean' ? input.supportsPush : null;
  const observedAt = normalizeOptionalText(input.observedAt, 128);

  if (!clientVersion && !clientSurface && supportsPush === null) {
    return {};
  }

  return {
    clientContext: {
      platform: input.platform,
      clientVersion,
      clientSurface,
      supportsPush,
      observedAt,
    },
  };
}

function normalizeLimits(value: unknown): WidgetLimits {
  if (!isPlainObject(value)) {
    return DEFAULT_WIDGET_LIMITS;
  }

  return {
    registerUserPerMinute: normalizeWidgetLimitNumber(value.registerUserPerMinute, DEFAULT_WIDGET_LIMITS.registerUserPerMinute),
    registerIpPerMinute: normalizeWidgetLimitNumber(value.registerIpPerMinute, DEFAULT_WIDGET_LIMITS.registerIpPerMinute),
    summaryDevicePerMinute: normalizeWidgetLimitNumber(value.summaryDevicePerMinute, DEFAULT_WIDGET_LIMITS.summaryDevicePerMinute),
    summaryUserPerMinute: normalizeWidgetLimitNumber(value.summaryUserPerMinute, DEFAULT_WIDGET_LIMITS.summaryUserPerMinute),
    summaryIpPerMinute: normalizeWidgetLimitNumber(value.summaryIpPerMinute, DEFAULT_WIDGET_LIMITS.summaryIpPerMinute),
    notifyUserPerMinute: normalizeWidgetLimitNumber(value.notifyUserPerMinute, DEFAULT_WIDGET_LIMITS.notifyUserPerMinute, true),
    notifyIpPerMinute: normalizeWidgetLimitNumber(value.notifyIpPerMinute, DEFAULT_WIDGET_LIMITS.notifyIpPerMinute, true),
    blockSeconds: normalizeWidgetLimitNumber(value.blockSeconds, DEFAULT_WIDGET_LIMITS.blockSeconds),
    tokenTtlDays: normalizeWidgetLimitNumber(value.tokenTtlDays, DEFAULT_WIDGET_LIMITS.tokenTtlDays),
    freshThresholdMinutes: normalizeWidgetLimitNumber(value.freshThresholdMinutes, DEFAULT_WIDGET_LIMITS.freshThresholdMinutes),
    agingThresholdMinutes: normalizeWidgetLimitNumber(value.agingThresholdMinutes, DEFAULT_WIDGET_LIMITS.agingThresholdMinutes),
  };
}

async function readAppConfigValue(
  client: SupabaseAdminClient,
  key: string,
): Promise<unknown | null> {
  const { data, error } = await client
    .from('app_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.warn('[WidgetCommon] failed to read app_config', { key, message: error.message });
    return null;
  }

  return data?.value ?? null;
}

export type WidgetTelemetryEvent =
  | 'widget_register_success'
  | 'widget_register_failure'
  | 'widget_instance_install'
  | 'widget_instance_uninstall'
  | 'widget_summary_fetch_success'
  | 'widget_summary_fetch_failure'
  | 'widget_summary_schema_mismatch'
  | 'widget_stale_render'
  | 'widget_untrusted_render'
  | 'widget_killswitch_applied'
  | 'widget_account_switch_cleanup'
  | 'widget_sw_activate_refresh'
  | 'widget_push_dirty_sent'
  | 'widget_push_dirty_dropped';

export interface WidgetTelemetryDetail {
  platform?: WidgetPlatform | null;
  deviceId?: string | null;
  userId?: string | null;
  instanceId?: string | null;
  bindingGeneration?: number | null;
  action?: string | null;
  code?: string | null;
  reason?: string | null;
  status?: number | null;
  trustState?: string | null;
  freshnessState?: string | null;
  sourceState?: string | null;
  degradedReasons?: string[] | null;
  webhookId?: string | null;
  eligibleDeviceCount?: number | null;
  schemaVersion?: number | null;
  summaryVersion?: string | null;
  extra?: Record<string, string | number | boolean | null> | null;
}

/**
 * 统一结构化遥测事件输出。所有 Widget OBS-* 事件通过此入口发出，
 * 字段保持稳定，敏感标识符统一经 `redactId()` 脱敏。
 * 日志可通过 `supabase functions logs` 或 ingest pipeline 消费。
 */
export function logWidgetEvent(event: WidgetTelemetryEvent, detail: WidgetTelemetryDetail = {}): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    surface: 'edge',
  };
  if (detail.platform !== undefined) payload.platform = detail.platform;
  if (detail.deviceId !== undefined) payload.deviceId = detail.deviceId ? redactId(detail.deviceId) : detail.deviceId;
  if (detail.userId !== undefined) payload.userId = detail.userId ? redactId(detail.userId) : detail.userId;
  if (detail.instanceId !== undefined) payload.instanceId = detail.instanceId ? redactId(detail.instanceId) : detail.instanceId;
  if (detail.bindingGeneration !== undefined) payload.bindingGeneration = detail.bindingGeneration;
  if (detail.action !== undefined) payload.action = detail.action;
  if (detail.code !== undefined) payload.code = detail.code;
  if (detail.reason !== undefined) payload.reason = detail.reason;
  if (detail.status !== undefined) payload.status = detail.status;
  if (detail.trustState !== undefined) payload.trustState = detail.trustState;
  if (detail.freshnessState !== undefined) payload.freshnessState = detail.freshnessState;
  if (detail.sourceState !== undefined) payload.sourceState = detail.sourceState;
  if (detail.degradedReasons !== undefined) payload.degradedReasons = detail.degradedReasons;
  if (detail.webhookId !== undefined) payload.webhookId = detail.webhookId ? redactId(detail.webhookId) : detail.webhookId;
  if (detail.eligibleDeviceCount !== undefined) payload.eligibleDeviceCount = detail.eligibleDeviceCount;
  if (detail.schemaVersion !== undefined) payload.schemaVersion = detail.schemaVersion;
  if (detail.summaryVersion !== undefined) payload.summaryVersion = detail.summaryVersion;
  if (detail.extra && typeof detail.extra === 'object') payload.extra = detail.extra;

  console.log(`[WidgetTelemetry] ${event} ${JSON.stringify(payload)}`);
}

export function createServiceRoleClient(): SupabaseAdminClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service role environment is not configured');
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

export function getCorsHeaders(
  origin: string | null,
  allowedMethods = 'GET, POST, OPTIONS',
): Record<string, string> {
  let isAllowed = false;
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      isAllowed = true;
    } else {
      try {
        const parsed = new URL(origin);
        // Vercel 预览
        if (parsed.hostname.startsWith(VERCEL_PREVIEW_PREFIX)
          && parsed.hostname.endsWith('.vercel.app')) {
          isAllowed = true;
        }
        // Cloudflare Pages PR preview：*.nanoflow.pages.dev
        if (!isAllowed && parsed.protocol === 'https:'
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
    'Access-Control-Allow-Methods': allowedMethods,
    'Vary': 'Origin',
  };
}

export function withPrivateNoStoreHeaders(
  corsHeaders: Record<string, string>,
): Record<string, string> {
  return {
    ...corsHeaders,
    ...PRIVATE_NO_STORE_HEADERS,
  };
}

export function jsonResponse(
  payload: unknown,
  corsHeaders: Record<string, string>,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1]?.trim();
  return token ? token : null;
}

export async function verifyJwtUser(req: Request): Promise<{ userId: string } | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const client = createServiceRoleClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }

  return { userId: data.user.id };
}

export function getClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp;

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;

  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

export async function sha256Hex(value: string): Promise<string> {
  const payload = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function redactId(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value.length <= 8 ? value : `${value.slice(0, 8)}...`;
}

export function normalizeWidgetPlatform(value: unknown): WidgetPlatform | null {
  return value === 'android-widget'
    ? value
    : null;
}

export function isUuidLike(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createOpaqueWidgetTokenSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildWidgetToken(_payload: WidgetTokenPayload): string {
  return base64UrlEncode(createOpaqueWidgetTokenSeed());
}

export function parseWidgetToken(token: string | null): WidgetTokenPayload | null {
  if (!token) return null;

  // Legacy parser: newer bindings use server-stored opaque tokens hashed in widget_devices.token_hash.
  try {
    const decoded = base64UrlDecode(token);
    const parsed = JSON.parse(decoded) as unknown;
    if (isPlainObject(parsed)) {
      const deviceId = parsed.deviceId;
      const bindingGeneration = parsed.bindingGeneration;
      const secret = parsed.secret;

      if (isUuidLike(deviceId)
        && typeof bindingGeneration === 'number'
        && Number.isFinite(bindingGeneration)
        && bindingGeneration >= 1
        && typeof secret === 'string'
        && secret.length >= 16) {
        return {
          deviceId,
          bindingGeneration: Math.trunc(bindingGeneration),
          secret,
        };
      }
    }
  } catch {
    // fall through to legacy token parsing
  }

  try {
    const decoded = base64UrlDecode(token);
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;

    const [deviceId, bindingGenerationText, secret] = parts;
    if (!isUuidLike(deviceId)) return null;
    if (!/^\d+$/.test(bindingGenerationText)) return null;
    if (!secret || secret.length < 16) return null;

    const bindingGeneration = Number(bindingGenerationText);
    if (!Number.isFinite(bindingGeneration) || bindingGeneration < 1) return null;

    return {
      deviceId,
      bindingGeneration,
      secret,
    };
  } catch {
    return null;
  }
}

export async function loadWidgetCapabilities(
  client: SupabaseAdminClient,
): Promise<WidgetCapabilityConfig> {
  const value = await readAppConfigValue(client, 'widget_capabilities');
  return normalizeCapabilities(value);
}

export async function loadWidgetLimits(
  client: SupabaseAdminClient,
): Promise<WidgetLimits> {
  const value = await readAppConfigValue(client, 'widget_limits');
  return normalizeLimits(value);
}

export async function consumeWidgetRateLimit(
  client: SupabaseAdminClient,
  scopeType: WidgetRateLimitScope,
  scopeKey: string,
  maxCalls: number,
  blockSeconds: number,
  windowSeconds = 60,
): Promise<WidgetRateLimitResult> {
  const { data, error } = await client.rpc('consume_widget_rate_limit', {
    p_scope_type: scopeType,
    p_scope_key: scopeKey,
    p_max_calls: maxCalls,
    p_window_seconds: windowSeconds,
    p_block_seconds: blockSeconds,
  });

  if (error) {
    throw new Error(`consume_widget_rate_limit failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
    remainingCalls: Number(row?.remaining_calls ?? 0),
  };
}

export function mergeJsonObjects(
  base: Json | null | undefined,
  override: Json | null | undefined,
): Json {
  if (!isPlainObject(base) && !isPlainObject(override)) {
    return {};
  }

  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(override) ? override : {}),
  };
}
