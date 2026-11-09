import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workspace shell focus sync startup controller hosts', () => {
  it('owns startup-facing controller construction outside the main hosts factory', async () => {
    const modulePath = './workspace-shell-focus-sync-startup-controller-hosts.factory';
    const startupHostsModule = await import(/* @vite-ignore */ modulePath)
      .catch(() => ({}));

    expect(startupHostsModule).toHaveProperty(
      'createWorkspaceShellFocusSyncStartupControllerHosts',
      expect.any(Function),
    );

    const startupHostsSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-startup-controller-hosts.factory.ts'),
      'utf8',
    );
    const hostsSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-controller-hosts.factory.ts'),
      'utf8',
    );

    expect(startupHostsSource).toContain('WorkspaceShellMobileFocusGateController');
    expect(startupHostsSource).toContain('WorkspaceShellFocusProbeController');
    expect(startupHostsSource).toContain('WorkspaceShellStartupTierHydrationController');
    expect(hostsSource).not.toContain('WorkspaceShellMobileFocusGateController');
    expect(hostsSource).not.toContain('WorkspaceShellFocusProbeController');
    expect(hostsSource).not.toContain('WorkspaceShellStartupTierHydrationController');
  });
});
