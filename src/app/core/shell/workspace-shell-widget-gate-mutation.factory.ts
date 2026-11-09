import { WorkspaceShellWidgetGateMutationController } from './workspace-shell-widget-gate-mutation.controller';
import type { WorkspaceShellSidebarToolsPreloadReason } from './workspace-shell-sidebar-tools.controller';

interface WorkspaceShellBooleanSignal {
  set(value: boolean): void;
}

interface WorkspaceShellWidgetGateBlackBoxService {
  markAsRead(entryId: string): { ok: true } | { ok: false; error: { code: string; message: string } };
  markAsReadDurably(entryId: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
  markAsCompleted(entryId: string): { ok: true } | { ok: false; error: { code: string; message: string } };
  markAsCompletedDurably(entryId: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
}

interface WorkspaceShellWidgetGateLogger {
  info(message: string, context: Record<string, unknown>): void;
}

export interface WorkspaceShellWidgetGateMutationFactoryOptions {
  sidebarOpen: WorkspaceShellBooleanSignal;
  preloadSidebarTools: (reason: WorkspaceShellSidebarToolsPreloadReason) => void;
  blackBoxService: WorkspaceShellWidgetGateBlackBoxService;
  logger: WorkspaceShellWidgetGateLogger;
  warn: (message: string, context: Record<string, unknown>) => void;
}

export function createWorkspaceShellWidgetGateMutationController(
  options: WorkspaceShellWidgetGateMutationFactoryOptions,
): WorkspaceShellWidgetGateMutationController {
  return new WorkspaceShellWidgetGateMutationController({
    setSidebarOpen: (open) => options.sidebarOpen.set(open),
    preloadSidebarTools: options.preloadSidebarTools,
    markAsRead: (entryId) => options.blackBoxService.markAsReadDurably(entryId),
    markAsCompleted: (entryId) =>
      options.blackBoxService.markAsCompletedDurably(entryId),
    warn: options.warn,
    info: (message, context) => options.logger.info(message, context),
  });
}
