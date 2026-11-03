const BUILTIN_ALLOWED_ORIGINS = new Set([
  'https://nanoflow.app',
  'https://www.nanoflow.app',
  'https://nanoflow.pages.dev',
  'https://dde-eight.vercel.app',
]);

const ALLOWED_MESSAGE_TYPES = new Set([
  'nanoflow.siyuan.ping',
  'nanoflow.siyuan.v3.get-preview',
  'nanoflow.siyuan.v3.test-connection',
  'nanoflow.siyuan.v3.set-config',
  'nanoflow.siyuan.v3.get-config-status',
]);

function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    if (BUILTIN_ALLOWED_ORIGINS.has(url.origin)) return true;
    return false;
  } catch {
    return false;
  }
}

function responseTypeFor(messageType) {
  if (messageType === 'nanoflow.siyuan.ping') return 'nanoflow.siyuan.pong';
  if (messageType === 'nanoflow.siyuan.v3.test-connection') return 'nanoflow.siyuan.v3.test-connection-result';
  if (messageType === 'nanoflow.siyuan.v3.set-config') return 'nanoflow.siyuan.v3.set-config-result';
  if (messageType === 'nanoflow.siyuan.v3.get-config-status') return 'nanoflow.siyuan.v3.config-status-result';
  return 'nanoflow.siyuan.v3.preview-result';
}

function buildErrorResponse(message, errorCode = 'unknown') {
  return {
    type: responseTypeFor(message?.type),
    requestId: typeof message?.requestId === 'string' ? message.requestId : '',
    ok: false,
    errorCode,
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isAllowedOrigin(event.origin)) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || !ALLOWED_MESSAGE_TYPES.has(message.type)) return;

  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      window.postMessage(buildErrorResponse(message, 'extension-unavailable'), event.origin);
      return;
    }
    window.postMessage(response ?? buildErrorResponse(message), event.origin);
  });
});
