// supabase/functions/transcribe/index.ts
// Supabase Edge Function: 语音转写代理
// 使用 Groq whisper-large-v3 模型进行语音转文字
// 
// 部署命令：
// supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here
// supabase functions deploy transcribe

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.93.2'
import { traceGroqTranscription } from '../_shared/langfuse.ts'

/**
 * 允许的来源白名单
 * 安全修复：限制 CORS 来源，防止任意网站调用 API
 * 迁移期：同时保留旧 Vercel 项目前缀域名（dde-*）与新 Cloudflare Pages 域名。
 */
const ALLOWED_ORIGINS = [
  'https://dde-eight.vercel.app',
  'https://nanoflow.app',
  'https://nanoflow.pages.dev',  // Cloudflare canonical writable origin（§16.10.1）
  'http://localhost:4200',      // 开发环境
  'http://localhost:5173',      // Vite 开发服务器
];

/** Vercel 预览域名项目级前缀（受控模式） */
const VERCEL_PREVIEW_PREFIX = 'dde-';
const ALLOW_PREVIEW_ORIGINS = Deno.env.get('ALLOW_PREVIEW_ORIGINS') === 'true';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const SERVICE_ROLE_CLIENT_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
} as const;

/**
 * Cloudflare Pages PR preview 子域 hostname 校验
 * 例如 pr-123.nanoflow.pages.dev / branch-foo.nanoflow.pages.dev
 * 仅接受任意单层子域 + .nanoflow.pages.dev，禁止 evil.nanoflow.pages.dev.attacker.com 等绕过。
 */
function isCloudflarePagesPreview(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    return url.hostname.endsWith('.nanoflow.pages.dev');
  } catch {
    return false;
  }
}

function isVercelPreview(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    return url.hostname.startsWith(VERCEL_PREVIEW_PREFIX) && url.hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

/**
 * 根据请求来源返回 CORS 头
 * 只有白名单中的来源、项目级前缀的 Vercel 预览域名或 *.nanoflow.pages.dev 才会被允许
 */
function getCorsHeaders(origin: string | null): Record<string, string> {
  let isAllowed = false;
  if (origin) {
    isAllowed = ALLOWED_ORIGINS.includes(origin) ||
      (ALLOW_PREVIEW_ORIGINS && (
        isVercelPreview(origin) || isCloudflarePagesPreview(origin)
      ));
  }
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin', // 重要：告知缓存根据 Origin 区分响应
  };
}

/** 每用户每日转写限额 - 与前端 FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA 保持一致 */
const DAILY_QUOTA_PER_USER = 50

/** Groq API 端点 */
const GROQ_API_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

/** 最大文件大小 25MB */
const MAX_FILE_SIZE = 25 * 1024 * 1024

/** multipart 元数据额外缓冲，超过则在解析 FormData 前拒绝 */
const MAX_REQUEST_BODY_SIZE = MAX_FILE_SIZE + 1024 * 1024

/** Groq API 调用超时（毫秒）- 必须短于 Supabase Edge Function 网关超时，确保函数能返回带 CORS 头的响应 */
const GROQ_TIMEOUT_MS = 25_000

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'video/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mpga',
  'audio/m4a',
  'audio/x-m4a',
  'audio/flac',
]);

const ALLOWED_AUDIO_EXTENSIONS = new Set([
  'webm',
  'mp4',
  'm4a',
  'ogg',
  'wav',
  'mp3',
  'mpeg',
  'mpga',
  'flac',
]);

