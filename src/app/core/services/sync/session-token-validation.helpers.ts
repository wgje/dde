export interface SessionTokenValidationResult {
  valid: boolean;
  expiresAt?: number;
  error?: string;
  remainingMs?: number;
}

export function validateSessionTokenSignature(
  token: string,
  nowMs = Date.now(),
): SessionTokenValidationResult {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'invalid-token-format' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'malformed-jwt' };
  }

  const payload = decodeBase64UrlJson(parts[1]);
  if (!payload) {
    return { valid: false, error: 'invalid-payload' };
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (!exp) {
    return { valid: false, error: 'missing-exp' };
  }

  const expiresAtMs = exp * 1000;
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs < 0) {
    return { valid: false, expiresAt: exp, error: 'token-expired' };
  }

  return { valid: true, expiresAt: exp, remainingMs };
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | undefined {
  if (!segment) return undefined;

  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = normalized.length % 4;
  const padded = paddingLength === 0
    ? normalized
    : `${normalized}${'='.repeat(4 - paddingLength)}`;

  try {
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
