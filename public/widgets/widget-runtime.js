/**
 * widget-runtime.js — Windows PWA Widget 事件处理运行时
 *
 * 职责：
 *  - 处理 widgetinstall / widgetresume / widgetclick / widgetuninstall 生命周期
 *  - activate / periodicsync 触发刷新
 *  - 从 IndexedDB 读取 Widget Token，调用 widget-summary Edge Function
 *  - 渲染 Adaptive Cards 模板（只读摘要 + 打开主应用）
 *  - widgetclick 的单窗口复用（leader-aware）
 *  - 严格只读：不从 Widget 上下文发起任何写操作
 *
 * D02: 事件接通
 * D03: Adaptive Cards + runtime-only data path
 * D04: 首次可用性降级
 * D05: widgetclick 先复用窗口、必要时再 openWindow()
 * D06: leader-aware 复用逻辑
 * D07: 只读范围，无任务写入
 */

// ============================================================
// 常量
// ============================================================

/** Widget 标签，与 manifest.webmanifest widgets[].tag 一致 */
var WIDGET_TAG = 'nanoflow-focus-summary';

/** IndexedDB 存储名，主应用写入、SW 读取 */
var WIDGET_DB_NAME = 'nanoflow-widget';
var WIDGET_DB_STORE = 'config';
var WIDGET_TOKEN_KEY = 'widget-token';
var WIDGET_CONFIG_KEY = 'widget-config';
var WIDGET_INSTANCE_STATE_KEY = 'widget-instance-state';

/** periodicsync 事件 tag */
var PERIODIC_SYNC_TAG = 'widget-refresh';
var WIDGET_DATA_PATH_SUFFIX = '/widgets/templates/focus-data.json';

/** 窗口匹配用的 URL 片段 */
var APP_URL_FRAGMENT = '#/projects';

// ============================================================
// IndexedDB 辅助（原生 API，不依赖 idb-keyval）
// ============================================================

/**
 * 打开 widget 专用 IndexedDB
 * @returns {Promise<IDBDatabase>}
 */
function openWidgetDb() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(WIDGET_DB_NAME, 1);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains(WIDGET_DB_STORE)) {
        db.createObjectStore(WIDGET_DB_STORE);
      }
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

/**
 * 从 IndexedDB 读取指定 key
 * @param {string} key
 * @returns {Promise<any>}
 */
