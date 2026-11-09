import { describe, expect, it, vi } from 'vitest';

import {
  ProjectShellFlowIntentController,
} from './project-shell-flow-intent.controller';

describe('ProjectShellFlowIntentController', () => {
  it('starts ready when intent lazy loading is disabled', () => {
    const onActivated = vi.fn();
    const controller = new ProjectShellFlowIntentController({
      enabled: false,
      onActivated,
    });

    expect(controller.flowIntentActivated()).toBe(true);
    expect(controller.shouldLoadFlowNow()).toBe(true);
    expect(controller.shouldPrefetchFlowChunk()).toBe(true);

    controller.activate('click');

    expect(onActivated).not.toHaveBeenCalled();
  });

  it('supports prefetching without mounting Flow', () => {
    const controller = new ProjectShellFlowIntentController({
      enabled: true,
      onActivated: vi.fn(),
    });

    controller.flowPrefetchOnlyActivated.set(true);

    expect(controller.flowIntentActivated()).toBe(false);
    expect(controller.shouldLoadFlowNow()).toBe(false);
    expect(controller.shouldPrefetchFlowChunk()).toBe(true);
  });

  it('activates Flow once and clears prefetch-only state', () => {
    const onActivated = vi.fn();
    const controller = new ProjectShellFlowIntentController({
      enabled: true,
      onActivated,
    });
    controller.flowPrefetchOnlyActivated.set(true);

    controller.activate('route');
    controller.activate('click');

    expect(controller.flowIntentActivated()).toBe(true);
    expect(controller.flowPrefetchOnlyActivated()).toBe(false);
    expect(controller.shouldLoadFlowNow()).toBe(true);
    expect(controller.shouldPrefetchFlowChunk()).toBe(true);
    expect(onActivated).toHaveBeenCalledOnce();
    expect(onActivated).toHaveBeenCalledWith('route');
  });
});
