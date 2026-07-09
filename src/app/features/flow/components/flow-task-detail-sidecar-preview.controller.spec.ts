import { afterEach, describe, expect, it } from 'vitest';

import { FlowTaskDetailSidecarPreviewController } from './flow-task-detail-sidecar-preview.controller';

describe('FlowTaskDetailSidecarPreviewController', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a fixed sidecar badge preview beside the triggering element', () => {
    const controller = new FlowTaskDetailSidecarPreviewController();
    const target = document.createElement('button');
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => ({ left: 20, right: 60, top: 40, height: 20 }),
    });
    document.body.appendChild(target);

    controller.show({
      currentTarget: target,
      target,
    } as unknown as Event, {
      id: 'risk',
      label: '风险1',
      tone: 'risk',
      tooltipText: '需要联调',
    });

    const preview = document.body.querySelector<HTMLElement>('[data-testid="flow-task-sidecar-badge-preview"]');
    expect(preview).toBeTruthy();
    expect(preview?.textContent).toContain('风险1');
    expect(preview?.textContent).toContain('需要联调');
    expect(preview?.style.position).toBe('fixed');
    expect(preview?.style.visibility).toBe('visible');
  });

  it('removes the preview on hide', () => {
    const controller = new FlowTaskDetailSidecarPreviewController();
    const target = document.createElement('button');
    document.body.appendChild(target);

    controller.show({
      currentTarget: target,
      target,
    } as unknown as Event, {
      id: 'wait',
      label: '等待',
      tone: 'wait',
    });
    controller.hide();

    expect(document.body.querySelector('[data-testid="flow-task-sidecar-badge-preview"]')).toBeNull();
  });
});
