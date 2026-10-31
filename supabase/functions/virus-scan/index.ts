// ============================================
// Supabase Edge Function: 病毒扫描服务
// 提供文件病毒扫描功能
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.93.2';

// ==================== 配置 ====================

const CLAMAV_API_URL = Deno.env.get('CLAMAV_API_URL') || 'http://clamav:3310';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VIRUS_RESCAN_CRON_SECRET = Deno.env.get('VIRUS_RESCAN_CRON_SECRET') ?? '';
/** 附件存储桶，与前端 ATTACHMENT_CONFIG.BUCKET_NAME 及 cleanup-attachments 保持一致 */
const ATTACHMENTS_BUCKET = 'attachments';
const SERVICE_ROLE_CLIENT_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
} as const;

// 扫描状态常量
const SCAN_STATUS = {
  PENDING: 'pending',
  SCANNING: 'scanning',
  CLEAN: 'clean',
  THREAT_DETECTED: 'threat_detected',
  FAILED: 'failed',
  QUARANTINED: 'quarantined',
  SKIPPED: 'skipped',
} as const;

// ==================== 类型定义 ====================

interface ScanRequest {
  action: 'scan' | 'status' | 'health' | 'verify-hash' | 'rescan' | 'rescan-due';
  file?: string; // base64 编码的文件
  filename?: string;
  hash?: string;
  mimeType?: string;
  fileId?: string;
  expectedHash?: string;
  limit?: number;
}

interface ScanResult {
  fileId: string;
  fileHash?: string;
  status: string;
  threatName?: string;
  threatDescription?: string;
  scannedAt: string;
  scanner: string;
  engineVersion?: string;
  signatureVersion?: string;
}

interface SupabaseQueryResult<TData = unknown> {
  data: TData | null;
  error: { message: string } | null;
}

interface SupabaseQueryBuilder<TData = unknown> extends PromiseLike<SupabaseQueryResult<TData>> {
  abortSignal(signal: AbortSignal): SupabaseQueryBuilder<TData>;
  select(columns?: string): SupabaseQueryBuilder<TData>;
  eq(column: string, value: unknown): SupabaseQueryBuilder<TData>;
  in(column: string, values: readonly unknown[]): SupabaseQueryBuilder<TData>;
  lte(column: string, value: unknown): SupabaseQueryBuilder<TData>;
  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilder<TData>;
  contains(column: string, value: string): SupabaseQueryBuilder<TData>;
  limit(count: number): SupabaseQueryBuilder<TData>;
  single<TRow = TData>(): Promise<SupabaseQueryResult<TRow>>;
  maybeSingle<TRow = TData>(): Promise<SupabaseQueryResult<TRow>>;
  update(values: Record<string, unknown>): SupabaseQueryBuilder<TData>;
  upsert(
    values: Record<string, unknown>,
    options?: { onConflict?: string },
  ): Promise<SupabaseQueryResult<TData>>;
}

interface AttachmentScanStatusRow {
  file_id: string;
  status: string;
  threat_name?: string | null;
  threat_description?: string | null;
  scanned_at?: string | null;
  scanner?: string | null;
  engine_version?: string | null;
  signature_version?: string | null;
}

interface AttachmentScanHashRow {
  file_hash?: string | null;
}

interface AttachmentScanFileIdRow {
  file_id: string;
}

interface AttachmentScanRescanClaimRow {
  claimed: boolean;
  token: string | null;
  reason: string;
  current_status: string | null;
  retry_after_seconds: number | null;
}

interface AttachmentScanDueRow {
  file_id: string;
  user_id: string;
  token: string;
}

