import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workspace shell focus sync pulse controller hosts', () => {
  it('owns pulse controller construction outside the main hosts factory', async () => {
    const modulePath = './workspace-shell-focus-sync-pulse-controller-hosts.factory';
    const pulseHostsModule = await import(/* @vite-ignore */ modulePath)
      .catch(() => ({}));

    expect(pulseHostsModule).toHaveProperty(
      'createWorkspaceShellFocusSyncPulseControllerHosts',
      expect.any(Function),
    );

    const pulseHostsSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-pulse-controller-hosts.factory.ts'),
      'utf8',
    );
    const hostsSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-controller-hosts.factory.ts'),
      'utf8',
    );

    expect(pulseHostsSource).toContain('createSyncPulseLifecycleRef');
    expect(pulseHostsSource).toContain('WorkspaceShellFocusEntrySyncPulseController');
    expect(pulseHostsSource).toContain('WorkspaceShellSyncPulseLifecycleController');
    expect(hostsSource).not.toContain('createSyncPulseLifecycleRef');
    expect(hostsSource).not.toContain('WorkspaceShellFocusEntrySyncPulseController');
    expect(hostsSource).not.toContain('WorkspaceShellSyncPulseLifecycleController');
    expect(hostsSource).not.toContain('SyncPulseEngineService');
  });
});
