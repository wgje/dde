export function normalizeWidgetLimitNumber(
  value: unknown,
  fallback: number,
  allowZero = false,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const coerced = Math.trunc(value);
  if (allowZero) {
    return coerced >= 0 ? coerced : fallback;
  }

  return coerced > 0 ? coerced : fallback;
}

export function normalizeWidgetWebhookSecret(rawValue: string | null): string | null {
  if (!rawValue) return null;
  const trimmed = rawValue.trim();
  return trimmed.replace(/^v1,whsec_/, '') || null;
}

export function buildWidgetWebhookSigningMessage(
  eventId: string,
  timestamp: string,
  rawBody: string,
): string {
  return `${eventId}.${timestamp}.${rawBody}`;
}
