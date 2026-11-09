export type WorkspaceShellSidebarToolsPreloadReason = 'startup' | 'p1' | 'intent';

type WorkspaceShellBlackBoxCreateResult =
  | { ok: true }
  | { ok: false; error: { message: string } };

export interface WorkspaceShellSidebarToolsControllerOptions {
  createBlackBoxEntry: (content: string) => Promise<WorkspaceShellBlackBoxCreateResult>;
  warning: (title: string, message: string) => void;
  dynamicLoadEnabled: () => boolean;
  isBlackBoxEnabled: () => boolean;
  loadFocusSessionTrigger: () => Promise<unknown>;
  loadBlackBoxRecorder: () => Promise<unknown>;
  preloadFocusMode: (reason: WorkspaceShellSidebarToolsPreloadReason) => Promise<void>;
  scheduleFocusModePreload: (reason: 'startup' | 'p1') => void;
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level: 'info';
    data: { reason: WorkspaceShellSidebarToolsPreloadReason };
  }) => void;
}

export class WorkspaceShellSidebarToolsController {
  constructor(private readonly options: WorkspaceShellSidebarToolsControllerOptions) {}

  async onVoiceTranscribed(text: string): Promise<void> {
    const content = text.trim();
    if (!content) return;

    const result = await this.options.createBlackBoxEntry(content);
    if (!result.ok) {
      this.options.warning('录音保存失败', result.error.message);
    }
  }

  onToolsIntent(): void {
    if (!this.options.dynamicLoadEnabled()) {
      return;
    }

    this.preload('intent');
  }

  preload(reason: WorkspaceShellSidebarToolsPreloadReason): void {
    void this.loadFocusSessionTriggerComponent();
    void this.preloadFocusModeAssets(reason);

    if (this.options.isBlackBoxEnabled()) {
      void this.loadBlackBoxRecorderComponent();
    }

    this.options.addBreadcrumb({
      category: 'startup',
      message: 'sidebar.tools.preload',
      level: 'info',
      data: { reason },
    });
  }

  loadFocusSessionTriggerComponent(): Promise<unknown> {
    return this.options.loadFocusSessionTrigger();
  }

  loadBlackBoxRecorderComponent(): Promise<unknown> {
    return this.options.loadBlackBoxRecorder();
  }

  preloadFocusModeAssets(reason: WorkspaceShellSidebarToolsPreloadReason): Promise<void> {
    return this.options.preloadFocusMode(reason);
  }

  scheduleFocusModePreload(reason: 'startup' | 'p1'): void {
    this.options.scheduleFocusModePreload(reason);
  }
}
