import { describe, expect, it } from 'vitest';

import {
  classifyLocalPersistRoute,
  classifyRemotePersistRoute,
} from './sync-coordinator-persist-routing.helpers';

describe('sync coordinator persist routing helpers', () => {
  it('classifies local persist routes before cloud persistence is attempted', () => {
    expect(classifyLocalPersistRoute({
      hasUserId: false,
      hasExistingConflict: false,
      syncSource: 'synced',
    })).toBe('missing-user');

    expect(classifyLocalPersistRoute({
      hasUserId: true,
      hasExistingConflict: true,
      syncSource: 'synced',
    })).toBe('existing-conflict');

    expect(classifyLocalPersistRoute({
      hasUserId: true,
      hasExistingConflict: false,
      syncSource: 'local-only',
    })).toBe('local-only');

    expect(classifyLocalPersistRoute({
      hasUserId: true,
      hasExistingConflict: false,
      syncSource: 'synced',
    })).toBe('remote');
  });

  it('classifies remote save results in the same priority order as the service side effects', () => {
    expect(classifyRemotePersistRoute({
      success: true,
      conflict: true,
      validationWarnings: ['warning'],
    })).toBe('success');

    expect(classifyRemotePersistRoute({
      success: false,
      conflict: true,
      validationWarnings: ['warning'],
    })).toBe('conflict');

    expect(classifyRemotePersistRoute({
      success: false,
      conflict: false,
      validationWarnings: ['warning'],
    })).toBe('validation-failure');

    expect(classifyRemotePersistRoute({
      success: false,
      conflict: false,
      validationWarnings: [],
    })).toBe('partial-failure');

    expect(classifyRemotePersistRoute({
      success: false,
      conflict: false,
    })).toBe('partial-failure');
  });
});
