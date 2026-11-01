import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import type { Project, ViewState } from '../../../../models';
import type { ActiveProjectOwner } from '../../../../services/project-state.service';
import { FlowDiagramViewportReadinessController } from './flow-diagram-viewport-readiness.controller';
import type { FlowViewportOwner } from './flow-zoom.service';

type TestDiagram = go.Diagram & {
  emitLayoutCompleted(): void;
  layoutListenerCount(): number;
};

function createDiagram(): TestDiagram {
  const listeners = new Set<(event: go.DiagramEvent) => void>();
  const diagram = {
    scale: 1,
    position: new go.Point(0, 0),
    documentBounds: new go.Rect(0, 0, 300, 200),
    viewportBounds: new go.Rect(0, 0, 600, 400),
    addDiagramListener: vi.fn((name: string, listener: (event: go.DiagramEvent) => void) => {
      if (name === 'LayoutCompleted') listeners.add(listener);
    }),
    removeDiagramListener: vi.fn((name: string, listener: (event: go.DiagramEvent) => void) => {
      if (name === 'LayoutCompleted') listeners.delete(listener);
    }),
    emitLayoutCompleted: () => {
      for (const listener of [...listeners]) listener({ diagram } as unknown as go.DiagramEvent);
    },
    layoutListenerCount: () => listeners.size,
  };
  return diagram as unknown as TestDiagram;
}

function createProject(id: string, viewState?: ViewState): Project {
  return {
    id,
    name: id,
    description: '',
    createdDate: '2026-08-02T00:00:00.000Z',
    tasks: [],
    connections: [],
    viewState,
  };
}

function installRafQueue(): FrameRequestCallback[] {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return callbacks;
}

function createHarness() {
  let projectId: string | null = 'project-a';
  let ownerGeneration = 1;
  const readyOwners: ActiveProjectOwner[] = [];
  const fitToContents = vi.fn((owner: FlowViewportOwner) => {
    const diagram = owner.diagram;
    const documentBounds = diagram.documentBounds;
    const viewportBounds = diagram.viewportBounds;
    const scale = Math.max(0.3, Math.min(1.5, Math.min(
      viewportBounds.width / (documentBounds.width + 100),
      viewportBounds.height / (documentBounds.height + 100),
    )));
    const width = viewportBounds.width / scale;
    const height = viewportBounds.height / scale;
    const center = documentBounds.center;
    const fittedViewport = new go.Rect(center.x - width / 2, center.y - height / 2, width, height);
    diagram.scale = scale;
    diagram.position = new go.Point(fittedViewport.x, fittedViewport.y);
    (diagram as unknown as { viewportBounds: go.Rect }).viewportBounds = fittedViewport;
  });
  const markViewDestroyed = vi.fn();
  const captureOwner = (): ActiveProjectOwner => ({ projectId, generation: ownerGeneration });
  const isOwnerCurrent = (owner: ActiveProjectOwner): boolean => (
    owner.projectId === projectId && owner.generation === ownerGeneration
  );
  const controller = new FlowDiagramViewportReadinessController({
    activeView: () => 'flow',
    captureActiveProjectOwner: captureOwner,
    isActiveProjectOwnerCurrent: isOwnerCurrent,
    fitToContents,
    markViewDestroyed,
    markViewReady: owner => readyOwners.push(owner),
    markLocalChanges: vi.fn(),
    schedulePersist: vi.fn(),
    updateViewState: vi.fn(),
  });
  const switchProject = (nextProjectId: string): void => {
    ownerGeneration += 1;
    projectId = nextProjectId;
  };
  return {
    controller,
    fitToContents,
    markViewDestroyed,
    readyOwners,
    switchProject,
  };
}

