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

// 字段筛选配置（与 src/config/sync.config.ts 保持同步）
const FIELD_SELECTS = {
  tasks: 'id,title,stage,parent_id,order,rank,status,x,y,updated_at,deleted_at,short_id',
  connections: 'id,source_id,target_id,title,description,deleted_at,updated_at',
  projects: 'id,title,description,created_date,updated_at,version,owner_id',
};

/**
 * 判断是否为 Supabase API 请求
 * @param {URL} url 
 * @returns {boolean}
 */
function isSupabaseRequest(url) {
  return url.hostname.includes('supabase');
}

/**
 * 获取表名从 URL 路径
 * @param {URL} url 
 * @returns {string|null}
 */
function getTableName(url) {
  const pathMatch = url.pathname.match(/\/rest\/v1\/(\w+)/);
  return pathMatch ? pathMatch[1] : null;
}

/**
 * 添加字段筛选到 URL
 * @param {URL} url 
 * @returns {URL}
 */
function addFieldSelection(url) {
  const tableName = getTableName(url);
  
  if (!tableName) return url;
  
  const selectConfig = FIELD_SELECTS[tableName];
  
  if (selectConfig && !url.searchParams.has('select')) {
    const newUrl = new URL(url.toString());
    newUrl.searchParams.set('select', selectConfig);
    return newUrl;
  }
  
  return url;
}

/**
 * 检测 Save-Data 请求头
 * @param {Request} request 
 * @returns {boolean}
 */
function isSaveDataEnabled(request) {
  return request.headers.get('Save-Data') === 'on';
}

/**
 * 创建优化后的请求
 * @param {Request} request 
 * @param {boolean} saveData 
 * @returns {Request}
 */
function createOptimizedRequest(request, saveData) {
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
 * 网络优化 fetch 处理器
 * 
 * 在主 Service Worker 的 fetch 事件中使用：
 * 
 * importScripts('./sw-network-optimizer.js');
 * 
 * self.addEventListener('fetch', (event) => {
 *   // ... 其他处理 ...
 *   
 *   // 网络优化处理
 *   if (shouldOptimize(event.request)) {
 *     event.respondWith(optimizedFetch(event.request));
 *   }
 * });
 * 
 * @param {Request} request 
 * @returns {Promise<Response>}
 */
self.optimizedFetch = async function(request) {
  const saveData = isSaveDataEnabled(request);
  
  if (saveData) {
    const optimizedRequest = createOptimizedRequest(request, true);
    return fetch(optimizedRequest);
  }
  
  return fetch(request);
};

/**
 * 判断请求是否应该被优化
 * @param {Request} request 
 * @returns {boolean}
 */
self.shouldOptimize = function(request) {
  const url = new URL(request.url);
  return isSupabaseRequest(url) && isSaveDataEnabled(request);
};

// 网络统计（调试用）
self._networkOptimizerStats = {
  totalRequests: 0,
  optimizedRequests: 0,
};

console.log('[SW Network Optimizer] Loaded');
