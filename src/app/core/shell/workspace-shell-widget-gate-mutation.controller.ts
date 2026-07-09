import type { WorkspaceShellSidebarToolsPreloadReason } from './workspace-shell-sidebar-tools.controller';

type WidgetGateMutationIntent = 'mark-gate-read' | 'mark-gate-complete';

type WidgetGateMutationResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export interface WorkspaceShellWidgetGateMutation {
  intent: WidgetGateMutationIntent;
  widgetGateEntryId: string | null;
}

export interface WorkspaceShellWidgetGateMutationControllerOptions {
  setSidebarOpen: (open: boolean) => void;
  preloadSidebarTools: (reason: WorkspaceShellSidebarToolsPreloadReason) => void;
  markAsRead: (entryId: string) => Promise<WidgetGateMutationResult>;
  markAsCompleted: (entryId: string) => Promise<WidgetGateMutationResult>;
  warn: (message: string, context: Record<string, unknown>) => void;
  info: (message: string, context: Record<string, unknown>) => void;
}

export class WorkspaceShellWidgetGateMutationController {
  constructor(private readonly options: WorkspaceShellWidgetGateMutationControllerOptions) {}

  async apply(intent: WorkspaceShellWidgetGateMutation): Promise<void> {
    const entryId = intent.widgetGateEntryId;
    if (!entryId) {
      // entry id 缺失或未通过 UUID 校验（parser 会把非法 id 归一化为 null）：
      // 网关动作无法执行，显式告警而不是静默降级，避免“用户以为已标记”却无迹可查
      this.warn('Widget gate mutation intent missing a valid entry id, falling back to sidebar', {
        intent: intent.intent,
      });
      this.options.setSidebarOpen(true);
      this.options.preloadSidebarTools('intent');
      return;
    }

    let resolved: WidgetGateMutationResult;
    try {
      resolved = await (
        intent.intent === 'mark-gate-read'
          ? this.options.markAsRead(entryId)
          : this.options.markAsCompleted(entryId)
      );
    } catch (error) {
      this.warn('Widget gate mutation failed', {
        intent: intent.intent,
        entryId,
        error,
      });
      return;
    }

    if (!resolved.ok) {
      this.warn('Widget gate mutation failed', {
        intent: intent.intent,
        entryId,
        code: resolved.error.code,
        message: resolved.error.message,
      });
      return;
    }

    this.options.info('Widget gate mutation applied', {
      intent: intent.intent,
      entryId,
    });
  }

  private warn(message: string, context: Record<string, unknown>): void {
    try {
      this.options.warn(message, context);
    } catch {
      // Warning sinks are best-effort and must not break mutation fallback paths.
    }
  }
}