interface StorageObjectVersionRow {
  name: string;
  id: string | null;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface RescanTaskRow {
  id: string;
  project_id: string;
  attachments: unknown;
}

interface RescanTaskAttachment {
  id: string;
  name: string;
  scanMetadata?: { fileId?: string };
}

interface RescanStorageTarget {
  storagePath: string;
  filename: string;
}

// ==================== CORS 处理 ====================

/**
 * 允许的来源白名单
 * 安全修复：限制 CORS 来源，防止任意网站调用 API
 * SEC-M6: 生产环境通过环境变量配置，避免 localhost 残留
 */
const ALLOWED_ORIGINS: string[] = (() => {
  const envOrigins = Deno.env.get('ALLOWED_ORIGINS');
  if (envOrigins) return envOrigins.split(',').map(o => o.trim()).filter(Boolean);
  return [
    'https://dde-eight.vercel.app',
    'https://nanoflow.app',
    'https://nanoflow.pages.dev',  // Cloudflare canonical writable origin
    'http://localhost:4200',      // 开发环境
    'http://localhost:5173',      // Vite 开发服务器
  ];
})();

/** 文件大小限制：10MB base64 编码后约 13.7MB */
const MAX_FILE_BASE64_LENGTH = 10 * 1024 * 1024 * 1.37;
const MAX_JSON_BODY_LENGTH = MAX_FILE_BASE64_LENGTH + 16 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESCAN_TOTAL_TIMEOUT_MS = 45_000;
const RESCAN_MIN_INTERVAL_SECONDS = 60;
const RESCAN_STALE_AFTER_SECONDS = 15 * 60;
const RESCAN_SUCCESS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RESCAN_FAILURE_RETRY_MS = 60 * 60 * 1000;
const RESCAN_DUE_MAX_BATCH = 6;
const RESCAN_DUE_CONCURRENCY = 3;

function nextRescanAtForStatus(status: string): string | null {
  if (status === SCAN_STATUS.FAILED) {
    return new Date(Date.now() + RESCAN_FAILURE_RETRY_MS).toISOString();
  }
  if (status === SCAN_STATUS.CLEAN) {
    return new Date(Date.now() + RESCAN_SUCCESS_INTERVAL_MS).toISOString();
  }
  return null;
}

/**
 * 根据请求来源返回 CORS 头
 * 只有白名单中的来源才会被允许
 */
/** Vercel 预览域名项目级前缀（受控模式） */
const VERCEL_PREVIEW_PREFIX = 'dde-';
const ALLOW_PREVIEW_ORIGINS = Deno.env.get('ALLOW_PREVIEW_ORIGINS') === 'true';

function getCorsHeaders(origin: string | null): Record<string, string> {
  let isAllowed = false;
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      isAllowed = true;
    } else {
      // SEC-M5: 用 URL 解析锚定 hostname，防止 evil-dde-xxx.vercel.app 绕过
      try {
        const url = new URL(origin);
        // Vercel 预览
        if (ALLOW_PREVIEW_ORIGINS && url.protocol === 'https:'
          && url.hostname.startsWith(VERCEL_PREVIEW_PREFIX) && url.hostname.endsWith('.vercel.app')) {
          isAllowed = true;
        }
        // Cloudflare Pages PR preview：*.nanoflow.pages.dev
        if (!isAllowed && ALLOW_PREVIEW_ORIGINS && url.protocol === 'https:' && url.hostname.endsWith('.nanoflow.pages.dev')) {
          isAllowed = true;
        }
      } catch { /* 非法 origin 忽略 */ }
    }
  }
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-virus-rescan-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

/**
 * 验证用户认证
 * 返回用户 ID 或 null（如果未认证）
 */
async function verifyAuth(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return null;
  }

  const supabase = createServiceRoleClient();
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return null;
  }
  
  return { userId: user.id };
}

interface ServiceRoleClient {
  auth: ReturnType<typeof createClient>['auth'];
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): SupabaseQueryBuilder<unknown>;
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
      list(
        path?: string,
        options?: { limit?: number; search?: string },
        parameters?: { signal?: AbortSignal },
      ): Promise<{ data: StorageObjectVersionRow[] | null; error: { message: string } | null }>;
    };
  };
}

function createDeadlineFetch(signal: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, {
    ...init,
    signal,
  });
}

function createServiceRoleClient(signal?: AbortSignal): ServiceRoleClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service configuration is not configured');
  }

  const options = signal
    ? {
      ...SERVICE_ROLE_CLIENT_OPTIONS,
      global: { fetch: createDeadlineFetch(signal) },
    }
    : SERVICE_ROLE_CLIENT_OPTIONS;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, options) as unknown as ServiceRoleClient;
}

class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