function readFromDb(key) {
  return openWidgetDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(WIDGET_DB_STORE, 'readonly');
      var store = tx.objectStore(WIDGET_DB_STORE);
      var req = store.get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

/**
 * 写入 IndexedDB 指定 key
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
function writeToDb(key, value) {
  return openWidgetDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(WIDGET_DB_STORE, 'readwrite');
      var store = tx.objectStore(WIDGET_DB_STORE);
      var req = store.put(value, key);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function normalizeWidgetText(value, maxLength) {
  var text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= maxLength ? text : null;
}

function resolveWidgetHostInstanceId(widget) {
  if (!widget || widget.instanceId == null) {
    return null;
  }

  return normalizeWidgetText(String(widget.instanceId), 128);
}

function resolveWidgetSizeBucket(widget) {
  var candidates = [
    widget && typeof widget.size === 'string' ? widget.size : null,
    widget && typeof widget.displaySize === 'string' ? widget.displaySize : null,
    widget && widget.definition && typeof widget.definition.size === 'string' ? widget.definition.size : null,
  ];

  for (var index = 0; index < candidates.length; index += 1) {
    var sizeBucket = normalizeWidgetText(candidates[index], 32);
    if (sizeBucket) {
      return sizeBucket;
    }
  }

  return 'default';
}

function readWidgetInstanceState() {
  return readFromDb(WIDGET_INSTANCE_STATE_KEY).then(function (state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { instances: {} };
    }

    var instances = state.instances;
    return {
      instances: instances && typeof instances === 'object' && !Array.isArray(instances)
        ? instances
        : {},
    };
  }).catch(function () {
    return { instances: {} };
  });
}

function notifyWindowClients(type, detail) {
  if (!self.clients || typeof self.clients.matchAll !== 'function') {
    return Promise.resolve();
  }

  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) {
      client.postMessage({ type: type, detail: detail || null });
    });
  }).catch(function () {
    return undefined;
  });
}

function rememberWidgetInstance(widget, forceNotify) {
  var hostInstanceId = resolveWidgetHostInstanceId(widget);
  if (!hostInstanceId) {
    return Promise.resolve(null);
  }

  var now = new Date().toISOString();
  return readWidgetInstanceState().then(function (state) {
    var nextInstances = Object.assign({}, state.instances || {});
    var existing = nextInstances[hostInstanceId] || {};
    var nextSizeBucket = resolveWidgetSizeBucket(widget);
    var shouldBroadcast = forceNotify === true || !existing.hostInstanceId || existing.sizeBucket !== nextSizeBucket;

    if (!shouldBroadcast) {
      return existing;
    }

    nextInstances[hostInstanceId] = {
      hostInstanceId: hostInstanceId,
      sizeBucket: nextSizeBucket,
      installedAt: existing.installedAt || now,
      lastSeenAt: now,
    };

    return writeToDb(WIDGET_INSTANCE_STATE_KEY, {
      instances: nextInstances,
      updatedAt: now,
    }).then(function () {
      return notifyWindowClients('WIDGET_INSTANCE_STATE_CHANGED', {
        hostInstanceId: hostInstanceId,
        state: 'active',
      });
    }).then(function () {
      return nextInstances[hostInstanceId];
    });
  }).catch(function () {
    return null;
  });
}

function forgetWidgetInstance(widget) {
  var hostInstanceId = resolveWidgetHostInstanceId(widget);
  if (!hostInstanceId) {
    return Promise.resolve();
  }

  return readWidgetInstanceState().then(function (state) {
    var nextInstances = Object.assign({}, state.instances || {});
    delete nextInstances[hostInstanceId];
    return writeToDb(WIDGET_INSTANCE_STATE_KEY, {
      instances: nextInstances,
      updatedAt: new Date().toISOString(),
    });
  }).then(function () {
    // 保留 instanceBindings，直到认证页成功把 uninstall-instance 上报到服务端。
    return notifyWindowClients('WIDGET_INSTANCE_STATE_CHANGED', {
      hostInstanceId: hostInstanceId,
      state: 'removed',
    });
  }).catch(function () {
    return undefined;
  });
}

function resolveBoundWidgetInstanceId(instanceBindings, hostInstanceId) {
  if (!instanceBindings || typeof instanceBindings !== 'object' || Array.isArray(instanceBindings)) {
    return null;
  }

  var binding = instanceBindings[hostInstanceId];
  return binding && typeof binding.instanceId === 'string' && binding.instanceId.trim().length > 0
    ? binding.instanceId.trim()
    : null;
}

function clearBoundWidgetInstance(hostInstanceId) {
  if (!hostInstanceId) {
    return Promise.resolve();
  }

  return readFromDb(WIDGET_CONFIG_KEY).then(function (config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return undefined;
    }

    var instanceBindings = config.instanceBindings;
    if (!instanceBindings || typeof instanceBindings !== 'object' || Array.isArray(instanceBindings)) {
      return undefined;
    }

    var nextConfig = Object.assign({}, config);
    var nextBindings = Object.assign({}, instanceBindings);
    delete nextBindings[hostInstanceId];
    nextConfig.instanceBindings = nextBindings;
    return writeToDb(WIDGET_CONFIG_KEY, nextConfig);
  }).catch(function () {
    return undefined;
  });
}

// ============================================================
// 模板加载
// ============================================================

/** 缓存已加载的模板 JSON 字符串 */
var templateCache = {};

/**
 * 加载 Adaptive Cards 模板
 * @param {string} name - 模板文件名（不含 .json）
 * @returns {Promise<string>} JSON 字符串
 */
function loadTemplate(name) {
  if (templateCache[name]) {
    return Promise.resolve(templateCache[name]);
  }
  return fetch('./widgets/templates/' + name + '.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Template fetch failed: ' + name);
      return res.text();
    })
    .then(function (text) {
      templateCache[name] = text;
      return text;
    });
}

