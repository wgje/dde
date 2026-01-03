/// <reference lib="webworker" />

/**
 * Service Worker 网络优化器
 * 
 * 【Stingy Hoarder Protocol】
 * 
 * 功能：
 * - 检测 Save-Data 请求头
 * - 对 Supabase API 请求添加字段筛选
 * - 压缩响应
 * 
 * @see docs/plan_save.md Phase 4.2.4
 */

// 注意：这是一个 Service Worker 模块，将被主 SW 导入
declare const self: ServiceWorkerGlobalScope;

/**
 * 字段筛选配置（与 src/config/sync.config.ts 保持同步）
 */
const FIELD_SELECTS = {
  tasks: 'id,title,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id',
  connections: 'id,source_id,target_id,title,description,deleted_at,updated_at',
  projects: 'id,title,description,created_date,updated_at,version,owner_id',
};

/**
 * 判断是否为 Supabase API 请求
 */
function isSupabaseRequest(url: URL): boolean {
  return url.hostname.includes('supabase');
}

/**
 * 获取表名从 URL 路径
 */
function getTableName(url: URL): string | null {
  const pathMatch = url.pathname.match(/\/rest\/v1\/(\w+)/);
  return pathMatch ? pathMatch[1] : null;
}

/**
 * 添加字段筛选到 URL
 */
function addFieldSelection(url: URL): URL {
  const tableName = getTableName(url);
  
  if (!tableName) return url;
  
  const selectConfig = FIELD_SELECTS[tableName as keyof typeof FIELD_SELECTS];
  
  if (selectConfig && !url.searchParams.has('select')) {
    const newUrl = new URL(url.toString());
    newUrl.searchParams.set('select', selectConfig);
    return newUrl;
  }
  
  return url;
}

/**
 * 创建优化后的请求
 */
function createOptimizedRequest(request: Request, saveData: boolean): Request {
  const url = new URL(request.url);
  
  // 如果不是 Supabase 请求，直接返回原请求
  if (!isSupabaseRequest(url)) {
    return request;
  }
  
  // 只读请求才添加字段筛选
  if (request.method === 'GET' && saveData) {
    const optimizedUrl = addFieldSelection(url);
    
    // 创建新的请求头
    const headers = new Headers(request.headers);
    headers.set('Accept-Encoding', 'gzip, br');
    headers.set('X-Nanoflow-DataSaver', 'on');
    
    return new Request(optimizedUrl.toString(), {
      method: request.method,
      headers,
      mode: request.mode,
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      integrity: request.integrity,
    });
  }
  
  return request;
}

/**
 * 检测 Save-Data 请求头
 */
function isSaveDataEnabled(request: Request): boolean {
  return request.headers.get('Save-Data') === 'on';
}

/**
 * 网络优化处理器
 * 
 * 用法：在 Service Worker 的 fetch 事件中调用
 * 
 * ```js
 * self.addEventListener('fetch', (event) => {
 *   const optimizedRequest = handleNetworkOptimization(event.request);
 *   event.respondWith(fetch(optimizedRequest));
 * });
 * ```
 */
export function handleNetworkOptimization(request: Request): Request {
  const saveData = isSaveDataEnabled(request);
  
  if (saveData) {
    return createOptimizedRequest(request, true);
  }
  
  return request;
}

/**
 * 注册网络优化到 Service Worker
 * 
 * 此函数应在主 Service Worker 中调用
 */
export function registerNetworkOptimizer(self: ServiceWorkerGlobalScope): void {
  self.addEventListener('fetch', (event: FetchEvent) => {
    const url = new URL(event.request.url);
    
    // 只处理 Supabase API 请求
    if (!isSupabaseRequest(url)) {
      return;
    }
    
    const saveData = isSaveDataEnabled(event.request);
    
    if (saveData) {
      const optimizedRequest = createOptimizedRequest(event.request, true);
      
      event.respondWith(
        fetch(optimizedRequest).then(response => {
          // 可以在这里添加额外的响应处理
          return response;
        }).catch(error => {
          console.error('[SW Network Optimizer] Fetch failed:', error);
          throw error;
        })
      );
    }
  });
  
  console.log('[SW Network Optimizer] Registered');
}

/**
 * 网络请求统计（用于调试）
 */
export interface NetworkStats {
  totalRequests: number;
  optimizedRequests: number;
  savedBytes: number;
}

let stats: NetworkStats = {
  totalRequests: 0,
  optimizedRequests: 0,
  savedBytes: 0,
};

/**
 * 获取网络统计
 */
export function getNetworkStats(): NetworkStats {
  return { ...stats };
}

/**
 * 重置网络统计
 */
export function resetNetworkStats(): void {
  stats = {
    totalRequests: 0,
    optimizedRequests: 0,
    savedBytes: 0,
  };
}