async function withTimeout(
  operation: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  message: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError(message);
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);

  try {
    const response = await operation(controller.signal);
    if (timedOut) throw timeoutError;
    return response;
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRequestBodyTooLarge(req: Request): boolean {
  const contentLength = req.headers.get('content-length');
  if (!contentLength) return false;
  const bytes = Number.parseInt(contentLength, 10);
  return Number.isFinite(bytes) && bytes > MAX_JSON_BODY_LENGTH;
}

function hasValidRescanCronSecret(req: Request): boolean {
  const providedSecret = req.headers.get('x-virus-rescan-secret') ?? '';
  if (!VIRUS_RESCAN_CRON_SECRET || providedSecret.length !== VIRUS_RESCAN_CRON_SECRET.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < providedSecret.length; index += 1) {
    mismatch |= providedSecret.charCodeAt(index) ^ VIRUS_RESCAN_CRON_SECRET.charCodeAt(index);
  }
  return mismatch === 0;
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

async function readRequestTextWithLimit(req: Request, maxBytes = MAX_JSON_BODY_LENGTH): Promise<string> {
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

async function readJsonWithLimit<T>(req: Request): Promise<T> {
  return JSON.parse(await readRequestTextWithLimit(req)) as T;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

// ==================== 主函数 ====================

serve(async (req: Request) => {
  // SEC-H1 fix: 使用局部变量避免并发请求间 CORS 头竞态
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, corsHeaders, 405);
  }

  if (isRequestBodyTooLarge(req)) {
    return jsonResponse({ error: 'File too large (max 10MB)' }, corsHeaders, 413);
  }

  try {
    const body = await readJsonWithLimit<ScanRequest>(req);
    const { action } = body;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({
        error: 'Supabase service configuration is not configured',
        code: 'SERVICE_NOT_CONFIGURED',
      }, corsHeaders, 503);
    }

    if (action === 'rescan-due') {
      if (!hasValidRescanCronSecret(req)) {
        return jsonResponse({ error: 'Unauthorized', code: 'INTERNAL_AUTH_REQUIRED' }, corsHeaders, 401);
      }
      return handleDueRescan(body, corsHeaders);
    }

    // 用户操作需要认证，避免匿名探测内部 ClamAV 状态
    const auth = await verifyAuth(req);
    if (!auth) {
      console.warn('🛡️ [VirusScan] Unauthorized request for action:', action);
      return jsonResponse({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, corsHeaders, 401);
    }

    switch (action) {
      case 'health':
        return handleHealthCheck(corsHeaders);

      case 'scan':
        return handleScan(body, auth.userId, corsHeaders);
      
      case 'status':
        return handleStatusCheck(body, auth.userId, corsHeaders);
      
      case 'verify-hash':
        return handleHashVerification(body, auth.userId, corsHeaders);
      
      case 'rescan':
        return handleRescan(body, auth.userId, corsHeaders);
      
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, corsHeaders, 400);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: 'File too large (max 10MB)' }, corsHeaders, 413);
    }

    console.error('Error processing request:', error);
    return jsonResponse({ error: 'Internal server error' }, corsHeaders, 500);
  }
});

// ==================== 处理函数 ====================

/**
 * 健康检查
 */
async function handleHealthCheck(corsHeaders: Record<string, string>): Promise<Response> {
  try {
    // 检查 ClamAV 是否可用
    const clamAvHealth = await checkClamAvHealth();
    
    return jsonResponse({
      status: clamAvHealth ? 'healthy' : 'degraded',
      clamav: clamAvHealth,
      timestamp: new Date().toISOString(),
    }, corsHeaders);
  } catch (error) {
    return jsonResponse({
      status: 'unhealthy',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    }, corsHeaders, 503);
  }
}

/**
 * 执行文件扫描
 */
async function handleScan(body: ScanRequest, userId: string, corsHeaders: Record<string, string>): Promise<Response> {
  const { file, filename, mimeType } = body;
  
  if (!file || !filename) {
    return jsonResponse({ error: 'Missing required fields: file, filename' }, corsHeaders, 400);
  }

  // SEC-M2: 文件大小限制，防止 DoS
  if (file.length > MAX_FILE_BASE64_LENGTH) {
    return jsonResponse({ error: 'File too large (max 10MB)' }, corsHeaders, 413);
  }

  const fileId = crypto.randomUUID();
  
  try {
    // 解码 base64 文件
    const fileBytes = Uint8Array.from(atob(file), c => c.charCodeAt(0));
    const fileHash = await sha256HexBytes(fileBytes);
    
    // 调用 ClamAV 扫描
    const scanResult = await scanWithClamAv(fileBytes, filename);
    
    // 记录扫描结果
    await saveScanResult(fileId, userId, fileHash, scanResult);
    
    // SEC-C1 fix: ClamAV 失败时返回 FAILED 状态，不假装为 CLEAN
    const effectiveStatus = scanResult.status === SCAN_STATUS.FAILED
      ? SCAN_STATUS.FAILED
      : (scanResult.infected ? SCAN_STATUS.THREAT_DETECTED : SCAN_STATUS.CLEAN);

    const result: ScanResult = {
      fileId,
      fileHash,
      status: effectiveStatus,
      threatName: scanResult.virusName,
      threatDescription: scanResult.description,
      scannedAt: new Date().toISOString(),
      scanner: 'clamav',
      engineVersion: scanResult.engineVersion,
      signatureVersion: scanResult.signatureVersion,
    };

    return jsonResponse(result, corsHeaders);
  } catch (error) {
    console.error('Scan error:', error);

    try {
      await saveScanResult(fileId, userId, '', {
        infected: false,
        status: SCAN_STATUS.FAILED,
        error: String(error),
      });
    } catch (saveError) {
      console.error('Failed to persist failed scan result:', saveError);
    }
    
    return jsonResponse({
      fileId,
      status: SCAN_STATUS.FAILED,
      error: 'File scan could not be completed',
      scannedAt: new Date().toISOString(),
      scanner: 'clamav',
    }, corsHeaders);
  }
}