// ============================================================
// Widget Token 读取
// ============================================================

/**
 * 读取 Widget 认证 token（由主应用写入 IndexedDB）
 * @returns {Promise<{token: string, supabaseUrl: string, clientVersion: string | null} | null>}
 */
function readWidgetCredentials() {
  return Promise.all([
    readFromDb(WIDGET_TOKEN_KEY),
    readFromDb(WIDGET_CONFIG_KEY),
  ]).then(function (results) {
    var token = results[0];
    var config = results[1];
    if (!token || !config || !config.supabaseUrl) return null;
    return {
      token: token,
      supabaseUrl: config.supabaseUrl,
      clientVersion: typeof config.clientVersion === 'string' && config.clientVersion.trim().length > 0
        ? config.clientVersion.trim()
        : null,
      instanceBindings: config.instanceBindings && typeof config.instanceBindings === 'object' && !Array.isArray(config.instanceBindings)
        ? config.instanceBindings
        : {},
    };
  }).catch(function () {
    return null;
  });
}

// ============================================================
// widget-summary 调用（只读！D07）
// ============================================================

/**
 * 调用 widget-summary Edge Function
 * @param {string} supabaseUrl
 * @param {string} widgetToken
 * @param {string} instanceId
 * @param {string} hostInstanceId
 * @param {string | null} clientVersion
 * @returns {Promise<{ok: boolean, status: number, data: any, errorCode?: string}>}
 */
function fetchWidgetSummary(supabaseUrl, widgetToken, instanceId, hostInstanceId, clientVersion) {
  var url = supabaseUrl + '/functions/v1/widget-summary';
  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, 10000);
  var requestBody = {
    clientSchemaVersion: 1,
    instanceId: instanceId,
    hostInstanceId: hostInstanceId,
    platform: 'windows-pwa',
  };

  if (clientVersion) {
    requestBody.clientVersion = clientVersion;
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + widgetToken,
    },
    body: JSON.stringify(requestBody),
    cache: 'no-store',
    signal: controller.signal,
  }).then(function (res) {
    clearTimeout(timeoutId);
    return res.json().then(function (data) {
      return { ok: res.ok, status: res.status, data: data, errorCode: data.code };
    });
  }).catch(function (err) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0, data: null, errorCode: 'NETWORK_ERROR' };
  });
}

// ============================================================
// 数据 → Adaptive Cards data 映射
// ============================================================

/**
 * 将 widget-summary 响应转换为模板绑定数据
 * @param {object} summary
 * @returns {string} JSON 字符串
 */
function buildWidgetTemplateDataRecord(summary) {
  var focus = (summary && summary.focus) || {};
  var dock = (summary && summary.dock) || {};
  var blackBox = (summary && summary.blackBox) || {};
  var gatePreview = blackBox.gatePreview || {};

  return {
    title: 'NanoFlow',
    focusTaskName: focus.title || '无专注任务',
    dockCount: String(dock.count != null ? dock.count : 0),
    blackboxCount: String(blackBox.pendingCount != null ? blackBox.pendingCount : 0),
    projectName: focus.projectTitle || gatePreview.projectTitle || '-',
    updatedAt: formatWidgetSummaryTime(summary && summary.cloudUpdatedAt),
    statusLine: buildWidgetStatusLine(summary),
  };
}

function summaryToTemplateData(summary) {
  return JSON.stringify(buildWidgetTemplateDataRecord(summary));
}

