import { describe, expect, it } from 'vitest';

import { isStaleDirectoryHandleError } from './local-backup-directory-handle.helpers';

describe('local-backup-directory-handle.helpers', () => {
  it('detects stale directory handle InvalidStateError messages', () => {
    expect(isStaleDirectoryHandleError(new DOMException(
      'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.',
      'InvalidStateError'
    ))).toBe(true);
    expect(isStaleDirectoryHandleError(new Error('network failed'))).toBe(false);
    expect(isStaleDirectoryHandleError(null)).toBe(false);
  });
});
