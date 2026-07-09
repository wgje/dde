import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';

export type WorkspaceStartupEntryIntentAction =
  | { kind: 'none' }
  | { kind: 'widget-gate-mutation' }
  | { kind: 'open-sidebar-tools'; loadBlackBoxRecorder: boolean };

export interface WorkspaceStartupEntryIntentOptions {
  blackBoxEnabled: boolean;
}

export function resolveWorkspaceStartupEntryIntentAction(
  startupEntryIntent: StartupEntryIntent,
  options: WorkspaceStartupEntryIntentOptions,
): WorkspaceStartupEntryIntentAction {
  if (
    startupEntryIntent.intent === 'mark-gate-read'
    || startupEntryIntent.intent === 'mark-gate-complete'
  ) {
    return { kind: 'widget-gate-mutation' };
  }

  if (
    startupEntryIntent.intent !== 'open-focus-tools'
    && startupEntryIntent.intent !== 'open-blackbox-recorder'
  ) {
    return { kind: 'none' };
  }

  return {
    kind: 'open-sidebar-tools',
    loadBlackBoxRecorder: startupEntryIntent.intent === 'open-blackbox-recorder'
      && options.blackBoxEnabled,
  };
}
