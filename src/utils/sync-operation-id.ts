const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSyncOperationId(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    throw new Error('Web Crypto is required to create sync operation ids');
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function isSyncOperationId(value: unknown): value is string {
  return typeof value === 'string' && SYNC_OPERATION_ID_PATTERN.test(value);
}

export function assertSyncOperationId(value: unknown): asserts value is string {
  if (!isSyncOperationId(value)) {
    throw new Error('Invalid sync operationId: expected UUID-shaped idempotency key');
  }
}

export function createDerivedSyncOperationId(sourceOperationId: string, purpose: string): string {
  const input = `${purpose}\u0000${sourceOperationId}`;
  const bytes = new Uint8Array(16);
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];

  for (let wordIndex = 0; wordIndex < seeds.length; wordIndex += 1) {
    const word = fnv1a32(`${input}\u0000${wordIndex}`, seeds[wordIndex]);
    const offset = wordIndex * 4;
    bytes[offset] = (word >>> 24) & 0xff;
    bytes[offset + 1] = (word >>> 16) & 0xff;
    bytes[offset + 2] = (word >>> 8) & 0xff;
    bytes[offset + 3] = word & 0xff;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