describe('FlowDiagramViewportReadinessController', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('publishes only after an early LayoutCompleted is followed by data commit and positive bounds', () => {
    const rafCallbacks = installRafQueue();
    const harness = createHarness();
    const diagram = createDiagram();
    const project = createProject('project-a', { scale: 1.5, positionX: 30, positionY: 40 });
    harness.controller.setDiagram(diagram);

    const token = harness.controller.beginProjectUpdate(project, project.viewState ?? null);
    expect(token).not.toBeNull();
    if (!token) throw new Error('expected readiness token');
    expect(diagram.layoutListenerCount()).toBe(1);
    diagram.emitLayoutCompleted();
    expect(harness.readyOwners).toEqual([]);

    expect(harness.controller.commitProjectUpdate(token)).toBe(true);

    expect({ scale: diagram.scale, x: diagram.position.x, y: diagram.position.y })
      .toEqual({ scale: 1.5, x: 30, y: 40 });
    expect(harness.readyOwners).toEqual([]);
    rafCallbacks.shift()?.(0);
    expect(harness.readyOwners).toEqual([{ projectId: 'project-a', generation: 1 }]);
    expect(diagram.layoutListenerCount()).toBe(0);
  });

  it('supersedes an unsettled same-project update without losing readiness', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();

    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();
    diagram.emitLayoutCompleted();

    expect(harness.readyOwners).toEqual([{ projectId: 'project-a', generation: 1 }]);
    expect(diagram.layoutListenerCount()).toBe(0);
  });

  it('rejects an explicit commit after its exact boundary was aborted', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    harness.controller.setDiagram(diagram);
    const token = harness.controller.beginProjectUpdate(createProject('project-a'), null);
    expect(token).not.toBeNull();
    if (!token) throw new Error('expected readiness token');

    expect(harness.controller.abortProjectUpdate(token)).toBe(true);
    expect(harness.controller.commitProjectUpdate(token)).toBe(false);
    expect(harness.readyOwners).toEqual([]);
  });

  it('rejects viewport state overwritten before the post-render readback', () => {
    const rafCallbacks = installRafQueue();
    const harness = createHarness();
    const diagram = createDiagram();
    const state = { scale: 1.5, positionX: 30, positionY: 40 };
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a', state), state);
    harness.controller.commitProjectUpdate();
    diagram.emitLayoutCompleted();

    diagram.position = new go.Point(300, 400);
    rafCallbacks.shift()?.(0);

    expect(harness.readyOwners).toEqual([]);
  });

  it('keeps settlement pending until both document and viewport bounds are usable', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();
    (diagram as unknown as { documentBounds: go.Rect }).documentBounds = new go.Rect(0, 0, 0, 0);

    diagram.emitLayoutCompleted();
    expect(harness.fitToContents).not.toHaveBeenCalled();
    expect(harness.readyOwners).toEqual([]);

    (diagram as unknown as { documentBounds: go.Rect }).documentBounds = new go.Rect(0, 0, 300, 200);
    diagram.emitLayoutCompleted();
    expect(harness.fitToContents).toHaveBeenCalledOnce();
    expect(harness.readyOwners).toHaveLength(1);
  });

  it('rejects a no-op fit that leaves the document off center', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    diagram.scale = 4 / 3;
    harness.fitToContents.mockImplementationOnce(() => undefined);
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();

    diagram.emitLayoutCompleted();

    expect(harness.readyOwners).toEqual([]);
  });

  it('rejects a centered fit that leaves the scale incorrect', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    harness.fitToContents.mockImplementationOnce(owner => {
      const documentCenter = owner.diagram.documentBounds.center;
      const viewportBounds = owner.diagram.viewportBounds;
      const centered = new go.Rect(
        documentCenter.x - viewportBounds.width / 2,
        documentCenter.y - viewportBounds.height / 2,
        viewportBounds.width,
        viewportBounds.height,
      );
      owner.diagram.position = new go.Point(centered.x, centered.y);
      (owner.diagram as unknown as { viewportBounds: go.Rect }).viewportBounds = centered;
    });
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();

    diagram.emitLayoutCompleted();

    expect(diagram.documentBounds.center).toEqual(diagram.viewportBounds.center);
    expect(harness.readyOwners).toEqual([]);
  });

  it('rejects stale settlement after A to B to A owner rebinding', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();

    harness.switchProject('project-b');
    harness.switchProject('project-a');
    diagram.emitLayoutCompleted();

    expect(harness.readyOwners).toEqual([]);
    expect(harness.fitToContents).not.toHaveBeenCalled();
  });

  it('retains a hard-recovery viewport request until layout and bounds are usable', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    const state = { scale: 1.25, positionX: 12, positionY: 24 };
    expect(harness.controller.beginHardRecovery()).toBe(true);
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a', state), state);
    harness.controller.commitProjectUpdate();

    const complete = vi.fn();
    expect(harness.controller.applyHardRecoveryViewport(state, complete)).toBe(true);
    (diagram as unknown as { documentBounds: go.Rect }).documentBounds = new go.Rect(0, 0, 0, 0);
    diagram.emitLayoutCompleted();
    expect(complete).not.toHaveBeenCalled();
    expect(harness.controller.completeHardRecovery(null)).toBe(false);
    expect(harness.readyOwners).toEqual([]);

    (diagram as unknown as { documentBounds: go.Rect }).documentBounds = new go.Rect(0, 0, 300, 200);
    diagram.emitLayoutCompleted();
    expect(complete).toHaveBeenCalledOnce();
    const proof = complete.mock.calls[0]?.[0] ?? null;
    expect(proof).toMatchObject({
      kind: 'VIEW_STATE_APPLIED',
      before: { documentWidth: 300, documentHeight: 200, viewportWidth: 600, viewportHeight: 400 },
      after: { documentWidth: 300, documentHeight: 200, viewportWidth: 600, viewportHeight: 400 },
    });
    expect(harness.controller.completeHardRecovery(proof)).toBe(true);
    expect(harness.readyOwners).toEqual([{ projectId: 'project-a', generation: 1 }]);
  });

  it('binds hard-recovery proof to the exact diagram and settlement generations', () => {
    const harness = createHarness();
    const first = createDiagram();
    harness.controller.beginHardRecovery();
    harness.controller.setDiagram(first);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();
    first.emitLayoutCompleted();
    const captured: { proof: Parameters<typeof harness.controller.completeHardRecovery>[0] } = { proof: null };
    harness.controller.applyHardRecoveryViewport(null, value => { captured.proof = value; });

    harness.controller.setDiagram(createDiagram());

    expect(captured.proof?.kind).toBe('FIT_TO_CONTENTS_APPLIED');
    expect(harness.controller.completeHardRecovery(captured.proof)).toBe(false);
    expect(harness.readyOwners).toEqual([]);
  });

  it('resolves a queued hard-recovery request once when recovery is aborted before layout', () => {
    const harness = createHarness();
    const diagram = createDiagram();
    const complete = vi.fn();
    harness.controller.beginHardRecovery();
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();

    expect(harness.controller.applyHardRecoveryViewport(null, complete)).toBe(true);
    harness.controller.abortHardRecovery();

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(null);
    diagram.emitLayoutCompleted();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('resolves an in-flight hard-recovery proof as null when it is cancelled', () => {
    const callbacks = installRafQueue();
    const harness = createHarness();
    const diagram = createDiagram();
    const complete = vi.fn();
    harness.controller.beginHardRecovery();
    harness.controller.setDiagram(diagram);
    harness.controller.beginProjectUpdate(createProject('project-a'), null);
    harness.controller.commitProjectUpdate();
    diagram.emitLayoutCompleted();
    harness.controller.applyHardRecoveryViewport(null, complete);

    harness.controller.abortHardRecovery();

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(null);
    callbacks.shift()?.(0);
    expect(complete).toHaveBeenCalledOnce();
  });
});
