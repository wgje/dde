export interface WorkspaceShellCriticalFeatureFlagWarning {
  flag: string;
  risk: string;
}

export interface WorkspaceShellCriticalFeatureFlagsControllerOptions {
  validateCriticalFlags: () => readonly WorkspaceShellCriticalFeatureFlagWarning[];
  warn: (message: string, context: { flags: string[]; risks: string[] }) => void;
  warning: (title: string, message: string, options: { duration: number }) => void;
  getHostname: () => string | undefined;
}

export class WorkspaceShellCriticalFeatureFlagsController {
  constructor(private readonly options: WorkspaceShellCriticalFeatureFlagsControllerOptions) {}

  validate(): void {
    const disabledFlags = this.options.validateCriticalFlags();
    if (disabledFlags.length === 0) {
      return;
    }

    const flags = disabledFlags.map(flag => flag.flag);
    const risks = disabledFlags.map(flag => flag.risk);
    this.warn('关键安全开关被禁用', { flags, risks });

    if (this.options.getHostname() !== 'localhost') {
      return;
    }

    this.options.warning(
      '安全开关警告',
      `${disabledFlags.length} 个关键开关被禁用：${flags.join('、')}`,
      { duration: 10000 },
    );
  }

  private warn(message: string, context: { flags: string[]; risks: string[] }): void {
    try {
      this.options.warn(message, context);
    } catch {
      // Logging failures must not suppress local critical-flag visibility.
    }
  }
}
