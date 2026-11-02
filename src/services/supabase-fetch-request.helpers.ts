const READ_ONLY_RPC_FUNCTIONS = new Set([
  'batch_get_tombstones',
  'get_accessible_project_probe',
  'get_black_box_sync_watermark',
  'get_project_sync_watermark',
  'get_resume_recovery_probe',
  'get_server_time',
  'get_user_projects_watermark',
  'list_project_heads_since',
  'sync_check_protocol',
]);

export function getSupabaseRequestMethod(url: RequestInfo | URL, options: RequestInit): string {
  if (typeof options.method === 'string' && options.method.length > 0) {
    return options.method.toUpperCase();
  }

  if (isRequestObject(url) && typeof url.method === 'string' && url.method.length > 0) {
    return url.method.toUpperCase();
  }

  return 'GET';
}

export function isGatewayRetrySafeSupabaseRequest(
  url: RequestInfo | URL,
  options: RequestInit,
  httpMethod: string,
): boolean {
  return httpMethod === 'GET'
    || httpMethod === 'HEAD'
    || isReadOnlyRpcRequest(url, options, httpMethod);
}

export function buildSupabaseFetch401RetryKey(url: RequestInfo | URL, options: RequestInit): string {
  return `${getSupabaseRequestMethod(url, options)}:${getRequestUrl(url)}`;
}

export function buildSupabaseRequestSignature(url: RequestInfo | URL, options: RequestInit): string {
  const body = typeof options.body === 'string' ? options.body : '';
  return `${options.method?.toUpperCase() ?? 'GET'}:${getRequestUrl(url)}:${body.substring(0, 100)}`;
}

export function redactSupabaseRequestUrl(url: RequestInfo | URL): string {
  const raw = getRequestUrl(url);
  if (!raw) return '';

  const queryIndex = raw.indexOf('?');
  return queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
}

function isReadOnlyRpcRequest(url: RequestInfo | URL, options: RequestInit, httpMethod: string): boolean {
  if (httpMethod !== 'POST') {
    return false;
  }

  if (isRequestObject(url) && options.body === undefined) {
    return false;
  }

  const rpcFunctionName = extractRpcFunctionName(url);
  return rpcFunctionName !== null && READ_ONLY_RPC_FUNCTIONS.has(rpcFunctionName);
}

function isRequestObject(url: RequestInfo | URL): url is Request {
  return typeof Request !== 'undefined' && url instanceof Request;
}

function extractRpcFunctionName(url: RequestInfo | URL): string | null {
  const raw = getRequestUrl(url);
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw, 'http://localhost');
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const rpcIndex = pathSegments.lastIndexOf('rpc');
    const functionName = rpcIndex >= 0 ? pathSegments[rpcIndex + 1] : undefined;
    return functionName ? safeDecodeURIComponent(functionName) : null;
  } catch {
    const match = raw.match(/\/rpc\/([^/?#]+)/);
    return match?.[1] ? safeDecodeURIComponent(match[1]) : null;
  }
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // 非法百分号编码无法解码
  }
  return null;
}

function getRequestUrl(url: RequestInfo | URL): string {
  return typeof url === 'string'
    ? url
    : url instanceof URL
      ? url.href
      : (url as Request).url;
}
