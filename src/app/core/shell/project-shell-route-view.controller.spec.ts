import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ProjectShellRouteState } from './project-shell-route-state.controller';
import {
  ProjectShellRouteViewController,
} from './project-shell-route-view.controller';

function createContext(options: {
  activeProjectId?: string | null;
  degradeReason?: 'mobile-default-text' | 'mobile' | null;
} = {}) {
  const applyStateAwareFlowRestore = vi.fn();
  const cancelFlowStateAwareTimers = vi.fn();
  const setActiveView = vi.fn();
  const activateFlowIntent = vi.fn();
  const switchActiveProject = vi.fn();
  const toastInfo = vi.fn();
  const controller = new ProjectShellRouteViewController({
    activateFlowIntent,
    flowRestore: {
      applyStateAwareFlowRestore,
      cancelFlowStateAwareTimers,
      setActiveView,
    },
    projectState: {
      activeProjectId: () => options.activeProjectId ?? null,
      projects: () => [{ id: 'fallback-project' }],
    },
    startupLaunchSnapshot: {
      degradeReason: options.degradeReason ?? null,
    },
    toast: { info: toastInfo },
    userSession: { switchActiveProject },
  });

  return {
    activateFlowIntent,
    applyStateAwareFlowRestore,
    cancelFlowStateAwareTimers,
    controller,
    setActiveView,
    switchActiveProject,
    toastInfo,
  };
}

function createRouteState(
  overrides: Partial<ProjectShellRouteState> = {},
): ProjectShellRouteState {
  return {
    currentUrl: '/projects/project-1',
    degradeMobileStartupRoute: false,
    handoffResult: { kind: 'full', degradeReason: null },
    projectId: 'project-1',
    startupEntryIntent: null,
    ...overrides,
  };
}

describe('ProjectShellRouteViewController', () => {
  it('applies degraded startup view and selects a fallback project when required', () => {
    const context = createContext({ degradeReason: 'mobile-default-text' });

    context.controller.applyResolvedRouteView(createRouteState({
      degradeMobileStartupRoute: true,
      handoffResult: { kind: 'degraded-to-project', degradeReason: 'mobile' },
    }), null);

    expect(context.cancelFlowStateAwareTimers).toHaveBeenCalledOnce();
    expect(context.setActiveView).toHaveBeenCalledWith('text');
    expect(context.toastInfo).toHaveBeenCalledWith(
      '已切换到文本视图',
      '手机端启动默认进入文本视图，可稍后手动切换流程图',
    );
    expect(context.switchActiveProject).toHaveBeenCalledWith('fallback-project');
  });

  it('opens Flow routes with the correct route or deeplink intent source', () => {
    const route = createContext();
    const deepLink = createContext();

    route.controller.applyResolvedRouteView(createRouteState({
      currentUrl: '/projects/project-1/flow',
    }), null);
    deepLink.controller.applyResolvedRouteView(createRouteState({
      currentUrl: '/projects/project-1/task/task-1',
      taskId: 'task-1',
    }), 'flow');

    expect(route.activateFlowIntent).toHaveBeenCalledWith('route');
    expect(route.setActiveView).toHaveBeenCalledWith('flow');
    expect(deepLink.activateFlowIntent).toHaveBeenCalledWith('deeplink');
    expect(deepLink.setActiveView).toHaveBeenCalledWith('flow');
  });

  it('leaves pending and workspace deep links for their controller to resolve', () => {
    const pending = createContext();
    const workspace = createContext();

    pending.controller.applyResolvedRouteView(createRouteState(), 'pending');
    workspace.controller.applyResolvedRouteView(createRouteState(), 'workspace');

    expect(pending.setActiveView).not.toHaveBeenCalled();
    expect(pending.applyStateAwareFlowRestore).not.toHaveBeenCalled();
    expect(workspace.setActiveView).not.toHaveBeenCalled();
    expect(workspace.applyStateAwareFlowRestore).not.toHaveBeenCalled();
  });

  it('applies explicit Text routes and delegates neutral routes to state-aware restore', () => {
    const text = createContext();
    const neutral = createContext();

    text.controller.applyResolvedRouteView(createRouteState({
      currentUrl: '/projects/project-1/text',
    }), null);
    neutral.controller.applyResolvedRouteView(createRouteState(), null);

    expect(text.cancelFlowStateAwareTimers).toHaveBeenCalledOnce();
    expect(text.setActiveView).toHaveBeenCalledWith('text');
    expect(neutral.applyStateAwareFlowRestore).toHaveBeenCalledWith(
      '/projects/project-1',
      'project-1',
    );
  });

  it('keeps route view application outside ProjectShellRouteController', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell-route.controller.ts'),
      'utf8',
    );

    expect(source).toContain('ProjectShellRouteViewController');
    expect(source).not.toContain('applyDegradedStartupRoute(');
    expect(source).not.toContain('applyFlowRouteView(');
    expect(source).not.toContain('resolveStartupDegradeMessage(');
    expect(source).not.toContain('switchToFallbackProjectIfNeeded(');
  });
});
