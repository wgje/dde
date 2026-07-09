import { describe, expect, it } from 'vitest';

import { buildFlowDragGhostContent } from './flow-drag-ghost-content';

describe('buildFlowDragGhostContent', () => {
  it('builds ghost content with a count badge and suffix using DOM nodes', () => {
    const container = document.createElement('div');

    buildFlowDragGhostContent(container, 'Task title', 3, 'Drop here');

    expect(container.textContent).toBe('⏸ Task title +2Drop here');
    expect(container.querySelector('.opacity-60')?.textContent).toBe('⏸');
    expect(container.querySelector('.bg-indigo-400\\/50')?.textContent).toBe('+2');
    expect(container.querySelector('.ml-1')?.textContent).toBe('Drop here');
  });

  it('omits optional badge and suffix for a single task', () => {
    const container = document.createElement('div');

    buildFlowDragGhostContent(container, 'Solo task', 1);

    expect(container.textContent).toBe('⏸ Solo task');
    expect(container.querySelector('.bg-indigo-400\\/50')).toBeNull();
    expect(container.querySelector('.ml-1')).toBeNull();
  });
});
