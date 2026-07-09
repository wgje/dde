import { extractErrorMessage } from './result';

type SupabaseFunctionErrorContext = {
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractEnvelopeMessage(value: unknown): string | null {
  const directText = normalizeText(value);
  if (directText) {
    return directText;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ['error', 'message', 'details']) {
    const fieldMessage = extractEnvelopeMessage(value[key]);
    if (fieldMessage) {
      return fieldMessage;
    }
  }

  return null;
}

function readFunctionsErrorContext(error: unknown): SupabaseFunctionErrorContext | null {
  if (!isRecord(error)) {
    return null;
  }

  const context = error['context'];
  if (!isRecord(context)) {
    return null;
  }

  return {
    json: typeof context['json'] === 'function'
      ? (context['json'] as () => Promise<unknown>)
      : undefined,
    text: typeof context['text'] === 'function'
      ? (context['text'] as () => Promise<string>)
      : undefined,
  };
}

/**
 * 读取 FunctionsHttpError 携带的 HTTP status（error.context 是原始 Response）。
 * 非 HTTP 错误（fetch/relay/超时）返回 null。
 */
export function readSupabaseFunctionErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  const context = error['context'];
  if (!isRecord(context)) {
    return null;
  }

  const status = context['status'];
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

export async function extractSupabaseFunctionErrorMessage(
  error: unknown,
  fallbackMessage: string,
): Promise<string> {
  const context = readFunctionsErrorContext(error);
  if (context?.json) {
    try {
      const body = await context.json();
      const bodyMessage = extractEnvelopeMessage(body);
      if (bodyMessage) {
        return bodyMessage;
      }
    } catch {
      // Fall through to text/message fallback.
    }
  }

  if (context?.text) {
    try {
      const textMessage = normalizeText(await context.text());
      if (textMessage) {
        return textMessage;
      }
    } catch {
      // Fall through to message fallback.
    }
  }

  const message = extractErrorMessage(error);
  return message && message !== '[object Object]' ? message : fallbackMessage;
}
