import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import type { GoJSDiagramData } from './flow-diagram-config.service';
import { applyDiagramData, collectCurrentDiagramMaps } from './flow-diagram-data-merge.helpers';

const go = createRequire(import.meta.url)('gojs/release/go.js') as typeof import('gojs');

interface Harness {
  diagram: import('gojs').Diagram;
  model: import('gojs').GraphLinksModel;
  data: GoJSDiagramData;
}

interface BoundarySnapshot {
  json: string;
  isEnabled: boolean;
  maxHistoryLength: number;
  historyCount: number;
  historyIndex: number;
  transactionLevel: number;
  currentTransaction: import('gojs').Transaction | null;
  diagramSkipsUndoManager: boolean;
  modelSkipsUndoManager: boolean;
}

type MutationStage = 'node merge' | 'link merge' | 'stale node removal' | 'stale link removal';

function createHarness(movedEndpoint = false): Harness {
  const model = new go.GraphLinksModel(
    [
      { key: 'a', title: 'old-a', loc: '0 0' },
      { key: 'b', title: 'old-b', loc: '10 10' },
      { key: 'stale-node', title: 'stale', loc: '20 20' },
    ],
    [
      {
        key: 'main',
        from: 'a',
        to: 'b',
        category: '',
        curviness: 20,
        points: [0, 0, 5, 5, 10, 10],
        title: 'old-link',
      },
      { key: 'stale-link', from: 'a', to: 'b', title: 'stale' },
    ],
  );
  model.linkKeyProperty = 'key';
  const diagram = {
    model,
    skipsUndoManager: false,
    startTransaction: model.startTransaction.bind(model),
    commitTransaction: model.commitTransaction.bind(model),
  } as unknown as import('gojs').Diagram;
  model.undoManager.isEnabled = false;

  return {
    diagram,
    model,
    data: {
      nodeDataArray: [
        { key: 'a', title: 'new-a', loc: movedEndpoint ? '1 1' : '0 0' },
        { key: 'b', title: 'new-b', loc: '10 10' },
      ],
      linkDataArray: [
        {
          key: 'main',
          from: 'a',
          to: 'b',
          category: '',
          curviness: 20,
          isCrossTree: false,
          title: 'new-link',
        },
      ],
    } as GoJSDiagramData,
  };
}

function snapshotBoundary({ diagram, model }: Harness): BoundarySnapshot {
  const undoManager = model.undoManager;
  return {
    json: model.toJson(),
    isEnabled: undoManager.isEnabled,
    maxHistoryLength: undoManager.maxHistoryLength,
    historyCount: undoManager.history.count,
    historyIndex: undoManager.historyIndex,
    transactionLevel: undoManager.transactionLevel,
    currentTransaction: undoManager.currentTransaction,
    diagramSkipsUndoManager: diagram.skipsUndoManager,
    modelSkipsUndoManager: model.skipsUndoManager,
  };
}

function expectBoundary(harness: Harness, expected: BoundarySnapshot): void {
  const actual = snapshotBoundary(harness);
  expect(actual.json).toBe(expected.json);
  expect(actual.isEnabled).toBe(expected.isEnabled);
  expect(actual.maxHistoryLength).toBe(expected.maxHistoryLength);
  expect(actual.historyCount).toBe(expected.historyCount);
  expect(actual.historyIndex).toBe(expected.historyIndex);
  expect(actual.transactionLevel).toBe(expected.transactionLevel);
  expect(actual.currentTransaction).toBe(expected.currentTransaction);
  expect(actual.diagramSkipsUndoManager).toBe(expected.diagramSkipsUndoManager);
  expect(actual.modelSkipsUndoManager).toBe(expected.modelSkipsUndoManager);
}

function apply(harness: Harness): void {
  applyDiagramData(
    harness.diagram,
    harness.model,
    harness.data,
    collectCurrentDiagramMaps(harness.model),
  );
}

