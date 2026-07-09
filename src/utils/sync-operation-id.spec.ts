import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSyncOperationId, createDerivedSyncOperationId, createSyncOperationId, isSyncOperationId } from './sync-operation-id';

const originalCrypto = globalThis.crypto;

function setCrypto(value: Crypto | undefined): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setCrypto(originalCrypto);
});

describe('createSyncOperationId', () => {
  it('uses crypto.randomUUID when available', () => {
    setCrypto({
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    } as unknown as Crypto);

    expect(createSyncOperationId()).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('falls back to crypto.getRandomValues with RFC4122 version and variant bits', () => {
    setCrypto({
      getRandomValues: (array: Uint8Array) => {
        array.fill(0);
        return array;
      },
    } as unknown as Crypto);

    expect(createSyncOperationId()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('does not fall back to Math.random when Web Crypto is unavailable', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');
    setCrypto(undefined);

    expect(() => createSyncOperationId()).toThrow('Web Crypto is required');
    expect(mathRandomSpy).not.toHaveBeenCalled();
  });
});

describe('createDerivedSyncOperationId', () => {
  it('derives a stable UUID-shaped operation id for child operations', () => {
    const first = createDerivedSyncOperationId(
      '00000000-0000-4000-8000-000000000001',
      'attachment-task-update',
    );
    const second = createDerivedSyncOperationId(
      '00000000-0000-4000-8000-000000000001',
      'attachment-task-update',
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe('00000000-0000-4000-8000-000000000001');
  });

  it('uses the purpose as a namespace so different child operations do not collide', () => {
    const source = '00000000-0000-4000-8000-000000000001';

    expect(createDerivedSyncOperationId(source, 'attachment-task-update'))
      .not.toBe(createDerivedSyncOperationId(source, 'attachment-cleanup'));
  });
});

describe('isSyncOperationId', () => {
  it('accepts UUID-shaped sync operation ids created locally or derived for child operations', () => {
    expect(isSyncOperationId('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isSyncOperationId('AAAAAAAA-AAAA-5AAA-BAAA-AAAAAAAAAAAA')).toBe(true);
  });

  it('rejects legacy short ids and malformed UUID variants before they reach RPC payloads', () => {
    expect(isSyncOperationId('op-1')).toBe(false);
    expect(isSyncOperationId('attachment-upload:00000000-0000-4000-8000-000000000001:task-update')).toBe(false);
    expect(isSyncOperationId('00000000-0000-4000-7000-000000000001')).toBe(false);
    expect(isSyncOperationId('')).toBe(false);
  });
});

describe('assertSyncOperationId', () => {
  it('throws a clear local boundary error for invalid sync operation ids', () => {
    expect(() => assertSyncOperationId('not-a-uuid')).toThrow('Invalid sync operationId');
  });
});
