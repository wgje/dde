import { describe, expect, it } from 'vitest';

import { resolveWorkspaceStartupEntryIntentAction } from './workspace-shell-startup-intent.helpers';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';

function startupIntent(input: Partial<StartupEntryIntent>): StartupEntryIntent {
  return {
    entry: 'shortcut',
    intent: 'open-focus-tools',
    rawIntent: 'open-focus-tools',
    widgetGateEntryId: null,
    ...input,
  };
}

describe('resolveWorkspaceStartupEntryIntentAction', () => {
  it('routes widget gate mutations to the mutation action', () => {
    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: 'mark-gate-read',
      rawIntent: 'mark-gate-read',
      widgetGateEntryId: 'entry-1',
    }), { blackBoxEnabled: true })).toEqual({ kind: 'widget-gate-mutation' });

    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: 'mark-gate-complete',
      rawIntent: 'mark-gate-complete',
      widgetGateEntryId: 'entry-1',
    }), { blackBoxEnabled: true })).toEqual({ kind: 'widget-gate-mutation' });
  });

  it('opens sidebar tools and gates blackbox recorder loading by preference', () => {
    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: 'open-focus-tools',
      rawIntent: 'open-focus-tools',
    }), { blackBoxEnabled: true })).toEqual({
      kind: 'open-sidebar-tools',
      loadBlackBoxRecorder: false,
    });

    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), { blackBoxEnabled: true })).toEqual({
      kind: 'open-sidebar-tools',
      loadBlackBoxRecorder: true,
    });

    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), { blackBoxEnabled: false })).toEqual({
      kind: 'open-sidebar-tools',
      loadBlackBoxRecorder: false,
    });
  });

  it('ignores workspace-only or empty startup intents', () => {
    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    }), { blackBoxEnabled: true })).toEqual({ kind: 'none' });

    expect(resolveWorkspaceStartupEntryIntentAction(startupIntent({
      intent: null,
      rawIntent: null,
    }), { blackBoxEnabled: true })).toEqual({ kind: 'none' });
  });
});
