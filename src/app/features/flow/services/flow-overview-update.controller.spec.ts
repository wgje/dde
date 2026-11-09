import { describe, expect, it, vi } from 'vitest';

import { FlowOverviewUpdateController } from './flow-overview-update.controller';
import type {
  OverviewUpdateSource,
  OverviewViewportContext,
  OverviewWorldBoundsPlan,
} from './flow-overview-viewport.helpers';
import * as go from 'gojs';

describe('FlowOverviewUpdateController', () => {
  it('runs the active overview update pipeline in order', () => {
    const controller = new FlowOverviewUpdateController();
    const context = { id: 'context' } as unknown as OverviewViewportContext;
    const plan = { id: 'plan' } as unknown as OverviewWorldBoundsPlan;
    const calls: string[] = [];

    controller.apply('viewport', {
      createContext: source => {
        calls.push(`context:${source}`);
        return context;
      },
      handlePassiveUpdate: value => {
        calls.push(`passive:${value === context}`);
        return false;
      },
      buildWorldBoundsPlan: value => {
        calls.push(`plan:${value === context}`);
        return plan;
      },
      applyWorldBoundsPlan: value => {
        calls.push(`apply:${value === plan}`);
      },
      finalizeUpdate: value => {
        calls.push(`finalize:${value === context}`);
      },
      clearReleaseViewportIfCaughtUp: value => {
        calls.push(`clear:${value === context}`);
      },
      scheduleUpdate: source => {
        calls.push(`schedule:${source}`);
      },
    });

    expect(calls).toEqual([
      'context:viewport',
      'passive:true',
      'plan:true',
      'apply:true',
      'finalize:true',
      'clear:true',
    ]);
  });

  it('queues one viewport refresh when an update re-enters while applying', () => {
    const controller = new FlowOverviewUpdateController();
    const calls: string[] = [];

    const runtime = {
      createContext: (source: OverviewUpdateSource) => {
        calls.push(`context:${source}`);
        controller.apply('document', runtime);
        return createContext(source);
      },
      handlePassiveUpdate: () => false,
      buildWorldBoundsPlan: () => null,
      applyWorldBoundsPlan: vi.fn(),
      finalizeUpdate: () => {
        calls.push('finalize');
      },
      clearReleaseViewportIfCaughtUp: () => {
        calls.push('clear');
      },
      scheduleUpdate: (source: OverviewUpdateSource) => {
        calls.push(`schedule:${source}`);
      },
    };

    controller.apply('viewport', runtime);

    expect(calls).toEqual([
      'context:viewport',
      'finalize',
      'clear',
      'schedule:viewport',
    ]);
  });

  it('drops queued refresh state when reset during an active update', () => {
    const controller = new FlowOverviewUpdateController();
    const scheduleUpdate = vi.fn();

    const runtime = {
      createContext: (source: OverviewUpdateSource) => {
        controller.apply(source, runtime);
        controller.reset();
        return createContext(source);
      },
      handlePassiveUpdate: () => false,
      buildWorldBoundsPlan: () => null,
      applyWorldBoundsPlan: vi.fn(),
      finalizeUpdate: vi.fn(),
      clearReleaseViewportIfCaughtUp: vi.fn(),
      scheduleUpdate,
    };

    controller.apply('viewport', runtime);

    expect(scheduleUpdate).not.toHaveBeenCalled();
  });
});

function createContext(source: OverviewUpdateSource): OverviewViewportContext {
  return {
    source,
    viewportBounds: new go.Rect(0, 0, 100, 80),
    releaseViewportBounds: null,
    usingFakeViewportBounds: false,
    usingReleaseViewportBounds: false,
    usingManualViewportBounds: false,
    shouldSuppressNextViewportAnchor: false,
    isPassiveObservedViewportUpdate: false,
    viewportIsInsideCurrentOverviewBounds: true,
  };
}
