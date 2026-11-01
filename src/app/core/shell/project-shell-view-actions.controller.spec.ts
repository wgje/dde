import { describe, expect, it, vi } from 'vitest';

import {
  ProjectShellViewActionsController,
} from './project-shell-view-actions.controller';

function createController(options: { isMobile?: boolean } = {}) {
  const cancelFlowStateAwareTimers = vi.fn();
  const activateFlowIntent = vi.fn();
  const setActiveView = vi.fn();
  const centerOnNode = vi.fn();
  const retryDiagram = vi.fn();
  const debug = vi.fn();
  const controller = new ProjectShellViewActionsController({
    activateFlowIntent,
    flowCommand: {
      centerOnNode,
      retryDiagram,
    },
    isMobile: () => options.isMobile ?? false,
    logger: { debug },
    routeController: {
      cancelFlowStateAwareTimers,
      setActiveView,
    },
  });

  return {
    activateFlowIntent,
    cancelFlowStateAwareTimers,
    centerOnNode,
    controller,
    debug,
    retryDiagram,
    setActiveView,
  };
}

describe('ProjectShellViewActionsController', () => {
  it('switches between Flow and Text while cancelling pending restore timers', () => {
    const context = createController();

    context.controller.switchToFlow();
    context.controller.switchToText();

    expect(context.cancelFlowStateAwareTimers).toHaveBeenCalledTimes(2);
    expect(context.activateFlowIntent).toHaveBeenCalledOnce();
    expect(context.activateFlowIntent).toHaveBeenCalledWith('click');
    expect(context.setActiveView.mock.calls).toEqual([['flow'], ['text']]);
    expect(context.debug).toHaveBeenCalledWith('switchToText 被调用');
  });

  it('focuses Flow nodes only on desktop', () => {
    const desktop = createController();
    const mobile = createController({ isMobile: true });

    desktop.controller.focusFlowNode('task-1');
    mobile.controller.focusFlowNode('task-2');

    expect(desktop.activateFlowIntent).toHaveBeenCalledWith('click');
    expect(desktop.centerOnNode).toHaveBeenCalledWith('task-1', false);
    expect(mobile.activateFlowIntent).not.toHaveBeenCalled();
    expect(mobile.centerOnNode).not.toHaveBeenCalled();
  });

  it('coordinates Text and Flow error recovery commands', () => {
    const context = createController();

    context.controller.retryTextView();
    context.controller.retryFlowView();

    expect(context.setActiveView.mock.calls).toEqual([['text'], ['flow']]);
    expect(context.activateFlowIntent).toHaveBeenCalledWith('click');
    expect(context.retryDiagram).toHaveBeenCalledOnce();
  });
});
