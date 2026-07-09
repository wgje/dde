import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  WorkspaceShellCriticalFeatureFlagsDelegate,
  WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
} from './workspace-shell-critical-feature-flags-lazy-load-delegate.factory';

type CriticalFeatureFlagsDelegatesFactoryModule = {
  createWorkspaceShellCriticalFeatureFlagsDelegates?: unknown;
};

type CriticalFeatureFlagsDelegatesFactory = (options: {
  toast: {
    warning: (
      title: string,
      message: string,
      options: { duration: number },
    ) => void;
  };
  warn: (message: string, context: unknown) => void;
  getHostname?: () => string | undefined;
  createCriticalFeatureFlagsLazyLoad: (
    options: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
  ) => WorkspaceShellCriticalFeatureFlagsDelegate;
}) => WorkspaceShellCriticalFeatureFlagsDelegate;

async function loadFactoryModule(): Promise<CriticalFeatureFlagsDelegatesFactoryModule> {
  try {
    const modulePath = './workspace-shell-critical-feature-flags-delegates.factory';
    return await import(/* @vite-ignore */ modulePath) as CriticalFeatureFlagsDelegatesFactoryModule;
  } catch {
    return {};
  }
}

function requireFactory(
  createWorkspaceShellCriticalFeatureFlagsDelegates: unknown,
): CriticalFeatureFlagsDelegatesFactory {
  expect(createWorkspaceShellCriticalFeatureFlagsDelegates).toBeTypeOf('function');
  return createWorkspaceShellCriticalFeatureFlagsDelegates as CriticalFeatureFlagsDelegatesFactory;
}

describe('createWorkspaceShellCriticalFeatureFlagsDelegates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the critical feature flags lazy validator behind a dynamic import boundary', async () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-critical-feature-flags-delegates.factory.ts'),
      'utf8',
    );

    expect(source).not.toMatch(
      /import\s+(?!type\b)[\s\S]*from\s+['"]\.\/workspace-shell-critical-feature-flags-lazy-load-delegate\.factory['"]/,
    );
    expect(source).toContain(
      "import('./workspace-shell-critical-feature-flags-lazy-load-delegate.factory')",
    );
  });

  it('adapts shell toast and hostname overrides into lazy-load options', async () => {
    const { createWorkspaceShellCriticalFeatureFlagsDelegates } =
      await loadFactoryModule();
    const createCriticalFeatureFlagsDelegates = requireFactory(
      createWorkspaceShellCriticalFeatureFlagsDelegates,
    );
    const criticalFeatureFlags = {
      validate: vi.fn(),
    } satisfies WorkspaceShellCriticalFeatureFlagsDelegate;
    let receivedOptions!: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions;
    const toast = {
      warning: vi.fn(),
    };
    const warn = vi.fn();

    const delegate = createCriticalFeatureFlagsDelegates({
      toast,
      warn,
      getHostname: () => 'workspace.example',
      createCriticalFeatureFlagsLazyLoad: vi.fn(options => {
        receivedOptions = options;
        return criticalFeatureFlags;
      }),
    });

    expect(delegate).toBe(criticalFeatureFlags);
    receivedOptions.warning('Flag warning', 'Safety flag disabled', {
      duration: 1000,
    });
    expect(toast.warning).toHaveBeenCalledWith(
      'Flag warning',
      'Safety flag disabled',
      { duration: 1000 },
    );
    expect(receivedOptions.getHostname()).toBe('workspace.example');
    expect(receivedOptions.warn).toBe(warn);
  });

  it('uses the browser hostname as the default lazy-load hostname source', async () => {
    vi.stubGlobal('window', {
      location: {
        hostname: 'browser.example',
      },
    });
    const { createWorkspaceShellCriticalFeatureFlagsDelegates } =
      await loadFactoryModule();
    const createCriticalFeatureFlagsDelegates = requireFactory(
      createWorkspaceShellCriticalFeatureFlagsDelegates,
    );
    let receivedOptions!: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions;

    createCriticalFeatureFlagsDelegates({
      toast: {
        warning: vi.fn(),
      },
      warn: vi.fn(),
      createCriticalFeatureFlagsLazyLoad: vi.fn(options => {
        receivedOptions = options;
        return {
          validate: vi.fn(),
        };
      }),
    });

    expect(receivedOptions.getHostname()).toBe('browser.example');
  });
});
