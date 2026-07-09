const REDACTED_VALUE = '[REDACTED]';
const MAX_TELEMETRY_REDACTION_DEPTH = 6;
const MAX_EVENT_TEXT_COLLECTION_DEPTH = 3;
const MAX_EVENT_TEXT_PARTS = 80;
const SENSITIVE_TELEMETRY_STRING_KEY_PATTERN =
  '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token[_-]?hash|auth[_-]?token|api[_-]?key|apikey|code|password|passcode|secret|email)';
const NON_ACTIONABLE_EVENT_PATTERN = /chunkloaderror|failed to fetch.*chunk|loading chunk.*failed|failed to fetch dynamically imported module|jit compiler unavailable|needs to be compiled using the jit compiler|\bng0750\b|cannot read properties of undefined \(reading ['\u2018\u2019](?:factory|ondestroy)['\u2018\u2019]\)/i;
const LOCAL_DEVELOPMENT_URL_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

type SentryEventFrameLike = {
  filename?: string | null;
  absPath?: string | null;
};

type SentryEventExceptionLike = {
  type?: string | null;
  value?: string | null;
  stacktrace?: {
    frames?: SentryEventFrameLike[];
  } | null;
};

export type SentryBeforeSendEventLike = {
  message?: string | null;
  environment?: string | null;
  tags?: unknown;
  extra?: Record<string, unknown> | null;
  contexts?: Record<string, unknown> | null;
  user?: unknown;
  request?: {
    url?: string | null;
  } | null;
  exception?: {
    values?: SentryEventExceptionLike[];
  } | null;
};

export type SentryBreadcrumbLike = {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export function sanitizeBeforeSendEvent<T extends SentryBeforeSendEventLike>(event: T): T | null {
  if (shouldDropNonActionableSentryEvent(event)) {
    return null;
  }
  if (event.request?.url) {
    event.request.url = sanitizeUrlForTelemetry(event.request.url);
  }
  if (event.message) {
    event.message = sanitizeTelemetryString(event.message);
  }
  sanitizeEventExceptions(event);
  event.user = sanitizeSentryEventUser(event.user);
  event.extra = redactTelemetryRecord(event.extra);
  event.contexts = redactTelemetryRecord(event.contexts);
  return event;
}

export function sanitizeEventExceptions(event: SentryBeforeSendEventLike): void {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = sanitizeTelemetryString(exception.value);
    }
  }
}

export function sanitizeBreadcrumb<T extends SentryBreadcrumbLike>(breadcrumb: T): T {
  if (breadcrumb.message) {
    breadcrumb.message = sanitizeTelemetryString(breadcrumb.message);
  }
  sanitizeNavigationBreadcrumbData(breadcrumb);
  if (breadcrumb.data) {
    breadcrumb.data = redactTelemetryRecord(breadcrumb.data);
  }
  return breadcrumb;
}

export function sanitizeNavigationBreadcrumbData(breadcrumb: SentryBreadcrumbLike): void {
  if (breadcrumb.category !== 'navigation' || !breadcrumb.data) return;
  for (const key of ['from', 'to']) {
    if (typeof breadcrumb.data[key] === 'string') {
      breadcrumb.data[key] = sanitizeUrlForTelemetry(breadcrumb.data[key]);
    }
  }
}