function armStageFailure(
  model: import('gojs').GraphLinksModel,
  stage: MutationStage,
  sentinel: Error,
): void {
  if (stage === 'node merge') {
    const mutate = model.mergeNodeDataArray.bind(model);
    model.mergeNodeDataArray = data => {
      mutate(data);
      throw sentinel;
    };
    return;
  }
  if (stage === 'link merge') {
    const mutate = model.mergeLinkDataArray.bind(model);
    model.mergeLinkDataArray = data => {
      mutate(data);
      throw sentinel;
    };
    return;
  }
  if (stage === 'stale node removal') {
    const mutate = model.removeNodeData.bind(model);
    model.removeNodeData = data => {
      mutate(data);
      throw sentinel;
    };
    return;
  }
  const mutate = model.removeLinkData.bind(model);
  model.removeLinkData = data => {
    mutate(data);
    throw sentinel;
  };
}

describe('flow diagram data merge transaction', () => {
  it('uses the pinned real GoJS runtime', () => {
    expect((go as unknown as { version: string }).version).toBe('3.1.10');
  });

  it.each([
    { movedEndpoint: false, expectedPoints: [0, 0, 5, 5, 10, 10] },
    { movedEndpoint: true, expectedPoints: undefined },
  ])('commits the exact poststate when movedEndpoint=$movedEndpoint', ({ movedEndpoint, expectedPoints }) => {
    const harness = createHarness(movedEndpoint);
    apply(harness);
    expect(harness.model.nodeDataArray).toEqual([
      { key: 'a', title: 'new-a', loc: movedEndpoint ? '1 1' : '0 0' },
      { key: 'b', title: 'new-b', loc: '10 10' },
    ]);
    expect(harness.model.linkDataArray).toEqual([
      {
        key: 'main',
        from: 'a',
        to: 'b',
        category: '',
        curviness: 20,
        points: expectedPoints,
        title: 'new-link',
        isCrossTree: false,
        fromPortId: '',
        toPortId: '',
      },
    ]);
    expectBoundary(harness, {
      ...snapshotBoundary(harness),
      historyCount: 0,
      historyIndex: -1,
      transactionLevel: 0,
      currentTransaction: null,
      isEnabled: false,
      maxHistoryLength: 999,
      diagramSkipsUndoManager: false,
      modelSkipsUndoManager: false,
    });
  });

  it.each<MutationStage>([
    'node merge',
    'link merge',
    'stale node removal',
    'stale link removal',
  ])('rolls back exact model bytes after a throw following %s', stage => {
    const harness = createHarness(true);
    const expected = snapshotBoundary(harness);
    const sentinel = new Error(`sentinel:${stage}`);
    armStageFailure(harness.model, stage, sentinel);

    let thrown: unknown;
    try {
      apply(harness);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expectBoundary(harness, expected);
  });

  const denialCases: Array<{
    name: string;
    arrange: (harness: Harness) => void;
  }> = [
    {
      name: 'diagram model mismatch',
      arrange: harness => {
        harness.diagram.model = new go.GraphLinksModel();
      },
    },
    {
      name: 'enabled undo manager',
      arrange: harness => {
        harness.model.undoManager.isEnabled = true;
      },
    },
    {
      name: 'existing history',
      arrange: harness => {
        const manager = harness.model.undoManager;
        manager.isEnabled = true;
        harness.model.commit(model => model.setDataProperty(model.nodeDataArray[0], 'title', 'seed'), 'seed');
        manager.isEnabled = false;
      },
    },
    {
      name: 'active empty transaction',
      arrange: harness => {
        harness.model.startTransaction('outer');
      },
    },
    {
      name: 'active recorded transaction',
      arrange: harness => {
        const manager = harness.model.undoManager;
        manager.isEnabled = true;
        harness.model.startTransaction('outer');
        harness.model.setDataProperty(harness.model.nodeDataArray[0], 'title', 'pending');
        manager.isEnabled = false;
      },
    },
    {
      name: 'diagram skip flag',
      arrange: harness => {
        harness.diagram.skipsUndoManager = true;
      },
    },
    {
      name: 'model skip flag',
      arrange: harness => {
        harness.model.skipsUndoManager = true;
      },
    },
  ];

  it.each(denialCases)('denies $name with zero effects', ({ arrange }) => {
    const harness = createHarness();
    arrange(harness);
    const expected = snapshotBoundary(harness);
    expect(() => apply(harness)).toThrow();
    expectBoundary(harness, expected);
  });
});