function formatWidgetSummaryTime(cloudUpdatedAt) {
  var timestamp = typeof cloudUpdatedAt === 'string' ? Date.parse(cloudUpdatedAt) : NaN;
  var date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function buildWidgetStatusLine(summary) {
  var sourceState = summary && summary.sourceState;
  var freshnessState = summary && summary.freshnessState;
  var trustState = summary && summary.trustState;
  var parts = [];

  switch (sourceState) {
    case 'cache-only':
      parts.push('本地缓存');
      break;
    case 'cloud-pending-local-hint':
      parts.push('云端待确认');
      break;
    default:
      parts.push('云端摘要');
      break;
  }

  switch (freshnessState) {
    case 'stale':
      parts.push('摘要较旧');
      break;
    case 'aging':
      parts.push('摘要稍旧');
      break;
    default:
      parts.push('摘要新鲜');
      break;
  }

  switch (trustState) {
    case 'auth-required':
      parts.push('需重新绑定');
      break;
    case 'untrusted':
      parts.push('待人工确认');
      break;
    case 'provisional':
      parts.push('待验证');
      break;
    default:
      parts.push('已验证');
      break;
  }

  parts.push('更新于 ' + formatWidgetSummaryTime(summary && summary.cloudUpdatedAt));
  return parts.join(' · ');
}

function buildFallbackWidgetTemplateData(reason) {
  var statusLine;
  var focusTaskName;

  switch (reason) {
    case 'auth-required':
      focusTaskName = '打开 NanoFlow 重新绑定';
      statusLine = '需重新绑定 · 更新于 ' + formatWidgetSummaryTime(null);
      break;
    case 'setup-required':
      focusTaskName = '打开 NanoFlow 完成初始化';
      statusLine = '等待完成初始化 · 更新于 ' + formatWidgetSummaryTime(null);
      break;
    default:
      focusTaskName = '暂时无法刷新';
      statusLine = '摘要暂不可用 · 更新于 ' + formatWidgetSummaryTime(null);
      break;
  }

  return JSON.stringify({
    title: 'NanoFlow',
    focusTaskName: focusTaskName,
    dockCount: '0',
    blackboxCount: '0',
    projectName: '-',
    updatedAt: formatWidgetSummaryTime(null),
    statusLine: statusLine,
  });
}

function readPrimaryInstalledWidget() {
  if (!self.widgets || typeof self.widgets.getByTag !== 'function') {
    return Promise.resolve(null);
  }

  return self.widgets.getByTag(WIDGET_TAG)
    .then(function (widgets) {
      return Array.isArray(widgets) && widgets.length > 0 ? widgets[0] : null;
    })
    .catch(function () {
      return null;
    });
}

function resolveWidgetDataPayload() {
  return readPrimaryInstalledWidget().then(function (widget) {
    if (!widget) {
      return buildFallbackWidgetTemplateData('setup-required');
    }

    var hostInstanceId = resolveWidgetHostInstanceId(widget);
    if (!hostInstanceId) {
      return buildFallbackWidgetTemplateData('setup-required');
    }

    return readWidgetCredentials().then(function (creds) {
      if (!creds) {
        return buildFallbackWidgetTemplateData('setup-required');
      }

      var instanceId = resolveBoundWidgetInstanceId(creds.instanceBindings, hostInstanceId);
      if (!instanceId) {
        return buildFallbackWidgetTemplateData('setup-required');
      }

      return fetchWidgetSummary(creds.supabaseUrl, creds.token, instanceId, hostInstanceId, creds.clientVersion)
        .then(function (result) {
          if (result.ok) {
            return summaryToTemplateData(result.data);
          }

          if (result.status === 401) {
            return buildFallbackWidgetTemplateData('auth-required');
          }

          return buildFallbackWidgetTemplateData('error-fallback');
        });
    });
  }).catch(function () {
    return buildFallbackWidgetTemplateData('error-fallback');
  });
}

function createWidgetDataResponse(payload) {
  return new Response(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'Pragma': 'no-cache',
    },
  });
}

function renderWidgetTemplate(widget, templateName, data) {
  return loadTemplate(templateName).then(function (template) {
    return self.widgets.updateByInstanceId(widget.instanceId, {
      template: template,
      data: data,
    });
  });
}

// ============================================================
// Widget 更新核心
// ============================================================

/**
 * 刷新指定 widget 实例
 * @param {object} widget - self.widgets API 返回的 widget 对象
 */
