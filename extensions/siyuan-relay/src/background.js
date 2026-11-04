const DEFAULT_BASE_URL = 'http://127.0.0.1:6806';
const PREVIEW_FETCH_TIMEOUT_MS = 5000;
const ABSOLUTE_HPATH_FETCH_TIMEOUT_MS = 1200;
const MAX_PREVIEW_CHILDREN = 10;
const MAX_PREVIEW_CHARS = 1200;
const MAX_TITLE_LENGTH = 256;
const MAX_TOKEN_LENGTH = 256;
const MAX_OWNER_USER_ID_LENGTH = 128;
const OWNER_CONFIG_KEY_PREFIX = 'nanoflow.siyuan.owner.';
const LEGACY_CONFIG_KEYS = ['baseUrl', 'token'];
const ownerConfigWriteTails = new Map();
const BLOCK_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
const SIYUAN_BLOCK_REF_PATTERN = /\(\((\d{14}-[a-z0-9]{7})(?:\s+"([^"]*)")?\)\)/g;
const ALLOWED_API_PATHS = new Set([
  '/api/system/version',
  '/api/block/getBlockKramdown',
  '/api/block/getChildBlocks',
  '/api/filetree/getHPathByID',
  '/api/filetree/getHPathByPath',
  '/api/filetree/getPathByID',
  '/api/attr/getBlockAttrs',
]);

void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return buildPreviewError(message, 'unknown');
  if (message.type === 'nanoflow.siyuan.ping') {
    return { type: 'nanoflow.siyuan.pong', requestId: readRequestId(message), ok: true };
  }
  if (message.type === 'nanoflow.siyuan.test-connection') {
    return testConnection(message);
  }
  if (message.type === 'nanoflow.siyuan.get-preview') {
    return getPreview(message);
  }
  if (message.type === 'nanoflow.siyuan.set-config') {
    return setConfig(message);
  }
  if (message.type === 'nanoflow.siyuan.get-config-status') {
    return getConfigStatus(message);
  }
  return buildPreviewError(message, 'unknown');
}

async function setConfig(message) {
  const requestId = readRequestId(message);
  const ownerUserId = readOwnerUserId(message);
  const configIssuedAt = readConfigIssuedAt(message);
  if (!ownerUserId || configIssuedAt === undefined) {
    return {
      type: 'nanoflow.siyuan.set-config-result',
      requestId,
      ok: false,
      errorCode: 'not-configured',
    };
  }
  const payload = message?.payload;
  // 仅允许 payload 中出现 baseUrl/token 两个键，拒绝任何额外字段以收敛 attack surface。
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => key !== 'baseUrl' && key !== 'token')) {
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ownerUserId, ok: false, errorCode: 'unknown' };
  }
  const rawBaseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const baseUrl = rawBaseUrl || DEFAULT_BASE_URL;
  if (!isTrustedBaseUrl(baseUrl)) {
    // 复用 token-invalid 而非新增错误码：UI 在 saveSiyuanConfigToExtension 中已用同一份白名单校验过 baseUrl，
    // 走到这里说明页面被绕过（被注入脚本或调试器），此时把请求统一拒绝即可；下游 UI 的提示文案虽然偏向 token，
    // 但用户最终修复路径仍是"改 baseUrl 或 token 后重新保存"。
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ownerUserId, ok: false, errorCode: 'token-invalid' };
  }
  // 空字符串视为"清除授权"，与扩展 Options 页 clearConfig 行为一致。
  const hasTokenField = Object.prototype.hasOwnProperty.call(payload, 'token');
  const rawToken = hasTokenField && typeof payload.token === 'string' ? payload.token : undefined;
  if (rawToken !== undefined && rawToken.length > MAX_TOKEN_LENGTH) {
    return { type: 'nanoflow.siyuan.set-config-result', requestId, ownerUserId, ok: false, errorCode: 'token-invalid' };
  }
  return serializeOwnerConfigWrite(ownerUserId, async () => {
    try {
      const storageKey = ownerConfigStorageKey(ownerUserId);
      const stored = await chrome.storage.local.get([storageKey]);
      const existing = readOwnerConfigRecord(stored[storageKey], ownerUserId);
      if (existing && configIssuedAt < existing.configIssuedAt) {
        return { type: 'nanoflow.siyuan.set-config-result', requestId, ownerUserId, ok: true };
      }
      const token = hasTokenField ? rawToken ?? '' : existing?.token ?? '';
      const record = { ownerUserId, baseUrl, configIssuedAt };
      if (token) {
        record.token = token;
      }
      await chrome.storage.local.set({ [storageKey]: record });
      await chrome.storage.local.remove(LEGACY_CONFIG_KEYS);
      return { type: 'nanoflow.siyuan.set-config-result', requestId, ownerUserId, ok: true };
    } catch {
      return { type: 'nanoflow.siyuan.set-config-result', requestId, ownerUserId, ok: false, errorCode: 'unknown' };
    }
  });
}