const MIME_EXTENSION_COMPATIBILITY: Record<string, readonly string[]> = {
  'audio/webm': ['webm'],
  'audio/mp4': ['mp4', 'm4a'],
  'video/mp4': ['mp4', 'm4a'],
  'audio/ogg': ['ogg'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/mpeg': ['mp3', 'mpeg', 'mpga'],
  'audio/mp3': ['mp3'],
  'audio/mpga': ['mpga'],
  'audio/m4a': ['m4a'],
  'audio/x-m4a': ['m4a'],
  'audio/flac': ['flac'],
};

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function normalizeMimeType(type: string): string {
  return type.split(';')[0]?.trim().toLowerCase() ?? '';
}

function getFileExtension(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function isAllowedAudioFile(file: File): boolean {
  const extension = getFileExtension(file.name);
  if (!ALLOWED_AUDIO_EXTENSIONS.has(extension)) {
    return false;
  }

  const mimeType = normalizeMimeType(file.type);
  if (!mimeType || mimeType === 'application/octet-stream') {
    return true;
  }

  const compatibleExtensions = MIME_EXTENSION_COMPATIBILITY[mimeType];
  return ALLOWED_AUDIO_MIME_TYPES.has(mimeType)
    && (!compatibleExtensions || compatibleExtensions.includes(extension));
}

function toLogMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

function isRequestBodyTooLarge(req: Request): boolean {
  const contentLength = req.headers.get('content-length');
  if (!contentLength) return false;
  const bytes = Number.parseInt(contentLength, 10);
  return Number.isFinite(bytes) && bytes > MAX_REQUEST_BODY_SIZE;
}

async function readRequestBytesWithLimit(req: Request, maxBytes = MAX_REQUEST_BODY_SIZE): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();

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

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function readFormDataWithLimit(req: Request): Promise<FormData> {
  const body = await readRequestBytesWithLimit(req);
  const boundedRequest = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  return boundedRequest.formData();
}

interface QuotaReservation {
  allowed: boolean;
  usageCount: number;
  usageId: string | null;
}

interface QuotaReleaseClient {
  rpc(
    functionName: 'release_transcription_quota',
    args: { p_usage_id: string; p_user_id: string },
  ): Promise<{ error: { message?: string } | null }>;
}

function parseQuotaResult(value: unknown): QuotaReservation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const allowed = record['allowed'];
  const usageCount = record['usage_count'];
  const usageId = record['usage_id'];
  if (typeof allowed !== 'boolean') return null;
  return {
    allowed,
    usageCount: typeof usageCount === 'number' ? usageCount : 0,
    usageId: typeof usageId === 'string' && usageId.length > 0 ? usageId : null,
  };
}

serve(async (req: Request) => {
  // 获取请求来源，用于 CORS 响应
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  // 处理跨域预检
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (isRequestBodyTooLarge(req)) {
    return new Response(
      JSON.stringify({ error: '音频文件过大，请控制在 25MB 以内', code: 'FILE_TOO_LARGE' }),
      { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  let quotaReleaseClient: QuotaReleaseClient | null = null;
  let quotaReservation: QuotaReservation | null = null;
  let authenticatedUserId: string | null = null;

  async function releaseQuotaReservation(reason: string): Promise<void> {
    if (!quotaReleaseClient || !quotaReservation?.usageId || !authenticatedUserId) {
      return;
    }

    try {
      const { error } = await quotaReleaseClient.rpc('release_transcription_quota', {
        p_usage_id: quotaReservation.usageId,
        p_user_id: authenticatedUserId,
      });
      if (error) {
        console.warn('[Transcribe] Failed to release quota reservation:', {
          reason,
          message: error.message ?? 'unknown',
        });
      }
    } catch (releaseError: unknown) {
      console.warn('[Transcribe] Failed to release quota reservation:', {
        reason,
        message: toLogMessage(releaseError),
      });
    }
  }

  try {
    // 1. 认证检查
    const token = getBearerToken(req)
    if (!token) {
      console.error('[Transcribe] No Authorization header');
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({
          error: 'Supabase service configuration is not configured',
          code: 'SERVICE_NOT_CONFIGURED',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 使用 SUPABASE_SERVICE_ROLE_KEY 查询配额（绕过 RLS）
    const supabaseAdmin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      SERVICE_ROLE_CLIENT_OPTIONS,
    )
    quotaReleaseClient = supabaseAdmin as unknown as QuotaReleaseClient;
    
    // 🔧 修复：直接使用 token 验证用户，而不是依赖 header 配置
    // auth.getUser(token) 会直接验证传入的 JWT token
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      console.error('[Transcribe] Auth validation failed:', authError?.message || 'No user');
      return new Response(
        JSON.stringify({ error: 'Invalid token', code: 'AUTH_INVALID' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    authenticatedUserId = user.id;

    // 2. 配额检查会在文件验证后通过 RPC 原子预占，避免并发请求同时绕过限额。
    const today = new Date().toISOString().split('T')[0]

    // 3. 从请求中获取 FormData（包含录音文件）
    const formData = await readFormDataWithLimit(req)
    const audioFile = formData.get('file')

    if (!audioFile || !(audioFile instanceof File)) {
      console.error('[Transcribe] No audio file in request');
      return new Response(
        JSON.stringify({ error: 'No audio file uploaded', code: 'FILE_MISSING' }), 
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. 检查文件大小
    if (audioFile.size > MAX_FILE_SIZE) {
      console.error('[Transcribe] File too large:', audioFile.size);
      return new Response(
        JSON.stringify({ error: '音频文件过大，请控制在 25MB 以内', code: 'FILE_TOO_LARGE' }), 
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!isAllowedAudioFile(audioFile)) {
      console.warn('[Transcribe] Unsupported audio file type:', {
        mimeType: audioFile.type || 'unknown',
        extension: getFileExtension(audioFile.name) || 'none',
        size: audioFile.size,
      });
      return new Response(
        JSON.stringify({ error: '不支持的音频格式', code: 'FILE_TYPE_UNSUPPORTED' }),
        { status: 415, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const audioSeconds = Math.round(audioFile.size / 16000);
    const { data: quotaData, error: quotaError } = await supabaseAdmin.rpc('consume_transcription_quota', {
      p_user_id: user.id,
      p_usage_date: today,
      p_daily_limit: DAILY_QUOTA_PER_USER,
      p_audio_seconds: audioSeconds,
    });
    const quota = parseQuotaResult(quotaData);
    if (quotaError || !quota) {
      console.error('[Transcribe] Quota reservation error:', quotaError?.message ?? 'invalid quota result');
      return new Response(
        JSON.stringify({ error: '转写配额暂不可用，请稍后再试', code: 'QUOTA_UNAVAILABLE', retryable: true }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '30' } }
      )
    }

    if (!quota.allowed) {
      console.warn('[Transcribe] Quota exceeded');
      return new Response(
        JSON.stringify({ error: '今日转写次数已达上限', code: 'QUOTA_EXCEEDED' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    quotaReservation = quota;

    // 5. 准备发给 Groq 的数据
    const groqFormData = new FormData()
    groqFormData.append('file', audioFile)
    groqFormData.append('model', 'whisper-large-v3')
    // 引导模型输出简体中文
    groqFormData.append('prompt', '这是一段关于软件开发、项目管理或日常工作的语音记录，请用简体中文转写')
    groqFormData.append('language', 'zh')

    // 6. 调用 Groq API
    const groqApiKey = Deno.env.get('GROQ_API_KEY')
    if (!groqApiKey) {
      console.error('[Transcribe] GROQ_API_KEY not configured')
      await releaseQuotaReservation('missing_groq_api_key');
      return new Response(
        JSON.stringify({ error: '转写服务未配置', code: 'SERVICE_NOT_CONFIGURED' }), 
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 使用 AbortController 设置超时，确保在 Supabase 网关超时前返回带 CORS 头的响应
    const groqAbort = new AbortController();
    const groqTimer = setTimeout(() => groqAbort.abort(), GROQ_TIMEOUT_MS);

    let groqResponse: Response;
    try {
      groqResponse = await traceGroqTranscription({
        userId: user.id,
        fileSizeBytes: audioFile.size,
        mimeType: normalizeMimeType(audioFile.type),
        fileExtension: getFileExtension(audioFile.name),
        model: 'whisper-large-v3',
        language: 'zh',
      }, GROQ_API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
        },
        body: groqFormData,
        signal: groqAbort.signal,
      });
    } catch (fetchErr: unknown) {
      clearTimeout(groqTimer);
      // AbortError 表示超时，返回带 CORS 头的受控上游失败，而非让网关吞掉响应
      if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
        console.error('[Transcribe] Groq API timed out after', GROQ_TIMEOUT_MS, 'ms');
        await releaseQuotaReservation('groq_timeout');
        return new Response(
          JSON.stringify({ ok: false, error: '转写服务响应超时，请缩短录音后重试', code: 'GROQ_TIMEOUT', retryable: true }),
          {
            status: 503,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Retry-After': '30',
            },
          }
        );
      }
      // 网络错误（DNS 失败、连接拒绝等）
      console.error('[Transcribe] Groq API fetch failed:', toLogMessage(fetchErr));
      await releaseQuotaReservation('groq_unreachable');
      return new Response(
        JSON.stringify({ ok: false, error: '无法连接转写服务', code: 'GROQ_UNREACHABLE', retryable: true }),
        {
          status: 502,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '30',
          },
        }
      );
    } finally {
      clearTimeout(groqTimer);
    }

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text()
      console.error('[Transcribe] Groq API Error:', {
        status: groqResponse.status,
        bodyLength: errorText.length,
      })
      
      // 根据 Groq 错误码返回合适的响应
      if (groqResponse.status === 429) {
        const retryAfter = groqResponse.headers.get('Retry-After') ?? '30';
        await releaseQuotaReservation('groq_rate_limited');
        return new Response(
          JSON.stringify({ ok: false, error: 'Groq API 请求过于频繁，请稍后再试', code: 'GROQ_RATE_LIMITED', retryable: true }),
          {
            status: 429,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Retry-After': retryAfter,
            },
          }
        )
      }
      
      await releaseQuotaReservation('groq_service_unavailable');
      return new Response(
        JSON.stringify({ ok: false, error: '转写服务暂不可用', code: 'SERVICE_UNAVAILABLE', retryable: true }),
        {
          status: 502,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '30',
          },
        }
      )
    }

    const data = await groqResponse.json()

    // 7. 返回转写后的文本
    return new Response(JSON.stringify({ 
      text: data.text,
      duration: data.duration,
      language: data.language 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response(
        JSON.stringify({ error: '音频文件过大，请控制在 25MB 以内', code: 'FILE_TOO_LARGE' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.error('Transcribe Error:', toLogMessage(error))
    await releaseQuotaReservation('internal_error');

    return new Response(JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