function refreshWidget(widget) {
  return readWidgetCredentials().then(function (creds) {
    if (!creds) {
      // D04: 无凭证 → 显示 setup-required 降级模板
      return renderWidgetTemplate(widget, 'setup-required', JSON.stringify({}));
    }

    var hostInstanceId = resolveWidgetHostInstanceId(widget);
    if (!hostInstanceId) {
      logWidgetTelemetry('widget_summary_fetch_failure', {
        platform: 'windows-pwa',
        instanceId: null,
        reason: 'instance-context-missing',
      });
      return renderWidgetTemplate(widget, 'setup-required', JSON.stringify({}));
    }

    var instanceId = resolveBoundWidgetInstanceId(creds.instanceBindings, hostInstanceId);
    if (!instanceId) {
      logWidgetTelemetry('widget_summary_fetch_failure', {
        platform: 'windows-pwa',
        instanceId: hostInstanceId,
        reason: 'instance-binding-required',
      });
      return rememberWidgetInstance(widget, true).then(function () {
        return renderWidgetTemplate(widget, 'setup-required', JSON.stringify({}));
      });
    }

    return fetchWidgetSummary(creds.supabaseUrl, creds.token, instanceId, hostInstanceId, creds.clientVersion).then(function (result) {
      if (result.ok) {
        var summaryData = result.data || {};
        if (summaryData.freshnessState && summaryData.freshnessState !== 'fresh') {
          logWidgetTelemetry('widget_stale_render', {
            platform: 'windows-pwa',
            instanceId: hostInstanceId,
            freshnessState: summaryData.freshnessState,
            trustState: summaryData.trustState,
          });
        }
        if (summaryData.trustState && summaryData.trustState !== 'verified') {
          logWidgetTelemetry('widget_untrusted_render', {
            platform: 'windows-pwa',
            instanceId: hostInstanceId,
            trustState: summaryData.trustState,
          });
        }
        // 正常数据渲染
        return renderWidgetTemplate(widget, 'focus-summary', summaryToTemplateData(result.data));
      }

      if (
        result.errorCode === 'INSTANCE_CONTEXT_REQUIRED'
        || result.errorCode === 'INSTANCE_CONTEXT_INVALID'
        || result.errorCode === 'INSTANCE_NOT_ACTIVE'
        || result.errorCode === 'INSTANCE_BINDING_MISMATCH'
      ) {
        return clearBoundWidgetInstance(hostInstanceId).then(function () {
          return rememberWidgetInstance(widget, true);
        }).then(function () {
          logWidgetTelemetry('widget_summary_fetch_failure', {
            platform: 'windows-pwa',
            instanceId: hostInstanceId,
            reason: 'instance-binding-required',
            extra: { status: result.status, code: result.errorCode || null },
          });
          return renderWidgetTemplate(widget, 'setup-required', JSON.stringify({}));
        });
      }

      // 401: token 过期或吊销 → auth-required 降级
      if (result.status === 401) {
        logWidgetTelemetry('widget_summary_fetch_failure', {
          platform: 'windows-pwa',
          instanceId: hostInstanceId,
          reason: 'auth-expired',
          extra: { status: 401, code: result.errorCode || null },
        });
        return renderWidgetTemplate(widget, 'auth-required', JSON.stringify({}));
      }

      // 服务端强制禁用 (kill switch)
      if (result.errorCode === 'WIDGET_REFRESH_DISABLED' || result.errorCode === 'WIDGET_DISABLED') {
        logWidgetTelemetry('widget_killswitch_applied', {
          platform: 'windows-pwa',
          instanceId: hostInstanceId,
          reason: result.errorCode,
          extra: { status: result.status },
        });
        logWidgetTelemetry('widget_summary_fetch_failure', {
          platform: 'windows-pwa',
          instanceId: hostInstanceId,
          reason: 'killswitch',
          extra: { status: result.status, code: result.errorCode },
        });
        return renderWidgetTemplate(widget, 'error-fallback', JSON.stringify({}));
      }

      // 429 / 503: 限流或服务不可用 → 静默降级 + 遥测
      if (result.status === 429 || result.status === 503) {
        logWidgetTelemetry('widget_summary_fetch_failure', {
          platform: 'windows-pwa',
          instanceId: hostInstanceId,
          reason: result.status === 429 ? 'rate-limited' : 'service-unavailable',
          extra: { status: result.status, code: result.errorCode || null },
        });
        return renderWidgetTemplate(widget, 'error-fallback', JSON.stringify({}));
      }

      // 其他错误 → error-fallback 降级
      logWidgetTelemetry('widget_summary_fetch_failure', {
        platform: 'windows-pwa',
        instanceId: hostInstanceId,
        reason: result.status === 0 ? 'network-error' : 'server-response',
        extra: { status: result.status, code: result.errorCode || null },
      });
      return renderWidgetTemplate(widget, 'error-fallback', JSON.stringify({}));
    });
  }).catch(function (err) {
    console.error('[WidgetRuntime] refreshWidget error:', err);
    return renderWidgetTemplate(widget, 'error-fallback', JSON.stringify({}))
      .catch(function () { /* 最终兜底：无法加载模板则静默 */ });
  });
}

