// ============================================
// Supabase Edge Function: 病毒扫描服务
// 提供文件病毒扫描功能
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ==================== 配置 ====================

const CLAMAV_API_URL = Deno.env.get('CLAMAV_API_URL') || 'http://clamav:3310';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
  action: 'scan' | 'status' | 'health' | 'verify-hash' | 'rescan';
  file?: string; // base64 编码的文件
  filename?: string;
  hash?: string;
  mimeType?: string;
  fileId?: string;
  expectedHash?: string;
}

interface ScanResult {
  fileId: string;
  status: string;
  threatName?: string;
  threatDescription?: string;
  scannedAt: string;
  scanner: string;
  engineVersion?: string;
  signatureVersion?: string;
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
    'http://localhost:4200',      // 开发环境
    'http://localhost:5173',      // Vite 开发服务器
  ];
})();

/** 文件大小限制：10MB base64 编码后约 13.7MB */
const MAX_FILE_BASE64_LENGTH = 10 * 1024 * 1024 * 1.37;

/**
 * 根据请求来源返回 CORS 头
 * 只有白名单中的来源才会被允许
 */
/** Vercel 预览域名项目级前缀（受控模式） */
const VERCEL_PREVIEW_PREFIX = 'dde-';

function getCorsHeaders(origin: string | null): Record<string, string> {
  let isAllowed = false;
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      isAllowed = true;
    } else {
      // SEC-M5: 用 URL 解析锚定 hostname，防止 evil-dde-xxx.vercel.app 绕过
      try {
        const url = new URL(origin);
        isAllowed = url.hostname.startsWith(VERCEL_PREVIEW_PREFIX) && url.hostname.endsWith('.vercel.app');
      } catch { /* 非法 origin 忽略 */ }
    }
  }
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
  if (!authHeader) {
    return null;
  }
  
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return null;
  }
  
  return { userId: user.id };
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

  try {
    // 🔒 安全修复：添加认证检查（health 检查除外）
    const body = await req.json() as ScanRequest;
    const { action } = body;

    // health 检查不需要认证（用于监控）
    if (action === 'health') {
      return handleHealthCheck(corsHeaders);
    }

    // 其他操作需要认证
    const auth = await verifyAuth(req);
    if (!auth) {
      console.warn('🛡️ [VirusScan] Unauthorized request for action:', action);
      return jsonResponse({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, corsHeaders, 401);
    }

    console.log('🛡️ [VirusScan] Authenticated user:', auth.userId.slice(0, 8) + '...', 'action:', action);

    switch (action) {
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
async function handleScan(body: ScanRequest, _userId: string, corsHeaders: Record<string, string>): Promise<Response> {
  const { file, filename, hash, mimeType } = body;
  
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
    
    // 调用 ClamAV 扫描
    const scanResult = await scanWithClamAv(fileBytes, filename);
    
    // 记录扫描结果
    await saveScanResult(fileId, hash || '', scanResult);
    
    // SEC-C1 fix: ClamAV 失败时返回 FAILED 状态，不假装为 CLEAN
    const effectiveStatus = scanResult.status === SCAN_STATUS.FAILED
      ? SCAN_STATUS.FAILED
      : (scanResult.infected ? SCAN_STATUS.THREAT_DETECTED : SCAN_STATUS.CLEAN);

    const result: ScanResult = {
      fileId,
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
    
    // 保存失败记录
    await saveScanResult(fileId, hash || '', {
      infected: false,
      status: SCAN_STATUS.FAILED,
      error: String(error),
    });
    
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
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // SEC-C2 fix: 添加 user_id 过滤，防止 IDOR 越权访问
    const { data, error } = await supabase
      .from('attachment_scans')
      .select('*')
      .eq('file_id', fileId)
      .eq('user_id', userId)
      .single();

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
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // SEC-C2 fix: 添加 user_id 过滤
    const { data, error } = await supabase
      .from('attachment_scans')
      .select('file_hash')
      .eq('file_id', fileId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return jsonResponse({ valid: false, error: 'File not found' }, corsHeaders);
    }

    const valid = data.file_hash === expectedHash;
    
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
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // SEC-C2 fix: 添加 user_id 过滤，仅允许操作自己的文件
    const { data: existing } = await supabase
      .from('attachment_scans')
      .select('file_id')
      .eq('file_id', fileId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existing) {
      return jsonResponse({ error: 'Scan record not found' }, corsHeaders, 404);
    }

    // 更新状态为 scanning
    await supabase
      .from('attachment_scans')
      .update({ status: SCAN_STATUS.SCANNING })
      .eq('file_id', fileId)
      .eq('user_id', userId);

    // TODO: 从 Storage 获取文件并重新扫描
    // 这里应该触发一个后台任务
    
    return jsonResponse({
      fileId,
      status: SCAN_STATUS.SCANNING,
      message: 'Rescan queued',
    }, corsHeaders);
  } catch (error) {
    console.error('Rescan error:', error);
    return jsonResponse({ error: 'Failed to queue rescan' }, corsHeaders, 500);
  }
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

/**
 * 使用 ClamAV 扫描文件
 */
async function scanWithClamAv(fileBytes: Uint8Array, filename: string): Promise<ClamAvScanResult> {
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
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`ClamAV returned status ${response.status}`);
    }

    const result = await response.json();
    
    return {
      infected: result.infected || false,
      virusName: result.virus_name,
      description: result.description,
      engineVersion: result.engine_version,
      signatureVersion: result.signature_version,
    };
  } catch (error) {
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

/**
 * 保存扫描结果到数据库
 */
async function saveScanResult(
  fileId: string, 
  fileHash: string, 
  result: ClamAvScanResult
): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const status = result.infected 
    ? SCAN_STATUS.THREAT_DETECTED 
    : (result.status || SCAN_STATUS.CLEAN);

  await supabase.from('attachment_scans').upsert({
    file_id: fileId,
    file_hash: fileHash,
    status,
    threat_name: result.virusName,
    threat_description: result.description,
    scanner: 'clamav',
    engine_version: result.engineVersion,
    signature_version: result.signatureVersion,
    scanned_at: new Date().toISOString(),
    error_message: result.error,
  });
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