/**
 * 检查扫描状态
 */
async function handleStatusCheck(body: ScanRequest, userId: string, corsHeaders: Record<string, string>): Promise<Response> {
  const { fileId } = body;
  
  if (!fileId) {
    return jsonResponse({ error: 'Missing required field: fileId' }, corsHeaders, 400);
  }

  try {
    const supabase = createServiceRoleClient();
    
    // SEC-C2 fix: 添加 user_id 过滤，防止 IDOR 越权访问
    const { data, error } = await supabase
      .from('attachment_scans')
      .select('file_id,status,threat_name,threat_description,scanned_at,scanner,engine_version,signature_version')
      .eq('file_id', fileId)
      .eq('user_id', userId)
      .single<AttachmentScanStatusRow>();

    if (error || !data) {
      return jsonResponse({ error: 'Scan record not found' }, corsHeaders, 404);
    }

    return jsonResponse({
      fileId: data.file_id,
      status: data.status,
      threatName: data.threat_name,
      threatDescription: data.threat_description,
      scannedAt: data.scanned_at,
      scanner: data.scanner,
      engineVersion: data.engine_version,
      signatureVersion: data.signature_version,
    }, corsHeaders);
  } catch (error) {
    console.error('Status check error:', error);
    return jsonResponse({ error: 'Failed to check status' }, corsHeaders, 500);
  }
}

/**
 * 验证文件哈希
 */
async function handleHashVerification(body: ScanRequest, userId: string, corsHeaders: Record<string, string>): Promise<Response> {
  const { fileId, expectedHash } = body;
  
  if (!fileId || !expectedHash) {
    return jsonResponse({ error: 'Missing required fields: fileId, expectedHash' }, corsHeaders, 400);
  }

  try {
    const supabase = createServiceRoleClient();
    
    // SEC-C2 fix: 添加 user_id 过滤
    const { data, error } = await supabase
      .from('attachment_scans')
      .select('file_hash')
      .eq('file_id', fileId)
      .eq('user_id', userId)
      .single<AttachmentScanHashRow>();

    if (error || !data) {
      return jsonResponse({ valid: false, error: 'File not found' }, corsHeaders);
    }

    if (data.file_hash !== expectedHash) {
      console.warn('Hash mismatch detected:', { fileId, hashMatch: false });
      return jsonResponse({ valid: false }, corsHeaders);
    }

    const target = await locateRescanStorageTarget(supabase, fileId, userId);
    if (!target) {
      return jsonResponse({ valid: false, error: 'File not found in storage' }, corsHeaders);
    }
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(ATTACHMENTS_BUCKET)
      .download(target.storagePath);
    if (downloadError || !fileData) {
      return jsonResponse({ valid: false, error: 'Failed to verify current storage object' }, corsHeaders);
    }

    const currentHash = await sha256HexBytes(new Uint8Array(await fileData.arrayBuffer()));
    const valid = currentHash === data.file_hash;
    
    if (!valid) {
      // 记录可能的篡改尝试（脱敏处理）
      console.warn('Hash mismatch detected:', { fileId, hashMatch: false });
    }

    return jsonResponse({ valid }, corsHeaders);
  } catch (error) {
    console.error('Hash verification error:', error);
    return jsonResponse({ valid: false, error: 'Verification failed' }, corsHeaders);
  }
}

/**
 * 触发重新扫描
 */
async function handleRescan(body: ScanRequest, userId: string, corsHeaders: Record<string, string>): Promise<Response> {
  const { fileId } = body;
  
  if (!fileId) {
    return jsonResponse({ error: 'Missing required field: fileId' }, corsHeaders, 400);
  }

  try {
    const supabase = createServiceRoleClient();
    const claim = await claimAttachmentScanRescan(supabase, fileId, userId);
    if (!claim.claimed || !claim.token) {
      return rescanClaimFailureResponse(claim, corsHeaders);
    }
    return executeClaimedRescan(supabase, fileId, userId, claim.token, corsHeaders);
  } catch (error) {
    console.error('Rescan error:', error);
    return jsonResponse({ error: 'Failed to claim rescan' }, corsHeaders, 500);
  }
}

