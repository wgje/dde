import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  'src/app/core/services/sync/realtime-polling.service.ts',
  'utf8',
);

describe('RealtimePollingService remote change dedup delegation', () => {
  it('delegates remote change dedup state to the dedicated controller', () => {
    expect(source).toContain('RealtimeRemoteChangeDedupController');
    expect(source).toContain('new RealtimeRemoteChangeDedupController(');
    expect(source).not.toContain('activeRemoteChangeKeys');
    expect(source).not.toContain('recentRemoteChangeKeys');
    expect(source).not.toContain('createRemoteChangeKey(');
    expect(source).not.toContain('markRecentRemoteChange(');
    expect(source).not.toContain('clearRemoteChangeDedupState(');
  });
});