/**
 * 刷新所有已安装的 widget 实例
 */
function refreshAllWidgets() {
  if (!self.widgets) return Promise.resolve();
  return self.widgets.getByTag(WIDGET_TAG).then(function (widgets) {
    if (!widgets || widgets.length === 0) return;
    return Promise.all(widgets.map(function (w) { return refreshWidget(w); }));
  }).catch(function (err) {
    console.error('[WidgetRuntime] refreshAllWidgets error:', err);
  });
}

// ============================================================
// widgetclick → 单窗口复用（D05 + D06 leader-aware）
// ============================================================

/**
 * 根据 verb 构建目标 URL
 * @param {string} verb
 * @returns {string}
 */
function buildTargetUrl(verb) {
  var base = self.registration.scope;
  // 确保以 / 结尾
  if (base.charAt(base.length - 1) !== '/') base += '/';

  switch (verb) {
    case 'open-focus':
      return base + '#/projects?entry=widget&intent=open-focus-tools';
    case 'open-blackbox':
      return base + '#/projects?entry=widget&intent=open-blackbox-recorder';
    case 'open-app':
    default:
      return base + '#/projects?entry=widget&intent=open-workspace';
  }
}

/**
 * 查找可复用的主窗口（leader-aware）
 * D06: 优先选择非 follower 的窗口（通过 URL hash 判断是否为项目主视图）
 * @returns {Promise<WindowClient | null>}
 */
function findReusableWindow() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: false }).then(function (clients) {
    if (!clients || clients.length === 0) return null;

    // 按优先级排序：
    // 1. focused + visibilityState=visible 的窗口（最可能是 leader）
    // 2. visibilityState=visible 的窗口
    // 3. 任意已存在的窗口
    var focused = null;
    var visible = null;
    var any = null;

    for (var i = 0; i < clients.length; i++) {
      var client = clients[i];
      // 只匹配包含 APP_URL_FRAGMENT 的窗口（排除 about:blank 等）
      if (client.url && client.url.indexOf(APP_URL_FRAGMENT) !== -1) {
        if (!any) any = client;
        if (client.visibilityState === 'visible') {
          if (!visible) visible = client;
          if (client.focused) {
            focused = client;
            break; // 最佳候选，无需继续
          }
        }
      }
    }

    return focused || visible || any;
  });
}

/**
 * 处理 widgetclick 事件的动作
 * D05: 先复用窗口，必要时再 openWindow()
 * D07: 只发起导航，不发起写操作
 * @param {string} verb
 * @returns {Promise<void>}
 */
function handleWidgetAction(verb) {
  var targetUrl = buildTargetUrl(verb);

  return findReusableWindow().then(function (existingClient) {
    if (existingClient) {
      // 复用已有窗口：导航 + 聚焦
      existingClient.navigate(targetUrl);
      return existingClient.focus();
    }
    // 无已有窗口：打开新窗口
    return self.clients.openWindow(targetUrl);
  }).catch(function (err) {
    console.error('[WidgetRuntime] handleWidgetAction error:', err);
    // 兜底：直接 openWindow
    return self.clients.openWindow(targetUrl);
  });
}

// ============================================================
// 主应用 postMessage 处理
// ============================================================

self.addEventListener('fetch', function (event) {
  if (!event.request || event.request.method !== 'GET') {
    return;
  }

  var requestUrl;
  try {
    requestUrl = new URL(event.request.url);
  } catch (_err) {
    return;
  }

  if (!requestUrl.pathname || !requestUrl.pathname.endsWith(WIDGET_DATA_PATH_SUFFIX)) {
    return;
  }

  event.respondWith(resolveWidgetDataPayload().then(function (payload) {
    return createWidgetDataResponse(payload);
  }));
});