async function executeClaimedRescan(
  supabase: ServiceRoleClient,
  fileId: string,
  userId: string,
  rescanToken: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    return await withTimeout(
      signal => rescanStoredFile(
        createServiceRoleClient(signal),
        fileId,
        userId,
        rescanToken,
        corsHeaders,
        signal,
      ),
      RESCAN_TOTAL_TIMEOUT_MS,
      'Rescan deadline exceeded',
    );
  } catch (error) {
    console.error('Claimed rescan error:', error);
    try {
      await markRescanFailed(
        supabase,
        fileId,
        userId,
        rescanToken,
        `Rescan failed: ${String(error)}`,
      );
    } catch (markError) {
      console.error('Failed to persist rescan failure state:', markError);
    }
    return jsonResponse(
      { error: error instanceof OperationTimeoutError ? 'Rescan timed out' : 'Failed to rescan file' },
      corsHeaders,
      error instanceof OperationTimeoutError ? 504 : 500,
    );
  }
}

async function claimAttachmentScanRescan(
  supabase: ServiceRoleClient,
  fileId: string,
  userId: string,
): Promise<AttachmentScanRescanClaimRow> {
  const { data, error } = await supabase.rpc('claim_attachment_scan_rescan', {
    p_file_id: fileId,
    p_user_id: userId,
    p_min_interval_seconds: RESCAN_MIN_INTERVAL_SECONDS,
    p_stale_after_seconds: RESCAN_STALE_AFTER_SECONDS,
  });
  if (error) {
    throw new Error(`Rescan claim failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new Error('Rescan claim returned no result');
  }
  return row as AttachmentScanRescanClaimRow;
}

function rescanClaimFailureResponse(
  claim: AttachmentScanRescanClaimRow,
  corsHeaders: Record<string, string>,
): Response {
  const retryAfterSeconds = Math.max(0, Number(claim.retry_after_seconds ?? 0));
  if (claim.reason === 'not_found') {
    return jsonResponse({ error: 'Scan record not found' }, corsHeaders, 404);
  }
  if (claim.reason === 'rate_limited') {
    return jsonResponse({ error: 'Rescan rate limited', retryAfterSeconds }, corsHeaders, 429);
  }
  return jsonResponse({ error: 'Rescan already in progress', retryAfterSeconds }, corsHeaders, 409);
}

/**
 * 对 Storage 中的既有文件执行真实重扫
 * 复用与上传扫描一致的 ClamAV 实现、状态映射与失败响应结构
 */
async function rescanStoredFile(
  supabase: ServiceRoleClient,
  fileId: string,
  userId: string,
  rescanToken: string,
  corsHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const target = await locateRescanStorageTarget(supabase, fileId, userId, signal);
  signal.throwIfAborted();
  if (!target) {
    await markRescanFailed(
      supabase,
      fileId,
      userId,
      rescanToken,
      'Attachment referencing this scan record was not found',
      null,
      signal,
    );
    return jsonResponse({ error: 'File not found in storage' }, corsHeaders, 404);
  }

  const objectVersionBefore = await readStorageObjectVersion(supabase, target.storagePath, signal);
  signal.throwIfAborted();
  if (!objectVersionBefore) {
    await markRescanFailed(
      supabase,
      fileId,
      userId,
      rescanToken,
      'Storage object metadata was not found',
      null,
      signal,
    );
    return jsonResponse({ error: 'File not found in storage' }, corsHeaders, 404);
  }
  if (readStorageObjectSize(objectVersionBefore) > MAX_FILE_BYTES) {
    await markRescanFailed(
      supabase,
      fileId,
      userId,
      rescanToken,
      'Stored object exceeds the 10MB scan limit',
      null,
      signal,
    );
    return jsonResponse({ error: 'Stored file too large (max 10MB)' }, corsHeaders, 413);
  }

  const { data: fileData, error: downloadError } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .download(target.storagePath);
  signal.throwIfAborted();

  if (downloadError || !fileData) {
    const downloadMessage = downloadError?.message || 'Empty storage object body';
    const objectMissing = /not[_ -]?found/i.test(downloadMessage);
    await markRescanFailed(
      supabase,
      fileId,
      userId,
      rescanToken,
      `Storage download failed: ${downloadMessage}`,
      objectMissing ? null : RESCAN_FAILURE_RETRY_MS,
      signal,
    );
    return jsonResponse(
      { error: objectMissing ? 'File not found in storage' : 'Failed to download file for rescan' },
      corsHeaders,
      objectMissing ? 404 : 502,
    );
  }

  if (fileData.size > MAX_FILE_BYTES) {
    await markRescanFailed(
      supabase,
      fileId,
      userId,
      rescanToken,
      'Downloaded object exceeds the 10MB scan limit',
      null,
      signal,
    );
    return jsonResponse({ error: 'Stored file too large (max 10MB)' }, corsHeaders, 413);
  }

  const fileBytes = new Uint8Array(await fileData.arrayBuffer());
  signal.throwIfAborted();
  const fileHash = await sha256HexBytes(fileBytes);
  signal.throwIfAborted();

  // 与首次扫描共用同一 ClamAV 扫描实现
  const scanResult = await scanWithClamAv(fileBytes, target.filename, signal);
  signal.throwIfAborted();

  const objectVersionAfter = await readStorageObjectVersion(supabase, target.storagePath, signal);
  signal.throwIfAborted();
  if (!objectVersionAfter || !isSameStorageObjectVersion(objectVersionBefore, objectVersionAfter)) {
    await markRescanFailed(
      supabase,
      fileId,
      userId,
      rescanToken,
      'Storage object changed during rescan',
      RESCAN_FAILURE_RETRY_MS,
      signal,
    );
    return jsonResponse({ error: 'Storage object changed during rescan' }, corsHeaders, 409);
  }

  // SEC-C1 语义与 handleScan 保持一致：ClamAV 失败返回 FAILED，不假装 CLEAN
  const effectiveStatus = scanResult.status === SCAN_STATUS.FAILED
    ? SCAN_STATUS.FAILED
    : (scanResult.infected ? SCAN_STATUS.THREAT_DETECTED : SCAN_STATUS.CLEAN);

  const scannedAt = new Date().toISOString();

  // 重扫必须更新既有扫描记录（不能像首扫那样 upsert 插入新行，否则 status 查询的 single() 会失效）
  const nextRescanAt = nextRescanAtForStatus(effectiveStatus);
  signal.throwIfAborted();
  const { data: updatedScan, error: resultUpdateError } = await supabase
    .from('attachment_scans')
    .update({
      file_hash: fileHash,
      status: effectiveStatus,
      threat_name: scanResult.virusName ?? null,
      threat_description: scanResult.description ?? null,
      scanner: 'clamav',
      engine_version: scanResult.engineVersion ?? null,
      signature_version: scanResult.signatureVersion ?? null,
      scanned_at: scannedAt,
      error_message: scanResult.error ?? null,
      rescan_token: null,
      rescan_started_at: null,
      next_rescan_at: nextRescanAt,
    })
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .eq('rescan_token', rescanToken)
    .eq('status', SCAN_STATUS.SCANNING)
    .select('file_id')
    .abortSignal(signal)
    .maybeSingle<AttachmentScanFileIdRow>();
  signal.throwIfAborted();

  if (resultUpdateError) {
    console.error('Rescan result update error:', resultUpdateError.message);
    return jsonResponse({ error: 'Failed to save rescan result' }, corsHeaders, 500);
  }
  if (!updatedScan) {
    return jsonResponse({ error: 'Rescan result superseded' }, corsHeaders, 409);
  }

  if (effectiveStatus === SCAN_STATUS.FAILED) {
    // 与 handleScan 扫描失败响应同构，不静默成功
    return jsonResponse({
      fileId,
      status: SCAN_STATUS.FAILED,
      error: 'File rescan could not be completed',
      scannedAt,
      scanner: 'clamav',
    }, corsHeaders);
  }

  return jsonResponse({
    fileId,
    status: effectiveStatus,
    message: 'Rescan completed',
  }, corsHeaders);
}

// ==================== 辅助函数 ====================

/**
 * 检查 ClamAV 健康状态
 */
async function checkClamAvHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${CLAMAV_API_URL}/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface ClamAvScanResult {
  infected: boolean;
  virusName?: string;
  description?: string;
  status?: string;
  error?: string;
  engineVersion?: string;
  signatureVersion?: string;
}

function readObjectField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readStringField(value: unknown, key: string): string | undefined {
  const field = readObjectField(value, key);
  return typeof field === 'string' ? field : undefined;
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  const field = readObjectField(value, key);
  return typeof field === 'boolean' ? field : undefined;
}

/**
 * 使用 ClamAV 扫描文件
 */
async function scanWithClamAv(
  fileBytes: Uint8Array,
  filename: string,
  signal?: AbortSignal,
): Promise<ClamAvScanResult> {
  try {
    // 构建 multipart 请求
    const formData = new FormData();
    // 使用 ArrayBuffer 确保类型兼容
    const fileBuffer = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength) as ArrayBuffer;
    const blob = new Blob([new Uint8Array(fileBuffer)]);
    formData.append('file', blob, filename);

    const response = await fetch(`${CLAMAV_API_URL}/scan`, {
      method: 'POST',
      body: formData,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    signal?.throwIfAborted();

    if (!response.ok) {
      throw new Error(`ClamAV returned status ${response.status}`);
    }

    const result: unknown = await response.json();
    signal?.throwIfAborted();
    const scannerError = readStringField(result, 'error');
    if (scannerError) {
      throw new Error(`ClamAV scanner error: ${scannerError}`);
    }
    const infected = readBooleanField(result, 'infected');
    if (infected === undefined) {
      throw new Error('ClamAV response schema invalid: infected must be boolean');
    }

    return {
      infected,
      virusName: readStringField(result, 'virus_name'),
      description: readStringField(result, 'description'),
      engineVersion: readStringField(result, 'engine_version'),
      signatureVersion: readStringField(result, 'signature_version'),
    };
  } catch (error) {
    signal?.throwIfAborted();
    console.error('ClamAV scan error:', error);
    
    // ClamAV 不可用时，使用降级策略
    // 对于已知安全的文件类型，可以允许通过
    // 对于可执行文件等高风险类型，应该拒绝
    return {
      infected: false,
      status: SCAN_STATUS.FAILED,
      error: `ClamAV scan failed: ${error}`,
    };
  }
}

function isUuidLike(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** 与 cleanup-attachments/前端 sanitizeAttachmentPathSegment 相同的扩展名消毒语义 */
function sanitizeStoragePathSegment(segment: string): string {
  return segment
    .replace(/\.\.+/g, '')
    .replace(/[\/\\]/g, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .trim();
}

function findAttachmentByScanFileId(attachments: unknown, fileId: string): RescanTaskAttachment | null {
  if (!Array.isArray(attachments)) return null;

  for (const raw of attachments) {
    const scanMetadata = readObjectField(raw, 'scanMetadata');
    if (readStringField(scanMetadata, 'fileId') !== fileId) continue;

    const id = readStringField(raw, 'id');
    const name = readStringField(raw, 'name');
    if (!id || !name) continue;

    return { id, name };
  }

  return null;
}

/**
 * 通过 tasks.attachments JSONB 中的 scanMetadata.fileId 反查附件的 Storage 位置
 * 存储路径与上传侧 buildAttachmentStoragePath 一致：userId/projectId/taskId/attachmentId.ext
 * Storage RLS 将第一段锚定为上传者 auth.uid()，而扫描记录的 user_id 即上传时的认证用户
 */
async function locateRescanStorageTarget(
  supabase: ServiceRoleClient,
  fileId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<RescanStorageTarget | null> {
  let targetQuery = supabase
    .from('tasks')
    .select('id,project_id,attachments,projects!inner(owner_id)')
    .eq('projects.owner_id', userId)
    .contains('attachments', JSON.stringify([{ scanMetadata: { fileId } }]))
    .limit(2);
  if (signal) {
    targetQuery = targetQuery.abortSignal(signal);
  }
  const { data, error } = await targetQuery as SupabaseQueryResult<RescanTaskRow[]>;
  signal?.throwIfAborted();

  if (error) {
    throw new Error(`Rescan storage lookup failed: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1) {
    if (rows.length > 1) {
      console.error('Rescan storage lookup is ambiguous', { fileId, userId, matchCount: rows.length });
    }
    return null;
  }
  const [taskRow] = rows;
  if (!isUuidLike(taskRow.id) || !isUuidLike(taskRow.project_id)) return null;

  const attachment = findAttachmentByScanFileId(taskRow.attachments, fileId);
  if (!attachment || !isUuidLike(attachment.id)) {
    return null;
  }

  const fileExt = sanitizeStoragePathSegment(attachment.name.split('.').pop() || 'bin');
  if (!fileExt) {
    return null;
  }

  return {
    storagePath: `${userId}/${taskRow.project_id}/${taskRow.id}/${attachment.id}.${fileExt}`,
    filename: attachment.name,
  };
}

/**
 * 重扫失败时把扫描记录从 scanning 收敛到 failed（fail-closed，不静默成功）
 */
async function markRescanFailed(
  supabase: ServiceRoleClient,
  fileId: string,
  userId: string,
  rescanToken: string,
  errorMessage: string,
  retryDelayMs: number | null = RESCAN_FAILURE_RETRY_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  let failureUpdate = supabase
    .from('attachment_scans')
    .update({
      status: SCAN_STATUS.FAILED,
      scanned_at: new Date().toISOString(),
      error_message: errorMessage,
      rescan_token: null,
      rescan_started_at: null,
      next_rescan_at: retryDelayMs === null
        ? null
        : new Date(Date.now() + retryDelayMs).toISOString(),
    })
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .eq('rescan_token', rescanToken)
    .eq('status', SCAN_STATUS.SCANNING)
    .select('file_id');
  if (signal) {
    failureUpdate = failureUpdate.abortSignal(signal);
  }
  const { data: updatedScan, error: failureUpdateError } = await failureUpdate
    .maybeSingle<AttachmentScanFileIdRow>();
  signal?.throwIfAborted();

  if (failureUpdateError) {
    console.error('Rescan failure status update error:', failureUpdateError.message);
    return false;
  }
  return !!updatedScan;
}

async function readStorageObjectVersion(
  supabase: ServiceRoleClient,
  storagePath: string,
  signal: AbortSignal,
): Promise<StorageObjectVersionRow | null> {
  const separatorIndex = storagePath.lastIndexOf('/');
  const folder = separatorIndex >= 0 ? storagePath.slice(0, separatorIndex) : '';
  const objectName = separatorIndex >= 0 ? storagePath.slice(separatorIndex + 1) : storagePath;
  if (!objectName) return null;

  const { data, error } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .list(folder, { search: objectName, limit: 10 }, { signal });
  signal.throwIfAborted();
  if (error) {
    throw new Error(`Storage object metadata lookup failed: ${error.message}`);
  }

  const exactMatches = (data ?? []).filter(candidate => candidate.name === objectName);
  if (exactMatches.length > 1) {
    throw new Error('Storage object metadata lookup returned duplicate exact matches');
  }
  return exactMatches[0] ?? null;
}

function readStorageObjectSize(version: StorageObjectVersionRow): number {
  const size = version.metadata?.['size'] ?? version.metadata?.['contentLength'];
  return typeof size === 'number' && Number.isFinite(size) ? size : 0;
}

function isSameStorageObjectVersion(
  before: StorageObjectVersionRow,
  after: StorageObjectVersionRow,
): boolean {
  const metadataKeys = ['eTag', 'lastModified', 'size', 'contentLength'] as const;
  return before.id === after.id
    && before.updated_at === after.updated_at
    && metadataKeys.every(key => before.metadata?.[key] === after.metadata?.[key]);
}

async function handleDueRescan(
  body: ScanRequest,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const limit = Math.min(Math.max(Math.trunc(body.limit ?? RESCAN_DUE_MAX_BATCH), 1), RESCAN_DUE_MAX_BATCH);
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('claim_due_attachment_scan_rescans', {
    p_limit: limit,
    p_stale_after_seconds: RESCAN_STALE_AFTER_SECONDS,
  });
  if (error) {
    return jsonResponse({ error: 'Failed to claim due rescans' }, corsHeaders, 500);
  }

  if (!Array.isArray(data)) {
    console.error('Due rescan claim returned a non-array payload');
    return jsonResponse({ error: 'Invalid due rescan claim result' }, corsHeaders, 500);
  }

  const rawRows = data;
  const rows = rawRows.filter((row): row is AttachmentScanDueRow => (
    typeof row === 'object'
    && row !== null
    && isUuidLike(readStringField(row, 'file_id') ?? '')
    && isUuidLike(readStringField(row, 'user_id') ?? '')
    && isUuidLike(readStringField(row, 'token') ?? '')
  ));
  if (rows.length !== rawRows.length) {
    console.error('Due rescan claim returned malformed rows');
    return jsonResponse({ error: 'Invalid due rescan claim result' }, corsHeaders, 500);
  }

  let completed = 0;
  let deferred = 0;
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const rowIndex = nextIndex;
      nextIndex += 1;
      if (rowIndex >= rows.length) return;

      const row = rows[rowIndex];
      const response = await executeClaimedRescan(
        supabase,
        row.file_id,
        row.user_id,
        row.token,
        corsHeaders,
      );
      if (response.ok) completed += 1;
      else deferred += 1;
    }
  };

  const workerCount = Math.min(RESCAN_DUE_CONCURRENCY, rows.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  if (rows.length === 0) {
    return jsonResponse({ scanned: 0, deferred: 0, requested: 0 }, corsHeaders);
  }

  return jsonResponse({ scanned: completed, deferred, requested: rows.length }, corsHeaders);
}