export function sanitizeUrlForTelemetry(rawUrl: string): string {
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://placeholder.invalid';
    const url = new URL(rawUrl, base);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveTelemetryKey(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    return rawUrl.replace(/[?#].*$/, '');
  }
}

export function sanitizeTelemetryString(value: string): string {
  let sanitized = value.replace(/https?:\/\/[^\s"'<>]+/g, url => sanitizeUrlForTelemetry(url));
  sanitized = sanitized.replace(
    new RegExp(`\\b(${SENSITIVE_TELEMETRY_STRING_KEY_PATTERN})=([^&\\s'",}]+)`, 'gi'),
    '$1=[REDACTED]',
  );
  sanitized = sanitized.replace(
    new RegExp(`(["']?\\b${SENSITIVE_TELEMETRY_STRING_KEY_PATTERN}["']?\\s*:\\s*["']?)([^"',}\\s]+)(["']?)`, 'gi'),
    '$1[REDACTED]$3',
  );
  sanitized = sanitized.replace(
    /\b(authorization\s*[:=]\s*)(bearer|token)\s+[^\s"',}]+/gi,
    '$1$2 [REDACTED]',
  );
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    '[REDACTED_JWT]',
  );
  return sanitized.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
}

export function shouldDropNonActionableSentryEvent(event: SentryBeforeSendEventLike): boolean {
  if (isLocalDevelopmentEvent(event)) {
    return true;
  }

  const eventText = collectRecoverableEventText(event).toLowerCase();
  if (!eventText) return false;

  if (eventText.includes('browsernetworksuspendederror') || eventText.includes('browser network io suspended')) {
    return true;
  }

  return NON_ACTIONABLE_EVENT_PATTERN.test(eventText);
}

export function redactTelemetryRecord<T extends Record<string, unknown> | null | undefined>(record: T): T {
  if (!record) {
    return record;
  }
  return redactTelemetryValue(record) as T;
}

export function sanitizeSentryUser(user: { id: string; email?: string } | null): { id: string } | null {
  return user ? { id: user.id } : null;
}

export function sanitizeSentryEventUser(user: unknown): unknown {
  if (!user || typeof user !== 'object') {
    return user;
  }
  const { email: _email, ip_address: _ipAddress, username: _username, ...safeUser } =
    user as Record<string, unknown>;
  return redactTelemetryRecord(safeUser);
}

function isSensitiveTelemetryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('passcode')
    || normalized.includes('apikey')
    || normalized === 'authorization'
    || normalized.includes('email')
    || normalized === 'code';
}

function isLocalDevelopmentEvent(event: SentryBeforeSendEventLike): boolean {
  if (event.environment !== 'development') return false;
  const url = event.request?.url ?? '';
  return LOCAL_DEVELOPMENT_URL_PATTERN.test(url);
}

function collectRecoverableEventText(event: SentryBeforeSendEventLike): string {
  const parts: string[] = [];
  pushIfString(parts, event.message);
  pushIfString(parts, event.environment);
  pushIfString(parts, event.request?.url);
  collectTelemetryTextParts(parts, event.tags);
  collectTelemetryTextParts(parts, event.extra);
  for (const exception of event.exception?.values ?? []) {
    pushIfString(parts, exception.type);
    pushIfString(parts, exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      pushIfString(parts, frame.filename);
      pushIfString(parts, frame.absPath);
    }
  }
  return parts.join('\n');
}

function collectTelemetryTextParts(parts: string[], value: unknown, depth = 0): void {
  if (parts.length >= MAX_EVENT_TEXT_PARTS || depth > MAX_EVENT_TEXT_COLLECTION_DEPTH) {
    return;
  }

  if (typeof value === 'string') {
    pushIfString(parts, value);
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);

  for (const [key, nestedValue] of entries) {
    if (parts.length >= MAX_EVENT_TEXT_PARTS) {
      return;
    }
    pushIfString(parts, key);
    collectTelemetryTextParts(parts, nestedValue, depth + 1);
  }
}

function pushIfString(parts: string[], value: string | null | undefined): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    parts.push(value);
  }
}

function redactTelemetryValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_TELEMETRY_REDACTION_DEPTH) {
    return REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactTelemetryValue(item, depth + 1));
  }
  if (typeof value === 'string') {
    return sanitizeTelemetryString(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveTelemetryKey(key)) {
      redacted[key] = REDACTED_VALUE;
      continue;
    }
    redacted[key] = redactTelemetryValue(nestedValue, depth + 1);
  }
  return redacted;
}
