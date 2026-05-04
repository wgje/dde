const BUILTIN_ALLOWED_ORIGINS = new Set([
  'https://nanoflow.app',
  'https://nanoflow.pages.dev',
  'https://dde-eight.vercel.app',
  'http://localhost',
  'http://127.0.0.1',
]);

const ALLOWED_MESSAGE_TYPES = new Set([
  'nanoflow.siyuan.ping',
  'nanoflow.siyuan.get-preview',
  'nanoflow.siyuan.test-connection',
]);

function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return BUILTIN_ALLOWED_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

function buildErrorResponse(message, errorCode = 'unknown') {
  return {
    type: 'nanoflow.siyuan.preview-result',
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