/**
 * 保存扫描结果到数据库
 */
async function saveScanResult(
  fileId: string, 
  userId: string,
  fileHash: string, 
  result: ClamAvScanResult
): Promise<void> {
  const supabase = createServiceRoleClient();
  
  const status = result.infected 
    ? SCAN_STATUS.THREAT_DETECTED 
    : (result.status || SCAN_STATUS.CLEAN);

  const { error: saveError } = await supabase.from('attachment_scans').upsert(
    {
      file_id: fileId,
      user_id: userId,
      file_hash: fileHash,
      status,
      threat_name: result.virusName,
      threat_description: result.description,
      scanner: 'clamav',
      engine_version: result.engineVersion,
      signature_version: result.signatureVersion,
      scanned_at: new Date().toISOString(),
      error_message: result.error,
      rescan_token: null,
      rescan_started_at: null,
      next_rescan_at: nextRescanAtForStatus(status),
    },
    { onConflict: 'user_id,file_id' },
  );

  if (saveError) {
    throw new Error(`Failed to save scan result: ${saveError.message}`);
  }
}

/**
 * 返回 JSON 响应
 * SEC-H1 fix: corsHeaders 作为参数传入，避免全局可变状态竞态
 */
function jsonResponse(data: unknown, corsHeaders: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}
