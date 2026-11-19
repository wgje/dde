import { describe, expect, it } from 'vitest';
import {
  OFFLINE_SYNC_CAPABILITIES,
  negotiateOfflineSyncCapabilities,
} from './offline-sync-capability-gate';

describe('offline-sync-capability-gate', () => {
  it('keeps the new path in shadow mode when the server probe is unavailable', () => {
    const decision = negotiateOfflineSyncCapabilities({ clientProtocolVersion: 1, server: null });
    expect(decision.mode).toBe('shadow');
    expect(decision.commandPathEnabled).toBe(false);
    expect(decision.reason).toBe('server-probe-unavailable');
  });

  it('falls back to legacy when the client is older than the server minimum', () => {
    const decision = negotiateOfflineSyncCapabilities({
      clientProtocolVersion: 1,
      server: { minProtocolVersion: 2, deploymentEpoch: 3 },
    });
    expect(decision).toMatchObject({ mode: 'legacy', compatible: false, commandPathEnabled: false });
  });

  it('uses shadow mode when the server is compatible but lacks capabilities', () => {
    const decision = negotiateOfflineSyncCapabilities({
      clientProtocolVersion: 1,
      server: { minProtocolVersion: 1, deploymentEpoch: 3, capabilities: ['command-envelope-v1'] },
    });
    expect(decision.mode).toBe('shadow');
    expect(decision.missingCapabilities).toContain('field-lww-v1');
  });

  it('requires domain application before the client can report replay as complete', () => {
    const decision = negotiateOfflineSyncCapabilities({
      clientProtocolVersion: 1,
      server: { minProtocolVersion: 1, deploymentEpoch: 3, capabilities: ['command-envelope-v1', 'field-lww-v1'] },
    });
    expect(decision.mode).toBe('shadow');
    expect(decision.missingCapabilities).toContain('domain-apply-v1');
  });

  it('enables the command path only when every required capability is explicit', () => {
    const decision = negotiateOfflineSyncCapabilities({
      clientProtocolVersion: 1,
      server: { minProtocolVersion: 1, deploymentEpoch: 3, capabilities: OFFLINE_SYNC_CAPABILITIES },
    });
    expect(decision).toEqual({
      mode: 'command',
      compatible: true,
      commandPathEnabled: true,
      missingCapabilities: [],
      reason: 'command-path-ready',
    });
  });
});