async function getConfigStatus(message) {
  const requestId = readRequestId(message);
  const ownerUserId = readOwnerUserId(message);
  if (!ownerUserId) {
    return {
      type: 'nanoflow.siyuan.config-status-result',
      requestId,
      ok: false,
      errorCode: 'not-configured',
    };
  }
  try {
    const storageKey = ownerConfigStorageKey(ownerUserId);
    const stored = await chrome.storage.local.get([storageKey]);
    const config = readOwnerConfigRecord(stored[storageKey], ownerUserId);
    const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    const hasToken = Boolean(config?.token);
    // 仅回传 baseUrl 与 hasToken，绝不把 token 明文经 message channel 返回页面。
    return {
      type: 'nanoflow.siyuan.config-status-result',
      requestId,
      ownerUserId,
      ok: true,
      data: { baseUrl, hasToken },
    };
  } catch {
    return { type: 'nanoflow.siyuan.config-status-result', requestId, ownerUserId, ok: false, errorCode: 'unknown' };
  }
}

async function testConnection(message) {
  const ownerUserId = readOwnerUserId(message);
  if (!ownerUserId) {
    return {
      type: 'nanoflow.siyuan.test-connection-result',
      requestId: readRequestId(message),
      ok: false,
      errorCode: 'not-configured',
    };
  }
  try {
    const config = await loadConfig(ownerUserId);
    await callSiyuan(config, '/api/system/version', {});
    return {
      type: 'nanoflow.siyuan.test-connection-result',
      requestId: readRequestId(message),
      ownerUserId,
      ok: true,
    };
  } catch (error) {
    return {
      type: 'nanoflow.siyuan.test-connection-result',
      requestId: readRequestId(message),
      ownerUserId,
      ok: false,
      errorCode: mapError(error),
    };
  }
}