self.addEventListener('message', function (event) {
  if (!event.data) return;

  // 主应用通知 Widget 刷新（业务变化时）
  if (event.data.type === 'WIDGET_REFRESH') {
    event.waitUntil(refreshAllWidgets());
  }
});

// ============================================================
// Widget 遥测事件（OBS-03/04/08/09/12）
// ----------------------------------------------------------------
// 与 Edge Function 同名事件保持一致，日志结构稳定，敏感标识符脱敏。
// 生产环境由 console.log 写入 DevTools / 采集管道；主应用可通过
// BroadcastChannel/postMessage 将这些事件转发给中心化遥测 sink。
// ============================================================
function redactWidgetId(value) {
  if (!value || typeof value !== 'string') return value || null;
  return value.length <= 8 ? value : value.slice(0, 8) + '...';
}

function logWidgetTelemetry(eventName, detail) {
  try {
    var payload = {
      ts: new Date().toISOString(),
      surface: 'web-sw',
    };
    if (detail && typeof detail === 'object') {
      if ('platform' in detail) payload.platform = detail.platform || 'windows-pwa';
      if ('instanceId' in detail) payload.instanceId = redactWidgetId(detail.instanceId);
      if ('hostId' in detail) payload.hostId = redactWidgetId(detail.hostId);
      if ('tag' in detail) payload.tag = detail.tag;
      if ('action' in detail) payload.action = detail.action;
      if ('reason' in detail) payload.reason = detail.reason;
      if ('trustState' in detail) payload.trustState = detail.trustState;
      if ('freshnessState' in detail) payload.freshnessState = detail.freshnessState;
      if ('extra' in detail) payload.extra = detail.extra;
    }
    console.log('[WidgetTelemetry] ' + eventName + ' ' + JSON.stringify(payload));
  } catch (_err) {
    // 遥测失败不得影响主路径
  }
}

// widgetinstall: 用户首次添加 Widget
self.addEventListener('widgetinstall', function (event) {
  var widget = event.widget || {};
  logWidgetTelemetry('widget_instance_install', {
    platform: 'windows-pwa',
    instanceId: widget.instanceId || null,
    hostId: widget.hostId || null,
    tag: widget.definition && widget.definition.tag,
  });
  event.waitUntil(rememberWidgetInstance(widget, false).then(function () {
    return refreshWidget(widget);
  }));
});

// widgetresume: Widget 宿主恢复时（如用户打开 Widgets Board）
self.addEventListener('widgetresume', function (event) {
  event.waitUntil(rememberWidgetInstance(event.widget, false).then(function () {
    return refreshWidget(event.widget);
  }));
});

// widgetclick: 用户与 Widget 上的 Action 交互
self.addEventListener('widgetclick', function (event) {
  var verb = (event.action && event.action.verb) || 'open-app';
  event.waitUntil(handleWidgetAction(verb));
});

// widgetuninstall: 用户移除 Widget（清理占位即可，token 由主应用管理）
self.addEventListener('widgetuninstall', function (event) {
  var widget = event.widget || {};
  logWidgetTelemetry('widget_instance_uninstall', {
    platform: 'windows-pwa',
    instanceId: widget.instanceId || null,
    hostId: widget.hostId || null,
    tag: widget.definition && widget.definition.tag,
  });
  // 无需特殊清理：token 在 IndexedDB 中由主应用生命周期管理
  event.waitUntil(forgetWidgetInstance(widget));
});

// ============================================================
// activate: SW 升级时刷新所有 Widget，防止旧模板残留
// ============================================================

self.addEventListener('activate', function (event) {
  logWidgetTelemetry('widget_sw_activate_refresh', { reason: 'sw-activate' });
  event.waitUntil(refreshAllWidgets());
});

// ============================================================
// periodicsync: 后台定期刷新
// ============================================================

self.addEventListener('periodicsync', function (event) {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(refreshAllWidgets());
  }
});




