import { extractSummaryVersionTimestamp } from '../widget-summary/summary-version.ts';

export type WidgetNotifySource = 'committed-db-webhook' | 'direct-notify';

export interface FocusHintWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

export interface FocusHintPayloadInput {
  source: WidgetNotifySource;
  eventId: string;
  deviceId: string;
  bindingGeneration: number;
  payload: FocusHintWebhookPayload;
}

export interface FocusHintPayload {
  focusActiveHint: string;
  focusSessionHint: string;
  focusRevisionMicrosHint: string;
  focusEventIdHint: string;
  focusDeviceIdHint: string;
  focusBindingGenerationHint: string;
}

export type SummaryTimestampParser = (
  value: string | null | undefined,
) => number | bigint | null;

const STRICT_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function timestampMicros(value: unknown, parseTimestamp: SummaryTimestampParser): string | null {
  if (typeof value !== 'string' || value.includes('|')) return null;
  const match = STRICT_TIMESTAMP.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return null;
  }

  const instant = parseTimestamp(value);
  if (typeof instant === 'bigint') {
    return instant.toString();
  }
  if (typeof instant !== 'number' || !Number.isSafeInteger(instant)) {
    return null;
  }

  const fractionalMicros = (match[7] ?? '').padEnd(6, '0');
  const subMillisecondMicros = BigInt(fractionalMicros.slice(3) || '0');
  return (BigInt(instant) * 1000n + subMillisecondMicros).toString();
}

export function buildFocusHintPayload(
  input: FocusHintPayloadInput,
  parseTimestamp: SummaryTimestampParser = extractSummaryVersionTimestamp,
): FocusHintPayload | null {
  if (input.source !== 'committed-db-webhook' || input.payload.table !== 'focus_sessions') {
    return null;
  }

  const row = input.payload.type === 'DELETE' ? input.payload.old_record : input.payload.record;
  if (!row) return null;

  const sessionId = normalizeText(row.id);
  const eventId = normalizeText(input.eventId);
  const deviceId = normalizeText(input.deviceId);
  const revisionMicros = timestampMicros(row.updated_at, parseTimestamp);
  if (!sessionId || !eventId || !deviceId || !revisionMicros
    || !Number.isSafeInteger(input.bindingGeneration) || input.bindingGeneration < 0) {
    return null;
  }

  let active: boolean;
  if (input.payload.type === 'DELETE') {
    active = false;
  } else if (row.ended_at === null) {
    active = true;
  } else if (timestampMicros(row.ended_at, parseTimestamp) !== null) {
    active = false;
  } else {
    return null;
  }

  return {
    focusActiveHint: String(active),
    focusSessionHint: sessionId,
    focusRevisionMicrosHint: revisionMicros,
    focusEventIdHint: eventId,
    focusDeviceIdHint: deviceId,
    focusBindingGenerationHint: String(input.bindingGeneration),
  };
}
