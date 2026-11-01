import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ActivatedRoute, Router } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { HandoffResult } from '../../../services/handoff-coordinator.service';
import {
  ProjectShellRouteStateController,
  type ProjectShellRouteStateControllerOptions,
} from './project-shell-route-state.controller';

interface ControllerInput {
  currentUrl?: string;
  handoffResult?: HandoffResult;
  isMobile?: boolean;
  projectId?: string;
  snapshotHandoffEnabled?: boolean;
  startupLaunchSnapshot?: ProjectShellRouteStateControllerOptions['startupLaunchSnapshot'];
  taskId?: string;
}

function createController(input: ControllerInput = {}) {
  return new ProjectShellRouteStateController({
    handoffCoordinator: {
      result: () => input.handoffResult ?? { kind: 'full', degradeReason: null },
    } as ProjectShellRouteStateControllerOptions['handoffCoordinator'],
    isMobile: () => input.isMobile ?? false,
    route: {
      snapshot: {
        params: { projectId: input.projectId },
        firstChild: input.taskId ? { params: { taskId: input.taskId } } : null,
      },
    } as unknown as ActivatedRoute,
    router: {
      url: input.currentUrl ?? '/projects/project-1',
    } as Router,
    snapshotHandoffEnabled: input.snapshotHandoffEnabled ?? true,
    startupLaunchSnapshot: input.startupLaunchSnapshot ?? null,
  });
}

describe('ProjectShellRouteStateController', () => {
  it('resolves the current route and consumes handoff degradation once', () => {
    const controller = createController({
      currentUrl: '/projects/project-1/flow',
      handoffResult: { kind: 'degraded-to-text', degradeReason: 'mobile' },
      projectId: 'project-1',
      taskId: 'task-1',
    });

    const first = controller.resolveRouteChangeState();

    expect(first).toMatchObject({
      currentUrl: '/projects/project-1/flow',
      degradeMobileStartupRoute: true,
      projectId: 'project-1',
      startupEntryIntent: null,
      taskId: 'task-1',
    });

    controller.markStartupRouteDecisionResolved();

    expect(
      controller.resolveRouteChangeState().degradeMobileStartupRoute,
    ).toBe(false);
  });

  it('degrades a matching mobile launch snapshot but not a mismatched snapshot', () => {
    const matching = createController({
      currentUrl: '/projects/project-1/flow',
      projectId: 'project-1',
      startupLaunchSnapshot: {
        routeIntent: { kind: 'flow', projectId: 'project-1' } as never,
        mobileDegraded: true,
        degradeReason: 'mobile-default-text',
      },
    });
    const mismatched = createController({
      currentUrl: '/projects/project-2/flow',
      projectId: 'project-2',
      startupLaunchSnapshot: {
        routeIntent: { kind: 'flow', projectId: 'project-1' } as never,
        mobileDegraded: true,
        degradeReason: 'mobile-default-text',
      },
    });

    expect(matching.resolveRouteChangeState().degradeMobileStartupRoute).toBe(true);
    expect(mismatched.resolveRouteChangeState().degradeMobileStartupRoute).toBe(false);
  });

  it('does not degrade explicit startup entry routes or disabled handoff routes', () => {
    const explicitEntry = createController({
      currentUrl: '/projects/project-1/flow?entry=shortcut&intent=open-workspace',
      handoffResult: { kind: 'degraded-to-text', degradeReason: 'mobile' },
      projectId: 'project-1',
    });
    const disabled = createController({
      currentUrl: '/projects/project-1/flow',
      handoffResult: { kind: 'degraded-to-text', degradeReason: 'mobile' },
      projectId: 'project-1',
      snapshotHandoffEnabled: false,
    });

    expect(explicitEntry.resolveRouteChangeState().startupEntryIntent).not.toBeNull();
    expect(explicitEntry.resolveRouteChangeState().degradeMobileStartupRoute).toBe(false);
    expect(disabled.resolveRouteChangeState().degradeMobileStartupRoute).toBe(false);
  });

  it('keeps startup route parsing outside ProjectShellRouteController', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell-route.controller.ts'),
      'utf8',
    );

    expect(source).toContain('ProjectShellRouteStateController');
    expect(source).not.toContain('resolveStartupEntryIntent');
    expect(source).not.toContain('shouldDegradeMobileStartupRoute');
    expect(source).not.toContain('matchesStartupSnapshotIntent(');
  });
});
