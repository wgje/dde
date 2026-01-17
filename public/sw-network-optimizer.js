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

// ========== 字体缓存策略 ==========
const FONT_CACHE_NAME = 'nanoflow-fonts-v1';
const FONT_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1年

/**
 * 判断是否为字体请求
 * @param {URL} url 
 * @returns {boolean}
 */
function isFontRequest(url) {
  return url.pathname.endsWith('.woff2') || 
         url.pathname.endsWith('.woff') || 
         url.pathname.endsWith('.ttf') ||
         url.hostname.includes('fonts.gstatic.com') ||
         (url.hostname.includes('jsdelivr.net') && url.pathname.includes('lxgw'));
}

/**
 * 缓存优先的字体获取策略
 * @param {Request} request 
 * @returns {Promise<Response>}
 */
async function fetchFontWithCache(request) {
  const cache = await caches.open(FONT_CACHE_NAME);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    // 字体已缓存，直接返回
    return cachedResponse;
  }
  
  // 字体未缓存，从网络获取并缓存
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // 克隆响应用于缓存
      const responseToCache = networkResponse.clone();
      cache.put(request, responseToCache);
    }
    
    return networkResponse;
  } catch (error) {
    // 网络失败，返回错误
    console.error('[SW] Font fetch failed:', error);
    throw error;
  }
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
  const url = new URL(request.url);
  
  // 字体请求：缓存优先策略
  if (isFontRequest(url)) {
    return fetchFontWithCache(request);
  }
  
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
  
  // 字体请求始终需要优化（缓存）
  if (isFontRequest(url)) {
    return true;
  }
  
  return isSupabaseRequest(url) && isSaveDataEnabled(request);
};

// 网络统计（调试用）
self._networkOptimizerStats = {
  totalRequests: 0,
  optimizedRequests: 0,
  fontCacheHits: 0,
};

console.log('[SW Network Optimizer] Loaded with font caching');
