import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { resolveWorkspaceStartupEntryIntentAction } from './workspace-shell-startup-intent.helpers';
import type {
  WorkspaceShellStartupWidgetGateMutationEffectContext,
  WorkspaceShellStartupWidgetGateMutationEffectInput,
} from './workspace-shell-startup-widget-gate-mutation-effect.controller';

export type WorkspaceShellStartupEntryDeferredClearOwner = 'caller' | 'mutation-effect';

export interface WorkspaceShellStartupWidgetGateMutationEffectDelegate {
  apply(
    input: WorkspaceShellStartupWidgetGateMutationEffectInput,
    context: WorkspaceShellStartupWidgetGateMutationEffectContext | null,
  ): void;
  teardown(): void;
}

export interface WorkspaceShellStartupEntryActionControllerOptions {
  isBlackBoxEnabled: () => boolean;
  setSidebarOpen: (open: boolean) => void;
  preloadSidebarTools: (reason: 'intent') => void;
  activateSidebarTools: () => void;
  loadBlackBoxRecorder: () => Promise<void> | void;
  primeWidgetWorkspaceGateSync: (startupEntryIntent: StartupEntryIntent) => void;
  mutationEffect: WorkspaceShellStartupWidgetGateMutationEffectDelegate;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupEntryActionController {
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellStartupEntryActionControllerOptions) {}

  apply(
    startupEntryIntent: StartupEntryIntent,
    mutationContext: WorkspaceShellStartupWidgetGateMutationEffectContext | null,
  ): WorkspaceShellStartupEntryDeferredClearOwner {
    if (this.isTornDown) {
      return 'caller';
    }

    this.options.primeWidgetWorkspaceGateSync(startupEntryIntent);
    const action = resolveWorkspaceStartupEntryIntentAction(startupEntryIntent, {
      blackBoxEnabled: this.options.isBlackBoxEnabled(),
    });

    switch (action.kind) {
      case 'widget-gate-mutation':
        this.options.mutationEffect.apply({
          intent: startupEntryIntent.intent === 'mark-gate-read'
            ? 'mark-gate-read'
            : 'mark-gate-complete',
          widgetGateEntryId: startupEntryIntent.widgetGateEntryId,
        }, mutationContext);
        return 'mutation-effect';
      case 'open-sidebar-tools':
        this.options.setSidebarOpen(true);
        this.options.activateSidebarTools();
        this.options.preloadSidebarTools('intent');
        if (action.loadBlackBoxRecorder) {
          this.loadBlackBoxRecorder();
        }
        return 'caller';
      case 'none':
        return 'caller';
    }
  }

  teardown(): void {
    this.isTornDown = true;
    this.options.mutationEffect.teardown();
  }

  private loadBlackBoxRecorder(): void {
    try {
      void Promise.resolve(this.options.loadBlackBoxRecorder()).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        this.warn('Startup entry black box recorder preload failed', error);
      });
    } catch (error) {
      this.warn('Startup entry black box recorder preload failed', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not re-enter startup action effects.
    }
  }
}
