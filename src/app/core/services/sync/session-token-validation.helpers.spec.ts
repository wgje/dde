import { describe, expect, it } from 'vitest';

import { validateSessionTokenSignature } from './session-token-validation.helpers';

function encodeJwtPayload(payload: Record<string, unknown>): string {
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `header.${encodedPayload}.signature`;
}

describe('validateSessionTokenSignature', () => {
  it('rejects malformed tokens', () => {
    expect(validateSessionTokenSignature('', 1000)).toEqual({
      valid: false,
      error: 'invalid-token-format',
    });
    expect(validateSessionTokenSignature('not-a-jwt', 1000)).toEqual({
      valid: false,
      error: 'malformed-jwt',
    });
  });

  it('rejects missing or expired exp claims', () => {
    expect(validateSessionTokenSignature(encodeJwtPayload({ sub: 'user-1' }), 1000))
      .toEqual({ valid: false, error: 'missing-exp' });
    expect(validateSessionTokenSignature(encodeJwtPayload({ exp: 1 }), 2000))
      .toEqual({ valid: false, expiresAt: 1, error: 'token-expired' });
  });

  it('rejects tokens with undecodable payloads', () => {
    expect(validateSessionTokenSignature('header.not-json.signature', 1000))
      .toEqual({ valid: false, error: 'invalid-payload' });
  });

  it('returns expiry details for valid tokens', () => {
    expect(validateSessionTokenSignature(encodeJwtPayload({ exp: 10 }), 2000))
      .toEqual({ valid: true, expiresAt: 10, remainingMs: 8000 });
  });
});
