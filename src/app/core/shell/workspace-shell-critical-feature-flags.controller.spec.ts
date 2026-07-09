import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellCriticalFeatureFlagsController,
  type WorkspaceShellCriticalFeatureFlagWarning,
} from './workspace-shell-critical-feature-flags.controller';

function createController(overrides: {
  disabledFlags?: readonly WorkspaceShellCriticalFeatureFlagWarning[];
  hostname?: string;
} = {}) {
  const disabledFlags = overrides.disabledFlags ?? [];
  const warn = vi.fn();
  const warning = vi.fn();
  const controller = new WorkspaceShellCriticalFeatureFlagsController({
    validateCriticalFlags: () => disabledFlags,
    warn,
    warning,
    getHostname: () => overrides.hostname,
  });

  return { controller, warn, warning };
}

describe('WorkspaceShellCriticalFeatureFlagsController', () => {
  it('does not warn when every critical flag is enabled', () => {
    const { controller, warn, warning } = createController();

    controller.validate();

    expect(warn).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('reports disabled critical flags through the shell logger', () => {
    const { controller, warn } = createController({
      disabledFlags: [
        { flag: 'SYNC_STRICT_SUCCESS_ENABLED', risk: '同步失败可能被误判为成功' },
        { flag: 'LOGOUT_CLEANUP_ENABLED', risk: '登出时不清理本地数据' },
      ],
    });

    controller.validate();

    expect(warn).toHaveBeenCalledWith('关键安全开关被禁用', {
      flags: ['SYNC_STRICT_SUCCESS_ENABLED', 'LOGOUT_CLEANUP_ENABLED'],
      risks: ['同步失败可能被误判为成功', '登出时不清理本地数据'],
    });
  });

  it('shows a development toast on localhost when critical flags are disabled', () => {
    const { controller, warning } = createController({
      disabledFlags: [
        { flag: 'SYNC_STRICT_SUCCESS_ENABLED', risk: '同步失败可能被误判为成功' },
      ],
      hostname: 'localhost',
    });

    controller.validate();

    expect(warning).toHaveBeenCalledWith(
      '安全开关警告',
      '1 个关键开关被禁用：SYNC_STRICT_SUCCESS_ENABLED',
      { duration: 10000 },
    );
  });

  it('continues validation when warning about disabled critical flags fails', () => {
    const { controller, warn, warning } = createController({
      disabledFlags: [
        { flag: 'SYNC_STRICT_SUCCESS_ENABLED', risk: '同步失败可能被误判为成功' },
      ],
      hostname: 'localhost',
    });
    const warningError = new Error('warning sink failed');
    warn.mockImplementationOnce(() => {
      throw warningError;
    });

    expect(() => controller.validate()).not.toThrow();

    expect(warn).toHaveBeenCalledWith('关键安全开关被禁用', {
      flags: ['SYNC_STRICT_SUCCESS_ENABLED'],
      risks: ['同步失败可能被误判为成功'],
    });
    expect(warning).toHaveBeenCalledWith(
      '安全开关警告',
      '1 个关键开关被禁用：SYNC_STRICT_SUCCESS_ENABLED',
      { duration: 10000 },
    );
  });
});