async function getPreview(message) {
  const requestId = readRequestId(message);
  const ownerUserId = readOwnerUserId(message);
  if (!ownerUserId) return buildPreviewError(message, 'not-configured');
  const blockId = message?.payload?.blockId;
  if (typeof blockId !== 'string' || !BLOCK_ID_PATTERN.test(blockId)) {
    return buildPreviewError(message, 'block-not-found');
  }

  const includeChildren = message.payload.includeChildren !== false;
  const maxChildren = clampInteger(message.payload.maxChildren, 0, MAX_PREVIEW_CHILDREN);
  const maxChars = clampInteger(message.payload.maxChars, 1, MAX_PREVIEW_CHARS);

  try {
    const config = await loadConfig(ownerUserId);
    const [kramdown, hpath, absoluteHpath, attrs, children] = await Promise.all([
      callSiyuan(config, '/api/block/getBlockKramdown', { id: blockId }),
      callSiyuan(config, '/api/filetree/getHPathByID', { id: blockId }).catch(() => undefined),
      readAbsoluteHPath(config, blockId),
      callSiyuan(config, '/api/attr/getBlockAttrs', { id: blockId }).catch(() => undefined),
      includeChildren
        ? callSiyuan(config, '/api/block/getChildBlocks', { id: blockId }).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (!kramdown || typeof kramdown !== 'object') throw new RelayError('block-not-found');
    if (typeof kramdown.id === 'string' && kramdown.id !== blockId) throw new RelayError('block-not-found');
    const childBlocks = await buildChildBlocks(config, children, maxChildren);
    const plainText = toPlainText(typeof kramdown.kramdown === 'string' ? kramdown.kramdown : '');
    const truncatedText = plainText.length > maxChars ? `${plainText.slice(0, maxChars).trim()}…` : plainText;

    return {
      type: 'nanoflow.siyuan.preview-result',
      requestId,
      ownerUserId,
      ok: true,
      data: {
        blockId,
        title: readTitle(attrs),
        hpath: pickMostSpecificHPath(absoluteHpath, readHPath(hpath)),
        plainText: truncatedText,
        kramdown: truncateString(kramdown.kramdown, maxChars * 2),
        sourceUpdatedAt: readSourceUpdatedAt(attrs),
        childBlocks,
        truncated: plainText.length > maxChars || childBlocks.length >= maxChildren,
      },
    };
  } catch (error) {
    return buildPreviewError(message, mapError(error));
  }
}

async function readAbsoluteHPath(config, blockId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABSOLUTE_HPATH_FETCH_TIMEOUT_MS);
  try {
    const pathData = await callSiyuan(config, '/api/filetree/getPathByID', { id: blockId }, controller.signal);
    const notebook = normalizeString(pathData?.notebook);
    const path = normalizeString(pathData?.path);
    if (!notebook || !path) return undefined;
    return readHPath(await callSiyuan(config, '/api/filetree/getHPathByPath', { notebook, path }, controller.signal));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function loadConfig(ownerUserId) {
  const storageKey = ownerConfigStorageKey(ownerUserId);
  const stored = await chrome.storage.local.get([storageKey]);
  const config = readOwnerConfigRecord(stored[storageKey], ownerUserId);
  if (!config?.token) throw new RelayError('not-configured');
  return { baseUrl: config.baseUrl, token: config.token };
}

function ownerConfigStorageKey(ownerUserId) {
  return `${OWNER_CONFIG_KEY_PREFIX}${encodeURIComponent(ownerUserId)}`;
}

function serializeOwnerConfigWrite(ownerUserId, operation) {
  const previous = ownerConfigWriteTails.get(ownerUserId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tracked = current.finally(() => {
    if (ownerConfigWriteTails.get(ownerUserId) === tracked) {
      ownerConfigWriteTails.delete(ownerUserId);
    }
  });
  ownerConfigWriteTails.set(ownerUserId, tracked);
  return tracked;
}

function readOwnerConfigRecord(value, ownerUserId) {
  if (!value || typeof value !== 'object' || value.ownerUserId !== ownerUserId) return undefined;
  const baseUrl = typeof value.baseUrl === 'string' && isTrustedBaseUrl(value.baseUrl)
    ? value.baseUrl
    : DEFAULT_BASE_URL;
  const token = typeof value.token === 'string' && value.token.length <= MAX_TOKEN_LENGTH
    ? value.token
    : '';
  const configIssuedAt = Number.isSafeInteger(value.configIssuedAt) && value.configIssuedAt > 0
    ? value.configIssuedAt
    : 0;
  return { baseUrl, token, configIssuedAt };
}

function isTrustedBaseUrl(value) {
  try {
    const url = new URL(value);
    return (url.origin === 'http://127.0.0.1:6806' || url.origin === 'http://localhost:6806')
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

async function callSiyuan(config, path, body, signal) {
  if (!ALLOWED_API_PATHS.has(path)) throw new RelayError('unknown');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const abortListener = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS);
  signal?.addEventListener('abort', abortListener, { once: true });
  try {
    const response = await fetch(new URL(path, config.baseUrl).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new RelayError('token-invalid');
    if (!response.ok) throw new RelayError('kernel-unreachable');
    const json = await response.json();
    if (json?.code && json.code !== 0) throw new RelayError(mapSiyuanCode(json.msg));
    return json?.data;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new RelayError('kernel-unreachable');
    throw new RelayError('kernel-unreachable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortListener);
  }
}

async function buildChildBlocks(config, rawChildren, maxChildren) {
  if (!Array.isArray(rawChildren) || maxChildren <= 0) return [];
  const children = rawChildren
    .filter((child) => typeof child?.id === 'string' && BLOCK_ID_PATTERN.test(child.id))
    .slice(0, maxChildren);
  return Promise.all(children.map(async (child) => {
    const content = typeof child.content === 'string' || typeof child.markdown === 'string'
      ? child.content ?? child.markdown
      : await callSiyuan(config, '/api/block/getBlockKramdown', { id: child.id })
        .then((data) => typeof data?.kramdown === 'string' ? data.kramdown : '')
        .catch(() => '');
    return {
      id: child.id,
      type: typeof child.type === 'string' ? truncateString(child.type, 32) : 'unknown',
      content: truncateString(toPlainText(content), 240),
    };
  }));
}

function readHPath(value) {
  if (typeof value === 'string') return normalizeHPath(value);
  if (typeof value?.hPath === 'string') return normalizeHPath(value.hPath);
  return undefined;
}

function pickMostSpecificHPath(...values) {
  return values
    .map(normalizeHPath)
    .filter(Boolean)
    .sort((a, b) => hpathScore(b) - hpathScore(a))[0];
}

function hpathScore(value) {
  return value.split('/').filter(Boolean).length * 1000 + value.length;
}

function normalizeHPath(value) {
  const text = normalizeString(value);
  if (!text) return undefined;
  return truncateString(text.startsWith('/') ? text : `/${text}`, 1024);
}

function readTitle(value) {
  if (typeof value?.title !== 'string') return undefined;
  const title = value.title.trim();
  return title ? truncateString(title, MAX_TITLE_LENGTH) : undefined;
}

function readSourceUpdatedAt(value) {
  if (typeof value?.updatedAt === 'string') return truncateString(value.updatedAt, 64);
  if (typeof value?.updated === 'string') return truncateString(value.updated, 64);
  return undefined;
}

function toPlainText(kramdown) {
  return String(kramdown)
    .replace(/\{:\s*[^}]+\}/g, '')
    .replace(SIYUAN_BLOCK_REF_PATTERN, (_match, blockId, label) => label || blockId)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#\-[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizeString(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return max;
  return Math.max(min, Math.min(number, max));
}

function readRequestId(message) {
  return typeof message?.requestId === 'string' ? message.requestId : crypto.randomUUID();
}

function readOwnerUserId(message) {
  const value = message?.ownerUserId;
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OWNER_USER_ID_LENGTH
    ? value
    : undefined;
}

function readConfigIssuedAt(message) {
  const value = message?.configIssuedAt;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function buildPreviewError(message, errorCode) {
  return {
    type: 'nanoflow.siyuan.preview-result',
    requestId: readRequestId(message),
    ownerUserId: readOwnerUserId(message),
    ok: false,
    errorCode,
  };
}

function mapSiyuanCode(message) {
  const value = String(message ?? '').toLowerCase();
  if (value.includes('token') || value.includes('unauthorized')) return 'token-invalid';
  if (value.includes('not found') || value.includes('不存在')) return 'block-not-found';
  return 'unknown';
}

function mapError(error) {
  if (error instanceof RelayError) return error.code;
  return 'unknown';
}

class RelayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
