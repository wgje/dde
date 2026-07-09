import { describe, expect, it } from 'vitest';

import { FlowDiagramSidecarExpansionController } from './flow-diagram-sidecar-expansion.controller';

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('FlowDiagramSidecarExpansionController', () => {
  it('loads project task ids and persists sorted toggles', () => {
    const storage = createMemoryStorage({
      'nanoflow.flow-sidecar-expanded.v1.project-1': JSON.stringify(['task-b', '', 'task-a', 'task-b']),
    });
    const controller = new FlowDiagramSidecarExpansionController({
      getStorage: () => storage,
    });

    controller.ensureLoaded('project-1');

    expect([...controller.taskIds]).toEqual(['task-b', 'task-a']);
    expect(controller.toggle('project-1', 'task-c')).toBe(true);
    expect(storage.getItem('nanoflow.flow-sidecar-expanded.v1.project-1')).toBe(
      JSON.stringify(['task-a', 'task-b', 'task-c']),
    );

    expect(controller.toggle('project-1', 'task-b')).toBe(false);
    expect(storage.getItem('nanoflow.flow-sidecar-expanded.v1.project-1')).toBe(
      JSON.stringify(['task-a', 'task-c']),
    );
  });

  it('prunes task ids that no longer have sidecar signals', () => {
    const storage = createMemoryStorage({
      'nanoflow.flow-sidecar-expanded.v1.project-1': JSON.stringify(['live-task', 'stale-task']),
    });
    const controller = new FlowDiagramSidecarExpansionController({
      getStorage: () => storage,
    });

    controller.ensureLoaded('project-1');

    expect(controller.prune([
      { key: 'live-task', sidecarHasSignals: true },
      { key: 'plain-task' },
    ])).toBe(true);
    expect([...controller.taskIds]).toEqual(['live-task']);
    expect(storage.getItem('nanoflow.flow-sidecar-expanded.v1.project-1')).toBe(
      JSON.stringify(['live-task']),
    );

    expect(controller.prune([{ key: 'live-task' }])).toBe(true);
    expect([...controller.taskIds]).toEqual([]);
    expect(storage.getItem('nanoflow.flow-sidecar-expanded.v1.project-1')).toBeNull();
  });

  it('reset forgets the loaded project so a new owner can reload storage', () => {
    const storage = createMemoryStorage({
      'nanoflow.flow-sidecar-expanded.v1.project-1': JSON.stringify(['first-task']),
    });
    const controller = new FlowDiagramSidecarExpansionController({
      getStorage: () => storage,
    });

    controller.ensureLoaded('project-1');
    storage.setItem(
      'nanoflow.flow-sidecar-expanded.v1.project-1',
      JSON.stringify(['second-task']),
    );
    controller.ensureLoaded('project-1');
    expect([...controller.taskIds]).toEqual(['first-task']);

    controller.reset();
    controller.ensureLoaded('project-1');

    expect([...controller.taskIds]).toEqual(['second-task']);
  });
});
